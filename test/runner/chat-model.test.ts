import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type {
  ChatModel,
  EnqueueSource,
  ModelInput,
  ModelOutput,
  Tool,
} from "../../src/contracts/index.js";
import type { Sql } from "../../src/db/client.js";
import { LiteLLMChatModel } from "../../src/model/litellm.js";
import { createRunJournal } from "../../src/journal/index.js";
import { createRunQueue } from "../../src/queue/index.js";
import { ClaudeSdkRunner } from "../../src/runner/claude-sdk.js";
import { OpenAICompatRunner } from "../../src/runner/index.js";
import { saveChatModelChoice } from "../../src/telegram/chat-model.js";
import { toolRegistry } from "../../src/tools/index.js";
import {
  WORKER_MODEL_TIMEOUT_MS,
  createWorkerChatModel,
  loadRunnerAgent,
  runWorker,
  type RunnerSelection,
  type WorkerLoopOptions,
} from "../../src/worker.js";
import { sql } from "../helpers/db.js";

const CLERK_ID = "00000000-0000-4000-8000-000000000001";
const WORKER_ID = "worker-chat-model";
const FILE_ROOT = path.join(tmpdir(), "harness-chat-model");
const CHAT = 9223372036854775807n;
const ALLOWLIST = ["read_file", "list_dir"];
const QUIET_DIRS = ["api", "cron", "delegation"] as const;

const queue = createRunQueue(sql);
const journal = createRunJournal(sql, []);

const outsider: Tool = {
  name: "create_subtask",
  description: "Делегирование не из allowlist чата",
  effect: "write",
  parameters: z.object({}),
  execute() {
    return Promise.reject(new Error("outsider must not execute"));
  },
};

describe("chat model run", () => {
  beforeEach(async () => {
    await sql`delete from chat_model_choices`;
  });

  afterAll(async () => {
    await sql`delete from chat_model_choices`;
  });

  it("должен без выбора звать agent", async () => {
    const watched = watchChatChoiceReads(sql);
    const runId = await enqueue("telegram", "без выбора");
    const model = scripted(textOutput("локально"));
    const driven = await drain(watched.sql, model);

    expect(watched.reads()).toBe(1);
    expect(driven.externalCalls).toBe(0);
    expect(model.inputs.map((input) => input.model)).toEqual(["agent"]);
    expect(model.inputs[0]?.tools.map((tool) => tool.name)).toEqual(ALLOWLIST);
    const row = await storedRun(runId);
    expect(row).toMatchObject({
      status: "succeeded",
      model_alias: "agent",
      provider: "local",
    });
  });

  it("должен после /cloud звать coder-cloud при provider local", async () => {
    await saveChatModelChoice(sql, CHAT, "coder-cloud");
    const watched = watchChatChoiceReads(sql);
    const runId = await enqueue("telegram", "внешний ход");
    const model = scripted(textOutput("из облака"));
    const driven = await drain(watched.sql, model);

    expect(watched.reads()).toBe(1);
    expect(driven.externalCalls).toBe(0);
    expect(model.inputs.map((input) => input.model)).toEqual(["coder-cloud"]);
    expect(model.inputs[0]?.tools.map((tool) => tool.name)).toEqual(ALLOWLIST);
    expect(model.inputs[0]?.tools.map((tool) => tool.name)).not.toContain("create_subtask");
    const row = await storedRun(runId);
    expect(row).toMatchObject({
      status: "succeeded",
      model_alias: "coder-cloud",
      provider: "local",
      final_text: "из облака",
    });
  });

  it("должен после /local звать agent и оставить provider local", async () => {
    await saveChatModelChoice(sql, CHAT, "agent");
    const watched = watchChatChoiceReads(sql);
    const runId = await enqueue("telegram", "локальный ход");
    const model = scripted(textOutput("снова локально"));
    const driven = await drain(watched.sql, model);

    expect(watched.reads()).toBe(1);
    expect(driven.externalCalls).toBe(0);
    expect(model.inputs.map((input) => input.model)).toEqual(["agent"]);
    expect(model.inputs[0]?.tools.map((tool) => tool.name)).toEqual(ALLOWLIST);
    const row = await storedRun(runId);
    expect(row).toMatchObject({
      status: "succeeded",
      model_alias: "agent",
      provider: "local",
    });
  });

  it("должен не читать выбор чата для запуска API, cron и delegation", async () => {
    const sources: readonly EnqueueSource[] = ["api", "cron", "delegation"];
    for (const source of sources) {
      await sql`delete from chat_model_choices`;
      await saveChatModelChoice(sql, CHAT, "coder-cloud");
      const watched = watchChatChoiceReads(sql);
      const runId = await enqueue(source, `ход ${source}`);
      const model = scripted(textOutput("не из чата"));
      const driven = await drain(watched.sql, model);

      expect(watched.reads()).toBe(0);
      expect(driven.externalCalls).toBe(0);
      expect(model.inputs.map((input) => input.model)).toEqual(["agent"]);
      const row = await storedRun(runId);
      expect(row).toMatchObject({
        status: "succeeded",
        model_alias: "agent",
        provider: "local",
      });
    }
  });

  it("должен не упоминать таблицу выбора в API, cron и delegation", async () => {
    const sources = await directorySources(QUIET_DIRS);
    expect(sources.length).toBeGreaterThanOrEqual(6);
    const offenders = sources
      .filter((item) => item.source.includes("chat_model_choices"))
      .map((item) => item.filePath);
    expect(offenders).toEqual([]);
  });

  it("должен передать клиенту LiteLLM таймаут 180 секунд и не брать его из окружения", async () => {
    expect(WORKER_MODEL_TIMEOUT_MS).toBe(180_000);
    const workerSource = await readSource(
      fileURLToPath(new URL("../../src/worker.ts", import.meta.url)),
    );
    expect(workerSource.includes("TELEGRAM_MODEL_ALIAS")).toBe(false);
    expect(workerSource.includes("process.env")).toBe(false);
    expect(workerSource.includes("timeoutMs: WORKER_MODEL_TIMEOUT_MS")).toBe(true);

    const workerTimeouts = await captureTimeouts(() =>
      createWorkerChatModel({
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "test-secret-value",
        secrets: [],
      }).complete(ping("agent")),
    );
    expect(workerTimeouts).toEqual([180_000]);

    const defaultTimeouts = await captureTimeouts(() =>
      new LiteLLMChatModel({
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "test-secret-value",
      }).complete(ping("agent")),
    );
    expect(defaultTimeouts).toEqual([60_000]);
  });

  it("должен не содержать переменную, которая уводит весь Telegram во внешний алиас", async () => {
    const sources = await directorySources([""]);
    const offenders = sources
      .filter((item) => item.source.includes("TELEGRAM_MODEL_ALIAS"))
      .map((item) => item.filePath);
    expect(offenders).toEqual([]);
  });
});

function ping(model: string): ModelInput {
  return {
    model,
    temperature: 0,
    messages: [{ role: "user", content: "ping", toolCallId: null, toolCalls: null }],
    tools: [],
  };
}

async function captureTimeouts(call: () => Promise<unknown>): Promise<number[]> {
  const seen: number[] = [];
  const original = AbortSignal.timeout.bind(AbortSignal);
  const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds: number) => {
    seen.push(milliseconds);
    return original(milliseconds);
  });
  const previous = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("offline"));
  try {
    await expect(call()).rejects.toThrow();
  } finally {
    spy.mockRestore();
    globalThis.fetch = previous;
  }
  return seen;
}

interface ScriptedModel extends ChatModel {
  inputs: ModelInput[];
}

function scripted(output: ModelOutput): ScriptedModel {
  const inputs: ModelInput[] = [];
  return {
    inputs,
    complete(input: ModelInput): Promise<ModelOutput> {
      inputs.push({
        model: input.model,
        temperature: input.temperature,
        messages: input.messages.map((message) => ({
          role: message.role,
          content: message.content,
          toolCallId: message.toolCallId,
          toolCalls: message.toolCalls,
        })),
        tools: input.tools.map((tool) => ({ ...tool })),
      });
      return Promise.resolve(output);
    },
  };
}

function textOutput(content: string): ModelOutput {
  return {
    content,
    toolCalls: [],
    promptTokens: 2,
    completionTokens: 3,
    model: "reported",
  };
}

async function enqueue(source: EnqueueSource, message: string): Promise<string> {
  const created = await queue.enqueue({
    tenantId: "local",
    agentId: CLERK_ID,
    source,
    idempotencyKey: `${source}-${randomUUID()}`,
    message,
    chatId: CHAT,
  });
  return created.run.id;
}

async function drain(watched: Sql, model: ChatModel): Promise<{ externalCalls: number }> {
  let externalCalls = 0;
  const local = new OpenAICompatRunner({
    loadAgent(agentId: string) {
      return loadRunnerAgent(watched, agentId);
    },
    fileRoot: FILE_ROOT,
    secrets: [],
    sql: watched,
  });
  const selection: RunnerSelection = {
    local,
    createExternal(): ClaudeSdkRunner {
      externalCalls += 1;
      return new ClaudeSdkRunner({
        client: {
          run(): Promise<void> {
            return Promise.reject(new Error("sdk must not run"));
          },
        },
      });
    },
    loadAgent(agentId: string) {
      return loadRunnerAgent(watched, agentId);
    },
    sql: watched,
  };
  const controller = new AbortController();
  const options: WorkerLoopOptions = {
    queue,
    journal,
    runner: {
      run(): Promise<void> {
        return Promise.reject(new Error("fixed runner must not replace selection"));
      },
    },
    selection,
    model,
    tools: [...toolRegistry, outsider],
    workerId: WORKER_ID,
    leaseSeconds: 120,
    heartbeatSeconds: 60,
    signal: controller.signal,
    sleep() {
      controller.abort();
      return Promise.resolve();
    },
  };
  await runWorker(options);
  return { externalCalls };
}

interface StoredRun {
  status: string;
  model_alias: string | null;
  provider: string | null;
  final_text: string | null;
}

async function storedRun(runId: string): Promise<StoredRun> {
  const rows = await sql<StoredRun[]>`
    select status, model_alias, provider, final_text
    from runs
    where id = ${runId}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("run was not stored");
  }
  return row;
}

function watchChatChoiceReads(inner: Sql): { sql: Sql; reads(): number } {
  let reads = 0;
  const handler: ProxyHandler<Sql> = {
    apply(target, thisArg, argList: readonly unknown[]): unknown {
      const first = argList[0];
      if (isTemplate(first) && first.join("").includes("chat_model_choices")) {
        reads += 1;
      }
      return Reflect.apply(target, thisArg, argList);
    },
  };
  return {
    sql: new Proxy(inner, handler),
    reads: () => reads,
  };
}

function isTemplate(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && Object.hasOwn(value, "raw");
}

async function directorySources(
  names: readonly string[],
): Promise<{ filePath: string; source: string }[]> {
  const found: { filePath: string; source: string }[] = [];
  for (const name of names) {
    const directory = fileURLToPath(new URL(`../../src/${name}`, import.meta.url));
    // Каталоги пакета фиксированы. Путь модели сюда не приходит.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- каталоги src пакета
    const entries = await readdir(directory, { recursive: true, encoding: "utf8" });
    for (const entry of entries) {
      if (!entry.endsWith(".ts")) {
        continue;
      }
      const filePath = path.join(directory, entry);
      found.push({ filePath, source: await readSource(filePath) });
    }
  }
  return found;
}

async function readSource(filePath: string): Promise<string> {
  // Фиксированные файлы репозитория, не путь из запуска.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- чтение исходников пакета
  return readFile(filePath, "utf8");
}
