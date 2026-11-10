/* Фикстура файла собирается во временном каталоге: литерального пути нет. */
/* eslint-disable security/detect-non-literal-fs-filename -- временный корень приёмки */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { loadConfig } from "../../src/config.js";
import type {
  ChatModel,
  ClaimedRun,
  EnqueueInput,
  EnqueueResult,
  FinishOutcome,
  ModelInput,
  ModelMessage,
  ModelOutput,
  Runner,
  Tool,
} from "../../src/contracts/index.js";
import { type Sql, createSql } from "../../src/db/client.js";
import { createRunJournal } from "../../src/journal/index.js";
import { LiteLLMChatModel } from "../../src/model/index.js";
import { REDACTED, collectSecrets } from "../../src/model/redact.js";
import { createRunQueue } from "../../src/queue/index.js";
import { OpenAICompatRunner } from "../../src/runner/index.js";
import { decideUpdate, partsFromMessage, viewFromParts } from "../../src/telegram/decide.js";
import { handleTelegramUpdate, type TelegramEnqueue } from "../../src/telegram/handle.js";
import { toolRegistry } from "../../src/tools/index.js";
import { loadRunnerAgent, runWorker, type WorkerLoopOptions } from "../../src/worker.js";
import { assertTestDatabase, sql } from "../helpers/db.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const WORKER_ID = "worker-acceptance";
const TOKEN = "test-secret-value";
const ALLOWED_USER_IDS = ["42"];

const queue = createRunQueue(sql);
const journal = createRunJournal(sql, [TOKEN]);

describe("acceptance", () => {
  it("должен двумя соединениями захватить разные запуски", async () => {
    const first = await queue.enqueue(enqueueInput("claim-a", { message: "левый" }));
    const second = await queue.enqueue(enqueueInput("claim-b", { message: "правый" }));

    await withTwoConnections(async (left, right) => {
      const [claimLeft, claimRight] = await Promise.all([
        createRunQueue(left).claimNext("left-worker", 30),
        createRunQueue(right).claimNext("right-worker", 30),
      ]);
      const leftRun = mustClaim(claimLeft);
      const rightRun = mustClaim(claimRight);

      expect(leftRun.id).not.toBe(rightRun.id);
      expect(leftRun.status).toBe("running");
      expect(rightRun.status).toBe("running");
      expect(leftRun.lockedBy).toBe("left-worker");
      expect(rightRun.lockedBy).toBe("right-worker");
      expect(new Set([leftRun.id, rightRun.id])).toEqual(new Set([first.run.id, second.run.id]));
    });

    expect(await queue.claimNext("late-worker", 30)).toBeNull();
  });

  it("должен снова исполнить просроченный запуск или закрыть его после попыток, не ставя второй succeeded", async () => {
    const guard = guardedRunner();

    const expired = await queue.enqueue(enqueueInput("lease-again", { message: "просрочен" }));
    const owned = mustClaim(await queue.claimNext("dead-owner", 30));
    expect(owned.id).toBe(expired.run.id);
    expect(owned.attempt).toBe(1);
    await expireLease(owned.id);
    expect(await queue.reapExpired()).toBe(1);
    const requeued = await storedRun(owned.id);
    expect(requeued.status).toBe("queued");
    expect(requeued.attempt).toBe(1);

    await drainOnce({ runner: guard.runner, model: silentModel });

    expect(guard.calls).toEqual([owned.id]);
    expect(guard.successes).toEqual([owned.id]);
    const again = await storedRun(owned.id);
    expect(again.status).toBe("succeeded");
    expect(again.attempt).toBe(2);
    expect(again.final_text).toBe("снова");
    expect(again.error).toBeNull();

    const exhausted = await queue.enqueue(enqueueInput("lease-give-up", { message: "попытки" }));
    await sql`update runs set max_attempts = 1 where id = ${exhausted.run.id}`;
    const burned = mustClaim(await queue.claimNext("dead-owner", 30));
    expect(burned.id).toBe(exhausted.run.id);
    expect(burned.attempt).toBe(1);
    await expireLease(burned.id);
    expect(await queue.reapExpired()).toBe(1);

    await drainOnce({ runner: guard.runner, model: silentModel });

    expect(guard.calls).toEqual([owned.id]);
    expect(guard.successes).toEqual([owned.id]);
    const failed = await storedRun(burned.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("lease expired");
    expect(failed.final_text).toBeNull();
    expect(failed.attempt).toBe(1);
    const stillOnce = await storedRun(owned.id);
    expect(stillOnce.status).toBe("succeeded");
    expect(stillOnce.final_text).toBe("снова");
  });

  it("должен на один и тот же update_id оставить одну строку", async () => {
    const view = textUpdate(701, "повтори", 4242);
    const firstDecision = decideUpdate(view, ALLOWED_USER_IDS, AGENT_ID);
    const secondDecision = decideUpdate(view, ALLOWED_USER_IDS, AGENT_ID);
    expect(firstDecision).toEqual(secondDecision);
    if (firstDecision.kind !== "enqueue") {
      throw new Error("update was not accepted");
    }

    const recorded = recordingEnqueue();
    const options = {
      allowedUserIds: ALLOWED_USER_IDS,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
    };
    await handleTelegramUpdate(view, options);
    await handleTelegramUpdate(view, options);

    expect(recorded.results).toHaveLength(2);
    expect(recorded.results[0]?.created).toBe(true);
    expect(recorded.results[0]?.reason).toBe("created");
    expect(recorded.results[1]?.created).toBe(false);
    expect(recorded.results[1]?.reason).toBe("replay");
    expect(recorded.results[0]?.run.id).toBe(recorded.results[1]?.run.id);
    expect(recorded.results[0]?.run.idempotencyKey).toBe(firstDecision.idempotencyKey);
    expect(firstDecision.idempotencyKey).toBe(`tg:${AGENT_ID}:701`);
    expect(await countRuns()).toBe(1);
  });

  it("должен не создавать строку, когда диалог занят", async () => {
    const recorded = recordingEnqueue();
    const options = {
      allowedUserIds: ALLOWED_USER_IDS,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
    };
    const first = await handleTelegramUpdate(textUpdate(801, "первый", 5151), options);
    const second = await handleTelegramUpdate(textUpdate(802, "второй", 5151), options);

    expect(recorded.results).toHaveLength(2);
    expect(recorded.results[0]?.created).toBe(true);
    expect(recorded.results[1]?.created).toBe(false);
    expect(recorded.results[1]?.reason).toBe("dialog_busy");
    expect(recorded.results[1]?.run.id).toBe(recorded.results[0]?.run.id);
    expect(await countRuns()).toBe(1);
    const liveId = recorded.results[0]?.run.id;
    if (liveId === undefined) {
      throw new Error("live run is missing");
    }
    expect(second.text).toContain(liveId);
    expect(first.followRunId).toBe(liveId);
    expect(second.followRunId).toBe(liveId);
  });

  it("должен записать policy_deny на Bash и не исполнять инструмент", async () => {
    let executed = 0;
    const bash: Tool = {
      name: "Bash",
      description: "Запрещённая оболочка",
      effect: "read",
      parameters: z.object({}),
      execute() {
        executed += 1;
        return Promise.resolve({ ok: true, text: "ran", truncated: false, entries: null });
      },
    };
    const script = scriptedModel([toolOutput("Bash", "{}"), textOutput("не исполняю")]);
    const created = await queue.enqueue(enqueueInput("bash-deny", { message: "выполни команду" }));

    await withTempRoot(async (root) => {
      await drainOnce({
        runner: productRunner(root),
        model: script.model,
        tools: [bash, ...toolRegistry],
      });
    });

    expect(executed).toBe(0);
    expect(script.inputs).toHaveLength(2);
    const steps = await storedSteps(created.run.id);
    expect(steps.some((step) => step.kind === "tool_result")).toBe(false);
    expect(steps.filter((step) => step.kind === "policy_deny")).toEqual([
      expect.objectContaining({
        kind: "policy_deny",
        tool_name: "Bash",
      }),
    ]);
  });

  it("должен провалить запуск с пустым final_text, если JSON инструмента пришёл в тексте", async () => {
    let executed = 0;
    const readSpy: Tool = {
      name: "read_file",
      description: "Чтение",
      effect: "read",
      parameters: z.object({ path: z.string() }),
      execute() {
        executed += 1;
        return Promise.resolve({
          ok: true,
          text: "should-not-run",
          truncated: false,
          entries: null,
        });
      },
    };
    const raw = '{"name":"read_file","arguments":{"path":"secret.txt"}}';
    const script = scriptedModel([textOutput(raw)]);
    const created = await queue.enqueue(enqueueInput("json-text", { message: "прочитай" }));

    await withTempRoot(async (root) => {
      await drainOnce({
        runner: productRunner(root),
        model: script.model,
        tools: [readSpy, ...toolRegistry],
      });
    });

    expect(executed).toBe(0);
    expect(script.inputs).toHaveLength(1);
    const row = await storedRun(created.run.id);
    expect(row.status).toBe("failed");
    expect(row.final_text ?? "").toBe("");
    expect(row.error).toBe("json_in_text");
    const steps = await storedSteps(created.run.id);
    expect(steps.some((step) => step.kind === "tool_call" || step.kind === "tool_result")).toBe(
      false,
    );
    expect(steps.some((step) => step.kind === "parse_error" && step.error === "json_in_text")).toBe(
      true,
    );
  });

  it("должен скрыть фейковый токен в шагах и во втором ходе модели", async () => {
    const script = scriptedModel([
      toolOutput("read_file", '{"path":"note.txt"}'),
      textOutput("готово"),
    ]);
    const created = await queue.enqueue(
      enqueueInput("redact-tool", { message: "прочитай заметку" }),
    );

    await withTempRoot(async (root) => {
      await writeFile(path.join(root, "note.txt"), `prefix ${TOKEN} suffix`, "utf8");
      await drainOnce({
        runner: productRunner(root),
        model: script.model,
        tools: toolRegistry,
      });
    });

    expect(script.inputs).toHaveLength(2);
    const second = script.inputs[1];
    if (second === undefined) {
      throw new Error("second model turn is missing");
    }
    expect(JSON.stringify(second)).not.toContain(TOKEN);
    expect(second.messages.find((message) => message.role === "tool")?.content).toBe(
      `prefix ${REDACTED} suffix`,
    );

    const steps = await storedSteps(created.run.id);
    expect(steps.find((step) => step.kind === "tool_result")?.response_excerpt).toBe(
      `prefix ${REDACTED} suffix`,
    );
    for (const step of steps) {
      expect(step.request_excerpt ?? "").not.toContain(TOKEN);
      expect(step.response_excerpt ?? "").not.toContain(TOKEN);
      expect(step.error ?? "").not.toContain(TOKEN);
      expect(step.tool_name ?? "").not.toContain(TOKEN);
    }
  });

  /** Без флага это не падение: живой прогон не входит в семь сценариев. */
  it.skipIf(process.env.HARNESS_LIVE_MODEL !== "1")(
    "должен живой моделью прочитать файл и завершиться succeeded",
    async () => {
      const config = loadConfig();
      const secrets = collectSecrets({
        databaseUrl: config.databaseUrl,
        harnessTestDatabaseUrl: config.harnessTestDatabaseUrl,
        litellmApiKey: config.litellmApiKey,
        harnessApiToken: config.harnessApiToken,
        telegramBotToken: config.telegramBotToken,
      });
      const created = await queue.enqueue(
        enqueueInput("live-read", { message: "прочитай файл и назови его содержимое" }),
      );

      await withTempRoot(async (root) => {
        await writeFile(path.join(root, "note.txt"), "живое-содержимое", "utf8");
        await drainOnce({
          runner: new OpenAICompatRunner({
            loadAgent(agentId: string) {
              return loadRunnerAgent(sql, agentId);
            },
            fileRoot: root,
            secrets,
          }),
          model: new LiteLLMChatModel({
            baseUrl: config.litellmBaseUrl,
            apiKey: config.litellmApiKey,
            secrets,
          }),
          tools: toolRegistry,
          leaseSeconds: config.leaseSeconds,
          heartbeatSeconds: config.heartbeatSeconds,
        });
      });

      const row = await storedRun(created.run.id);
      const steps = await storedSteps(created.run.id);
      expect(row.status).toBe("succeeded");
      expect(
        steps.some((step) => step.kind === "tool_call" && step.tool_name === "read_file"),
      ).toBe(true);
    },
    180_000,
  );
});

const silentModel: ChatModel = {
  complete(): Promise<ModelOutput> {
    return Promise.reject(new Error("model must not be called"));
  },
};

/**
 * I8: успешный запуск повторно не исполняется.
 * Второй вызов на уже succeeded падает до finish, второй succeeded не пишется.
 */
function guardedRunner(): { runner: Runner; calls: string[]; successes: string[] } {
  const succeededIds = new Set<string>();
  const calls: string[] = [];
  const successes: string[] = [];
  const runner: Runner = {
    async run(claimed, ctx) {
      calls.push(claimed.id);
      if (succeededIds.has(claimed.id)) {
        throw new Error("runner called again on succeeded run");
      }
      const row = await storedRun(claimed.id);
      if (row.status === "succeeded") {
        throw new Error("runner called again on succeeded run");
      }
      const wrote = await ctx.finish(claimed.id, WORKER_ID, succeeded("снова"));
      if (!wrote) {
        throw new Error("finish did not record the run");
      }
      succeededIds.add(claimed.id);
      successes.push(claimed.id);
    },
  };
  return { runner, calls, successes };
}

function productRunner(fileRoot: string): OpenAICompatRunner {
  return new OpenAICompatRunner({
    loadAgent(agentId: string) {
      return loadRunnerAgent(sql, agentId);
    },
    fileRoot,
    secrets: [TOKEN],
  });
}

function scriptedModel(outputs: readonly ModelOutput[]): {
  model: ChatModel;
  inputs: ModelInput[];
} {
  const inputs: ModelInput[] = [];
  const model: ChatModel = {
    complete(input) {
      const snapshot = snapshotInput(input);
      inputs.push(snapshot);
      const next = outputs[inputs.length - 1];
      if (next === undefined) {
        return Promise.reject(new Error("model has no scripted output"));
      }
      return Promise.resolve(next);
    },
  };
  return { model, inputs };
}

function snapshotInput(input: ModelInput): ModelInput {
  return {
    model: input.model,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    tools: input.tools.map((tool) => ({ ...tool })),
    messages: input.messages.map(snapshotMessage),
  };
}

function snapshotMessage(message: ModelMessage): ModelMessage {
  return {
    role: message.role,
    content: message.content,
    toolCallId: message.toolCallId,
    toolCalls:
      message.toolCalls === null
        ? null
        : message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
  };
}

function textOutput(content: string): ModelOutput {
  return {
    content,
    toolCalls: [],
    promptTokens: 1,
    completionTokens: 1,
    model: "agent",
  };
}

function toolOutput(name: string, args: string): ModelOutput {
  return {
    content: null,
    toolCalls: [{ id: "call-1", name, arguments: args }],
    promptTokens: 1,
    completionTokens: 1,
    model: "agent",
  };
}

interface DrainOptions {
  runner: Runner;
  model: ChatModel;
  tools?: readonly Tool[];
  leaseSeconds?: number;
  heartbeatSeconds?: number;
}

async function drainOnce(options: DrainOptions): Promise<void> {
  const controller = new AbortController();
  const loop: WorkerLoopOptions = {
    queue,
    journal,
    runner: options.runner,
    model: options.model,
    tools: options.tools ?? toolRegistry,
    workerId: WORKER_ID,
    leaseSeconds: options.leaseSeconds ?? 30,
    heartbeatSeconds: options.heartbeatSeconds ?? 60,
    signal: controller.signal,
    sleep(): Promise<void> {
      controller.abort();
      return Promise.resolve();
    },
  };
  await runWorker(loop);
}

function recordingEnqueue(): { enqueue: TelegramEnqueue; results: EnqueueResult[] } {
  const results: EnqueueResult[] = [];
  const enqueue: TelegramEnqueue = async (input) => {
    const result = await queue.enqueue(input);
    results.push(result);
    return { runId: result.run.id, reason: result.reason };
  };
  return { enqueue, results };
}

function textUpdate(updateId: number, text: string, chatId: number) {
  const view = viewFromParts(
    partsFromMessage(updateId, {
      chat: { id: chatId },
      from: { id: 42 },
      text,
    }),
  );
  if (view === null) {
    throw new Error("update view is missing");
  }
  return view;
}

function enqueueInput(
  idempotencyKey: string,
  overrides: { message?: string; priority?: number } = {},
): EnqueueInput {
  const input: EnqueueInput = {
    tenantId: "local",
    agentId: AGENT_ID,
    source: "api",
    idempotencyKey,
    message: overrides.message ?? "привет",
    chatId: null,
  };
  if (overrides.priority !== undefined) {
    input.priority = overrides.priority;
  }
  return input;
}

function succeeded(finalText: string): FinishOutcome {
  return {
    status: "succeeded",
    finalText,
    error: null,
    modelAlias: "agent",
    provider: "local",
    promptTokens: null,
    completionTokens: null,
  };
}

function mustClaim(claimed: ClaimedRun | null): ClaimedRun {
  if (claimed === null) {
    throw new Error("claim returned no run");
  }
  return claimed;
}

interface StoredRun {
  status: string;
  attempt: number;
  error: string | null;
  final_text: string | null;
}

async function storedRun(id: string): Promise<StoredRun> {
  const rows = await sql<StoredRun[]>`
    select status, attempt, error, final_text
    from runs
    where id = ${id}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("run is missing");
  }
  return row;
}

interface StoredStep {
  kind: string;
  tool_name: string | null;
  request_excerpt: string | null;
  response_excerpt: string | null;
  error: string | null;
}

async function storedSteps(runId: string): Promise<StoredStep[]> {
  return sql<StoredStep[]>`
    select kind, tool_name, request_excerpt, response_excerpt, error
    from run_steps
    where run_id = ${runId}
    order by step_index asc
  `;
}

async function countRuns(): Promise<number> {
  const rows = await sql<{ count: number }[]>`select count(*)::int as count from runs`;
  const count = rows[0]?.count;
  if (count === undefined) {
    throw new Error("count is missing");
  }
  return count;
}

async function expireLease(id: string): Promise<void> {
  await sql`
    update runs
    set locked_until = now() - interval '1 second'
    where id = ${id}
      and status = 'running'
  `;
}

async function withTwoConnections(body: (left: Sql, right: Sql) => Promise<void>): Promise<void> {
  const databaseUrl = loadConfig().harnessTestDatabaseUrl;
  if (databaseUrl === null) {
    throw new Error("HARNESS_TEST_DATABASE_URL is required");
  }
  assertTestDatabase(databaseUrl);
  const left = createSql(databaseUrl);
  const right = createSql(databaseUrl);
  try {
    await body(left, right);
  } finally {
    try {
      await left.end({ timeout: 5 });
    } finally {
      await right.end({ timeout: 5 });
    }
  }
}

async function withTempRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "harness-acceptance-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
