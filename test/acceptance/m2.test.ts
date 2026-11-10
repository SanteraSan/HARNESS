/* Фикстура файла собирается во временном каталоге: литерального пути нет. */
/* eslint-disable security/detect-non-literal-fs-filename -- временный корень приёмки */
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ChatModel,
  EnqueueInput,
  ModelInput,
  ModelMessage,
  ModelOutput,
  Runner,
  Tool,
  ToolCall,
} from "../../src/contracts/index.js";
import { createCronJob, tickCron } from "../../src/cron/index.js";
import { createRunJournal } from "../../src/journal/index.js";
import { LiteLLMChatModel } from "../../src/model/index.js";
import { createRunQueue } from "../../src/queue/index.js";
import { OpenAICompatRunner } from "../../src/runner/index.js";
import { toolRegistry } from "../../src/tools/index.js";
import { loadRunnerAgent, runWorker, type WorkerLoopOptions } from "../../src/worker.js";
import { sql } from "../helpers/db.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const WORKER_ID = "worker-m2-acceptance";
const TOKEN = "test-secret-value";
const NOTE_KEY = "same-note";
const SAME_TURN = "повтори ход";

const queue = createRunQueue(sql);
const journal = createRunJournal(sql, [TOKEN]);

describe("m2 acceptance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("должен создать один файл, если record_note вызван дважды с одним ключом", async () => {
    await applyRouteRules();
    await allowRecordNote();
    const rule = await routeRule("write_tool");
    expect(rule).toEqual({ model_alias: "coder-cloud", provider: "external" });

    const script = scriptedModel([
      toolOutput("record_note", noteArgs("out/one.txt", "первая", NOTE_KEY), "call-1"),
      toolOutput("record_note", noteArgs("out/two.txt", "другая", NOTE_KEY), "call-2"),
      textOutput("готово"),
    ]);
    const created = await queue.enqueue(enqueueInput("m2-note", { message: "запиши заметку" }));

    await withTempRoot(async (root) => {
      await drainOnce({
        runner: productRunner(root),
        model: script.model,
        tools: toolRegistry,
      });

      expect(await readFile(path.join(root, "out", "one.txt"), "utf8")).toBe("первая");
      await expect(stat(path.join(root, "out", "two.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await noteNames(root)).toEqual(["one.txt"]);
    });

    expect(script.inputs.map((input) => input.model)).toEqual([
      "agent",
      rule.model_alias,
      rule.model_alias,
    ]);
    const steps = await storedSteps(created.run.id);
    expect(steps.filter((step) => step.kind === "tool_result")).toEqual([
      expect.objectContaining({
        tool_name: "record_note",
        response_excerpt: "wrote out/one.txt",
        error: null,
      }),
      expect.objectContaining({
        tool_name: "record_note",
        response_excerpt: "wrote out/one.txt",
        error: null,
      }),
    ]);
    expect(steps.some((step) => step.kind === "policy_deny")).toBe(false);
    const row = await storedRun(created.run.id);
    expect(row.status).toBe("succeeded");
    expect(row.final_text).toBe("готово");
  });

  it("должен на следующем запуске того же хода выбрать внешний алиас после parse_error локальной модели", async () => {
    await applyRouteRules();
    const rule = await routeRule("second_parse_error");
    expect(rule).toEqual({ model_alias: "coder-cloud", provider: "external" });

    const raw = '{"name":"read_file","arguments":{"path":"secret.txt"}}';
    const local = scriptedModel([textOutput(raw)]);
    const failedRun = await queue.enqueue(enqueueInput("m2-parse-local", { message: SAME_TURN }));

    await withTempRoot(async (root) => {
      await drainOnce({
        runner: productRunner(root),
        model: local.model,
        tools: toolRegistry,
      });
    });

    expect(local.inputs.map((input) => input.model)).toEqual(["agent"]);
    const failed = await storedRun(failedRun.run.id);
    expect(failed.status).toBe("failed");
    expect(failed.final_text ?? "").toBe("");
    expect(failed.error).toBe("json_in_text");
    expect(failed.model_alias).toBe("agent");
    expect(failed.provider).toBe("local");
    const failedSteps = await storedSteps(failedRun.run.id);
    expect(
      failedSteps.some((step) => step.kind === "parse_error" && step.error === "json_in_text"),
    ).toBe(true);
    expect(
      failedSteps.some((step) => step.kind === "tool_call" || step.kind === "tool_result"),
    ).toBe(false);

    const external = scriptedModel([textOutput("готово")]);
    const nextRun = await queue.enqueue(enqueueInput("m2-parse-next", { message: SAME_TURN }));

    await withTempRoot(async (root) => {
      await drainOnce({
        runner: productRunner(root),
        model: external.model,
        tools: toolRegistry,
      });
    });

    expect(external.inputs.map((input) => input.model)).toEqual([rule.model_alias]);
    const escalated = await storedRun(nextRun.run.id);
    expect(escalated.status).toBe("succeeded");
    expect(escalated.model_alias).toBe(rule.model_alias);
    expect(escalated.provider).toBe("external");
    expect(escalated.final_text).toBe("готово");
    const nextSteps = await storedSteps(nextRun.run.id);
    expect(nextSteps[0]).toEqual(
      expect.objectContaining({
        kind: "model_request",
        request_excerpt: `${rule.model_alias}\n${SAME_TURN}`,
      }),
    );
  });

  it("должен выполнить крон script и не открывать ChatModel", async () => {
    const complete = vi
      .spyOn(LiteLLMChatModel.prototype, "complete")
      .mockRejectedValue(new Error("model opened"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const job = await createCronJob(sql, {
      tenantId: "local",
      agentId: AGENT_ID,
      kind: "script",
      schedule: "* * * * *",
      pauseChatId: 42n,
      command: ["echo", "cron-ok"],
    });

    const result = await tickCron({ sql, queue }, job.id, {
      delay() {
        return Promise.reject(new Error("script must not wait"));
      },
      nextJitterMs() {
        throw new Error("script must not jitter");
      },
    });

    expect(result).toEqual({ action: "script", exitCode: 0, notice: null });
    expect(complete).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await countRuns()).toBe(0);
  });
});

/**
 * I3: имя вне allowlist не исполняется.
 * Сид клерка разрешает только чтение. Строка harness_test получает record_note,
 * иначе приёмка не доходит до файла.
 */
async function allowRecordNote(): Promise<void> {
  await sql`
    update agents
    set tool_allowlist = array['read_file', 'list_dir', 'record_note']::text[]
    where id = ${AGENT_ID}
  `;
}

async function applyRouteRules(): Promise<void> {
  await sql.file(path.resolve(import.meta.dirname, "../../seed/route_rules.sql"));
}

interface RouteRule {
  model_alias: string;
  provider: string;
}

async function routeRule(kind: "write_tool" | "second_parse_error"): Promise<RouteRule> {
  const rows = await sql<RouteRule[]>`
    select model_alias, provider
    from route_rules
    where agent_id = ${AGENT_ID}
      and kind = ${kind}
  `;
  const row = rows[0];
  if (row === undefined || rows.length !== 1) {
    throw new Error("route rule is missing");
  }
  return row;
}

function productRunner(fileRoot: string): OpenAICompatRunner {
  return new OpenAICompatRunner({
    loadAgent(agentId: string) {
      return loadRunnerAgent(sql, agentId);
    },
    fileRoot,
    secrets: [TOKEN],
    sql,
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
    model: "reported",
  };
}

function toolOutput(name: string, args: string, id: string): ModelOutput {
  const call: ToolCall = { id, name, arguments: args };
  return {
    content: null,
    toolCalls: [call],
    promptTokens: 1,
    completionTokens: 1,
    model: "reported",
  };
}

function noteArgs(notePath: string, text: string, idempotencyKey: string): string {
  return JSON.stringify({
    path: notePath,
    text,
    idempotency_key: idempotencyKey,
  });
}

interface DrainOptions {
  runner: Runner;
  model: ChatModel;
  tools?: readonly Tool[];
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
    leaseSeconds: 30,
    heartbeatSeconds: 60,
    signal: controller.signal,
    sleep(): Promise<void> {
      controller.abort();
      return Promise.resolve();
    },
  };
  await runWorker(loop);
}

function enqueueInput(idempotencyKey: string, overrides: { message?: string }): EnqueueInput {
  return {
    tenantId: "local",
    agentId: AGENT_ID,
    source: "api",
    idempotencyKey,
    message: overrides.message ?? "привет",
    chatId: null,
  };
}

interface StoredRun {
  status: string;
  error: string | null;
  final_text: string | null;
  model_alias: string | null;
  provider: string | null;
}

async function storedRun(id: string): Promise<StoredRun> {
  const rows = await sql<StoredRun[]>`
    select status, error, final_text, model_alias, provider
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

async function noteNames(root: string): Promise<string[]> {
  const names = await readdir(path.join(root, "out"));
  const notes: string[] = [];
  for (const name of names) {
    if (name !== ".record-note") {
      notes.push(name);
    }
  }
  notes.sort();
  return notes;
}

async function withTempRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "harness-m2-acceptance-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
