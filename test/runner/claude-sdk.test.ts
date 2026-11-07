import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  ChatModel,
  EnqueueInput,
  FinishOutcome,
  ModelOutput,
  RunQueue,
  Runner,
} from "../../src/contracts/index.js";
import { createRunJournal } from "../../src/journal/index.js";
import { createRunQueue } from "../../src/queue/index.js";
import { ClaudeSdkRunner, type ClaudeSdkClient } from "../../src/runner/claude-sdk.js";
import { resolveModel } from "../../src/routing/resolve.js";
import {
  loadRunnerAgent,
  runWorker,
  type RunnerSelection,
  type WorkerLoopOptions,
} from "../../src/worker.js";
import { sql } from "../helpers/db.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const WORKER_ID = "worker-m3-sdk";
const BOUNDARY_DIRS = ["queue", "api", "telegram"] as const;
const SDK_MARKERS = ["claude-sdk", "claude-agent-sdk", "@anthropic-ai"] as const;

const queue = createRunQueue(sql);
const journal = createRunJournal(sql, []);

const model: ChatModel = {
  complete(): Promise<ModelOutput> {
    return Promise.reject(new Error("model must not be called"));
  },
};

describe("ClaudeSdkRunner", () => {
  it("должен не создавать SDK-раннер, когда resolveModel вернул local", async () => {
    const seen = trackSelection();
    const agent = await loadRunnerAgent(sql, AGENT_ID);
    expect(agent.provider).toBe("local");
    const resolved = await resolveModel(
      sql,
      {
        id: agent.id,
        tenantId: "local",
        modelAlias: agent.modelAlias,
        provider: agent.provider,
      },
      { toolEffects: [] },
    );
    expect(resolved.provider).toBe("local");

    const created = await queue.enqueue(enqueueInput("local-turn"));
    const claims = await drive(seen.selection);

    expect(seen.created()).toBe(0);
    expect(seen.localIds).toEqual([created.run.id]);
    expect(seen.sdkIds).toEqual([]);
    expect(claims.filter((id) => id.length > 0)).toEqual([created.run.id]);

    const row = await storedRun(created.run.id);
    expect(row).toMatchObject({
      status: "succeeded",
      attempt: 1,
      final_text: "локальный ход",
      provider: "local",
    });
  });

  it("должен выбрать вторую реализацию, когда resolveModel вернул external", async () => {
    await sql.file(path.resolve(import.meta.dirname, "../../seed/route_rules.sql"));
    const prior = await queue.enqueue(enqueueInput("prior-parse"));
    const locked = await queue.claimNext(WORKER_ID, 120);
    if (locked === null || locked.id !== prior.run.id) {
      throw new Error("prior claim missed");
    }
    await journal.appendStep({
      runId: prior.run.id,
      kind: "parse_error",
      toolName: null,
      requestExcerpt: null,
      responseExcerpt: null,
      promptTokens: null,
      completionTokens: null,
      error: "empty",
    });
    const closed = await queue.finish(
      prior.run.id,
      WORKER_ID,
      outcome("failed", null, "empty", "local"),
    );
    expect(closed).toBe(true);

    const seen = trackSelection();
    const agent = await loadRunnerAgent(sql, AGENT_ID);
    expect(agent.provider).toBe("local");
    const resolved = await resolveModel(
      sql,
      {
        id: agent.id,
        tenantId: "local",
        modelAlias: agent.modelAlias,
        provider: agent.provider,
      },
      { toolEffects: [] },
    );
    expect(resolved).toEqual({ modelAlias: "coder-cloud", provider: "external" });

    const created = await queue.enqueue(enqueueInput("external-turn"));
    const claims = await drive(seen.selection);

    expect(seen.created()).toBe(1);
    expect(seen.built).toBeInstanceOf(ClaudeSdkRunner);
    expect(seen.sdkIds).toEqual([created.run.id]);
    expect(seen.localIds).toEqual([]);
    expect(claims.filter((id) => id.length > 0)).toEqual([created.run.id]);

    const row = await storedRun(created.run.id);
    expect(row).toMatchObject({
      status: "succeeded",
      attempt: 1,
      final_text: "внешний ход",
      provider: "external",
    });
    const previous = await storedRun(prior.run.id);
    expect(previous.status).toBe("failed");
    expect(previous.attempt).toBe(1);
  });

  it("должен не импортировать модуль ClaudeSdkRunner из очереди, API и Telegram", async () => {
    const sources = await boundarySources();
    const paths = sources.map((item) => item.filePath);
    expect(paths.some((item) => item.endsWith(`${path.sep}queue${path.sep}run-queue.ts`))).toBe(
      true,
    );
    expect(paths.some((item) => item.endsWith(`${path.sep}api${path.sep}app.ts`))).toBe(true);
    expect(paths.some((item) => item.endsWith(`${path.sep}telegram${path.sep}bot.ts`))).toBe(true);
    expect(sources.length).toBeGreaterThanOrEqual(21);

    const offenders: string[] = [];
    for (const item of sources) {
      for (const marker of SDK_MARKERS) {
        if (item.source.includes(marker)) {
          offenders.push(`${item.filePath} ${marker}`);
        }
      }
    }
    expect(offenders).toEqual([]);

    const runnerSource = await readPackageFile("src/runner/claude-sdk.ts");
    const workerSource = await readPackageFile("src/worker.ts");
    expect(runnerSource.includes("@anthropic-ai")).toBe(false);
    expect(runnerSource.includes("claude-agent-sdk")).toBe(false);
    expect(workerSource.includes("@anthropic-ai")).toBe(false);
    expect(workerSource.includes("claude-agent-sdk")).toBe(false);
    expect(workerSource.includes("runner/claude-sdk")).toBe(true);
    expect(workerSource.match(/claimNext\(/g)).toHaveLength(1);
  });
});

interface SelectionTrack {
  selection: RunnerSelection;
  localIds: string[];
  sdkIds: string[];
  built: Runner | undefined;
  created(): number;
}

function trackSelection(): SelectionTrack {
  const localIds: string[] = [];
  const sdkIds: string[] = [];
  let created = 0;
  let built: Runner | undefined;
  const client: ClaudeSdkClient = {
    async run(claimed, ctx) {
      sdkIds.push(claimed.id);
      const wrote = await ctx.finish(
        claimed.id,
        WORKER_ID,
        outcome("succeeded", "внешний ход", null, "external"),
      );
      expect(wrote).toBe(true);
    },
  };
  const local: Runner = {
    async run(claimed, ctx) {
      localIds.push(claimed.id);
      const wrote = await ctx.finish(
        claimed.id,
        WORKER_ID,
        outcome("succeeded", "локальный ход", null, "local"),
      );
      expect(wrote).toBe(true);
    },
  };
  const selection: RunnerSelection = {
    local,
    createExternal(): Runner {
      created += 1;
      built = new ClaudeSdkRunner({ client });
      return built;
    },
    loadAgent(agentId: string) {
      return loadRunnerAgent(sql, agentId);
    },
    sql,
  };
  return {
    selection,
    localIds,
    sdkIds,
    get built() {
      return built;
    },
    created() {
      return created;
    },
  };
}

async function drive(selection: RunnerSelection): Promise<string[]> {
  const claims: string[] = [];
  const controller = new AbortController();
  const options: WorkerLoopOptions = {
    queue: countingQueue(claims),
    runner: {
      run(): Promise<void> {
        return Promise.reject(new Error("fixed runner must not replace selection"));
      },
    },
    selection,
    journal,
    model,
    tools: [],
    workerId: WORKER_ID,
    leaseSeconds: 120,
    heartbeatSeconds: 60,
    signal: controller.signal,
    sleep(): Promise<void> {
      controller.abort();
      return Promise.resolve();
    },
  };
  await runWorker(options);
  return claims;
}

function countingQueue(claims: string[]): RunQueue {
  return {
    enqueue: (input) => queue.enqueue(input),
    async claimNext(workerId, leaseSeconds) {
      const claimed = await queue.claimNext(workerId, leaseSeconds);
      claims.push(claimed === null ? "" : claimed.id);
      return claimed;
    },
    heartbeat: (runId, workerId, leaseSeconds) => queue.heartbeat(runId, workerId, leaseSeconds),
    reapExpired: () => queue.reapExpired(),
    finish: (runId, workerId, outcome) => queue.finish(runId, workerId, outcome),
  };
}

function enqueueInput(idempotencyKey: string): EnqueueInput {
  return {
    tenantId: "local",
    agentId: AGENT_ID,
    source: "api",
    idempotencyKey: `${idempotencyKey}-${randomUUID()}`,
    message: idempotencyKey,
    chatId: null,
  };
}

function outcome(
  status: FinishOutcome["status"],
  finalText: string | null,
  error: string | null,
  provider: "local" | "external",
): FinishOutcome {
  return {
    status,
    finalText,
    error,
    modelAlias: provider === "external" ? "coder-cloud" : "agent",
    provider,
    promptTokens: null,
    completionTokens: null,
  };
}

interface StoredRun {
  status: string;
  attempt: number;
  final_text: string | null;
  provider: string | null;
}

async function storedRun(id: string): Promise<StoredRun> {
  const rows = await sql<StoredRun[]>`
    select status, attempt, final_text, provider
    from runs
    where id = ${id}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("run is missing");
  }
  return row;
}

async function boundarySources(): Promise<{ filePath: string; source: string }[]> {
  const found: { filePath: string; source: string }[] = [];
  for (const name of BOUNDARY_DIRS) {
    const directory = fileURLToPath(new URL(`../../src/${name}`, import.meta.url));
    // Каталоги пакета фиксированы. Путь модели сюда не приходит.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- src/queue, src/api, src/telegram
    const entries = await readdir(directory, { recursive: true, encoding: "utf8" });
    for (const entry of entries) {
      if (!entry.endsWith(".ts")) {
        continue;
      }
      const filePath = path.join(directory, entry);
      found.push({ filePath, source: await readPackageBytes(filePath) });
    }
  }
  return found;
}

async function readPackageFile(relativePath: string): Promise<string> {
  const filePath = fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
  return readPackageBytes(filePath);
}

async function readPackageBytes(filePath: string): Promise<string> {
  // Фиксированные файлы репозитория, не путь из запуска.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- чтение исходников пакета
  return readFile(filePath, "utf8");
}
