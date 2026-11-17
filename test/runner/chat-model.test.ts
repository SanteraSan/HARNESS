import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
const NO_TOOLS_NOTE =
  "В этом ходе инструментов нет. Ответь на вопрос сразу, не открывая файлы.";

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
    expect(model.inputs[0]).not.toHaveProperty("reasoningEffort");
    expect(systemText(model.inputs[0]).includes(NO_TOOLS_NOTE)).toBe(false);
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
    expect(model.inputs[0]?.tools).toEqual([]);
    expect(model.inputs[0]?.reasoningEffort).toBe("none");
    expect(model.inputs[0]?.messages.some((message) => message.role === "tool")).toBe(false);
    const agent = await loadRunnerAgent(sql, CLERK_ID);
    const system = systemText(model.inputs[0]);
    expect(system.startsWith(`${agent.systemPrompt}\n`)).toBe(true);
    expect(system.endsWith(NO_TOOLS_NOTE)).toBe(true);
    const row = await storedRun(runId);
    expect(row).toMatchObject({
      status: "succeeded",
      model_alias: "coder-cloud",
      provider: "local",
      final_text: "из облака",
    });
  });

  it("должен после /cloud не исполнять tool_calls и не звать модель второй раз", async () => {
    await saveChatModelChoice(sql, CHAT, "coder-cloud");
    const runId = await enqueue("telegram", "ход с инструментом");
    const model = scripted({
      content: null,
      toolCalls: [{ id: "call-1", name: "read_file", arguments: "{\"path\":\"note.txt\"}" }],
      promptTokens: 1,
      completionTokens: 1,
      model: "reported",
    });
    const driven = await drain(sql, model);

    expect(driven.externalCalls).toBe(0);
    expect(model.inputs).toHaveLength(1);
    expect(model.inputs[0]?.tools).toEqual([]);
    expect(model.inputs[0]?.reasoningEffort).toBe("none");
    expect(systemText(model.inputs[0]).endsWith(NO_TOOLS_NOTE)).toBe(true);
    expect(model.inputs[0]?.messages.some((message) => message.role === "tool")).toBe(false);
    const row = await storedRun(runId);
    expect(row).toMatchObject({
      status: "failed",
      error: "external_tool_call",
      final_text: null,
      model_alias: "coder-cloud",
      provider: "local",
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
    expect(model.inputs[0]).not.toHaveProperty("reasoningEffort");
    expect(systemText(model.inputs[0]).includes(NO_TOOLS_NOTE)).toBe(false);
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
      expect(model.inputs[0]?.tools.map((tool) => tool.name)).toEqual(ALLOWLIST);
      expect(model.inputs[0]).not.toHaveProperty("reasoningEffort");
      expect(systemText(model.inputs[0]).includes(NO_TOOLS_NOTE)).toBe(false);
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

  it("должен передать клиенту LiteLLM таймаут 10 минут и не брать его из окружения", async () => {
    expect(WORKER_MODEL_TIMEOUT_MS).toBe(600_000);
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
    expect(workerTimeouts).toEqual([600_000]);

    const defaultTimeouts = await captureTimeouts(() =>
      new LiteLLMChatModel({
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "test-secret-value",
      }).complete(ping("agent")),
    );
    expect(defaultTimeouts).toEqual([60_000]);
  });

  it("должен после /cloud отправить один JSON без ключа tools, с reasoning_effort none и фразой", async () => {
    await saveChatModelChoice(sql, CHAT, "coder-cloud");
    const runId = await enqueue("telegram", "какой шлюз рисует");
    const agent = await loadRunnerAgent(sql, CLERK_ID);
    const seen = await withGateway(textCompletionBody("сразу"), async (model) => {
      const driven = await drain(sql, model);
      expect(driven.externalCalls).toBe(0);
    });

    expect(seen).toHaveLength(1);
    const body = asRecord(seen[0]);
    expect(Object.hasOwn(body, "tools")).toBe(false);
    expect(body.model).toBe("coder-cloud");
    expect(body.reasoning_effort).toBe("none");
    const system = wireSystem(body);
    expect(system.startsWith(`${agent.systemPrompt}\n`)).toBe(true);
    expect(system.endsWith(NO_TOOLS_NOTE)).toBe(true);
    const row = await storedRun(runId);
    expect(row).toMatchObject({
      status: "succeeded",
      model_alias: "coder-cloud",
      provider: "local",
      final_text: "сразу",
    });
  });

  it("должен после /cloud на tool_calls завершить запуск failed одним вызовом клиента", async () => {
    await saveChatModelChoice(sql, CHAT, "coder-cloud");
    const runId = await enqueue("telegram", "открой файл");
    const seen = await withGateway(toolCallCompletionBody(), async (model) => {
      const driven = await drain(sql, model);
      expect(driven.externalCalls).toBe(0);
    });

    expect(seen).toHaveLength(1);
    const body = asRecord(seen[0]);
    expect(Object.hasOwn(body, "tools")).toBe(false);
    expect(body.reasoning_effort).toBe("none");
    expect(wireSystem(body).endsWith(NO_TOOLS_NOTE)).toBe(true);
    const row = await storedRun(runId);
    expect(row).toMatchObject({
      status: "failed",
      error: "external_tool_call",
      final_text: null,
      model_alias: "coder-cloud",
      provider: "local",
    });
  });

  it("должен после /local отправить read_file и list_dir без ключа reasoning_effort", async () => {
    await saveChatModelChoice(sql, CHAT, "agent");
    const runId = await enqueue("telegram", "локальный вопрос");
    const seen = await withGateway(textCompletionBody("локально"), async (model) => {
      const driven = await drain(sql, model);
      expect(driven.externalCalls).toBe(0);
    });

    expect(seen).toHaveLength(1);
    const body = asRecord(seen[0]);
    expect(body.model).toBe("agent");
    expect(Object.hasOwn(body, "reasoning_effort")).toBe(false);
    expect(wireToolNames(body)).toEqual(ALLOWLIST);
    expect(wireSystem(body).includes(NO_TOOLS_NOTE)).toBe(false);
    const row = await storedRun(runId);
    expect(row).toMatchObject({
      status: "succeeded",
      model_alias: "agent",
      provider: "local",
      final_text: "локально",
    });
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
    maxTokens: 4096,
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
      const saved: ModelInput = {
        model: input.model,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        messages: input.messages.map((message) => ({
          role: message.role,
          content: message.content,
          toolCallId: message.toolCallId,
          toolCalls: message.toolCalls,
        })),
        tools: input.tools.map((tool) => ({ ...tool })),
      };
      if (input.reasoningEffort === "none") {
        saved.reasoningEffort = "none";
      }
      inputs.push(saved);
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
  error: string | null;
}

async function storedRun(runId: string): Promise<StoredRun> {
  const rows = await sql<StoredRun[]>`
    select status, model_alias, provider, final_text, error
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

function systemText(input: ModelInput | undefined): string {
  const content = input?.messages.find((message) => message.role === "system")?.content;
  if (content === null || content === undefined) {
    throw new Error("system message");
  }
  return content;
}

function textCompletionBody(content: string): unknown {
  return {
    model: "reported",
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 2, completion_tokens: 3 },
  };
}

function toolCallCompletionBody(): unknown {
  return {
    model: "reported",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"note.txt\"}" },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("request body");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wireSystem(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (!Array.isArray(messages)) {
    throw new Error("messages");
  }
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    if (message.role === "system" && typeof message.content === "string") {
      return message.content;
    }
  }
  throw new Error("system message");
}

function wireToolNames(body: Record<string, unknown>): string[] {
  const tools = body.tools;
  if (!Array.isArray(tools)) {
    throw new Error("tools");
  }
  return tools.map((tool) => {
    if (!isRecord(tool)) {
      throw new Error("tool");
    }
    const spec = tool.function;
    if (!isRecord(spec) || typeof spec.name !== "string") {
      throw new Error("tool name");
    }
    return spec.name;
  });
}

async function withGateway(
  responseBody: unknown,
  run: (model: ChatModel) => Promise<void>,
): Promise<unknown[]> {
  const bodies: unknown[] = [];
  let serverError: Error | undefined;
  const server = createServer((req, res) => {
    void readGateway(req, res, bodies, responseBody);
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.on("error", (error: Error) => {
    serverError = error;
  });
  await listen(server);
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server address");
    }
    const model = new LiteLLMChatModel({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test-secret-value",
    });
    await run(model);
    if (serverError !== undefined) {
      throw serverError;
    }
    return bodies;
  } finally {
    await closeServer(server);
  }
}

async function readGateway(
  req: IncomingMessage,
  res: ServerResponse,
  bodies: unknown[],
  responseBody: unknown,
): Promise<void> {
  try {
    const raw = await readIncoming(req);
    bodies.push(raw.length > 0 ? (JSON.parse(raw) as unknown) : raw);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(responseBody));
  } catch {
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    res.end();
  }
}

async function readIncoming(req: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(copyChunk(chunk));
  }
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

/** Поток запроса в типах Node отдаёт any. Наружу выходит только байтовый срез. */
function copyChunk(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new Error("unexpected request chunk");
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
