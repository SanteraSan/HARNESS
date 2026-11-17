import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  ChatModel,
  ModelInput,
  ModelOutput,
  Tool,
  ToolCall,
} from "../../src/contracts/index.js";
import { createRunJournal } from "../../src/journal/index.js";
import { createRunQueue } from "../../src/queue/index.js";
import { OpenAICompatRunner } from "../../src/runner/index.js";
import { loadRunnerAgent } from "../../src/worker.js";
import { sql } from "../helpers/db.js";

const CLERK_ID = "00000000-0000-4000-8000-000000000001";
const WORKER_ID = "worker-route";
const FILE_ROOT = path.join(tmpdir(), "harness-route-fixture");

describe("route run", () => {
  it("должен оставить ход чтения на agent / local и записать cost_usd = 0", async () => {
    await applyRouteRules();
    const model = scripted([textOutput("заметка прочитана")]);
    const runId = await execute("прочитай заметку", model, []);

    expect(model.inputs.map((input) => input.model)).toEqual(["agent"]);
    const run = await storedRun(runId);
    expect(run).toMatchObject({
      status: "succeeded",
      model_alias: "agent",
      provider: "local",
      final_text: "заметка прочитана",
    });
    const steps = await storedSteps(runId);
    expect(steps.map((step) => step.kind)).toEqual(["model_request", "final"]);
    expect(steps[0]?.request_excerpt).toBe("agent\nпрочитай заметку");
    for (const step of steps) {
      expectCost(step.cost_usd, 0);
    }
  });

  it("должен не менять алиас, если имя write нет в allowlist", async () => {
    await applyRouteRules();
    let executed = false;
    const writeTool: Tool = {
      name: "record_note",
      description: "Учебная запись",
      effect: "write",
      parameters: z.object({}),
      execute() {
        executed = true;
        return Promise.resolve({ ok: true, text: "записано", truncated: false, entries: null });
      },
    };
    const model = scripted([
      toolOutput([{ id: "call-w", name: "record_note", arguments: "{}" }]),
      textOutput("записал", 0.5),
    ]);

    const runId = await execute("запиши заметку", model, [writeTool]);

    expect(executed).toBe(false);
    expect(model.inputs.map((input) => input.model)).toEqual(["agent", "agent"]);
    const run = await storedRun(runId);
    expect(run).toMatchObject({
      status: "succeeded",
      model_alias: "agent",
      provider: "local",
      final_text: "записал",
    });
    const steps = await storedSteps(runId);
    expect(steps.some((step) => step.kind === "policy_deny")).toBe(true);
    for (const input of model.inputs) {
      expect(input.model).not.toBe("coder-cloud");
    }
  });

  it("должен увести разрешённый write на coder-cloud без результатов инструментов", async () => {
    await applyRouteRules();
    await sql`
      update agents
      set tool_allowlist = array['read_file', 'list_dir', 'record_note']::text[]
      where id = ${CLERK_ID}
    `;
    let executed = false;
    const readTool: Tool = {
      name: "read_file",
      description: "Чтение",
      effect: "read",
      parameters: z.object({}),
      execute() {
        return Promise.resolve({
          ok: true,
          text: "FILE-SECRET-BODY",
          truncated: false,
          entries: null,
        });
      },
    };
    const writeTool: Tool = {
      name: "record_note",
      description: "Учебная запись",
      effect: "write",
      parameters: z.object({}),
      execute() {
        executed = true;
        return Promise.resolve({ ok: true, text: "записано", truncated: false, entries: null });
      },
    };
    const model = scripted([
      toolOutput([{ id: "call-r", name: "read_file", arguments: "{}" }]),
      toolOutput([{ id: "call-w", name: "record_note", arguments: "{}" }]),
      textOutput("записал", 0.5),
    ]);

    const runId = await execute("запиши заметку", model, [readTool, writeTool]);

    expect(executed).toBe(true);
    expect(model.inputs.map((input) => input.model)).toEqual(["agent", "agent", "coder-cloud"]);
    const external = model.inputs[2];
    expect(external?.tools).toEqual([]);
    expect(external?.messages.some((message) => message.role === "tool")).toBe(false);
    expect(JSON.stringify(external?.messages)).not.toContain("FILE-SECRET-BODY");
    const run = await storedRun(runId);
    expect(run).toMatchObject({
      status: "succeeded",
      model_alias: "coder-cloud",
      provider: "external",
      final_text: "записал",
    });
    const steps = await storedSteps(runId);
    const requests = steps.filter((step) => step.kind === "model_request");
    expectCost(requests[2]?.cost_usd ?? null, 0.5);
  });

  it("должен оставить первый parse_error локальным, а следующий запуск того же хода увести на внешний алиас", async () => {
    await applyRouteRules();
    const first = scripted([textOutput(null)]);
    const firstId = await execute("повтори ход", first, []);

    expect(first.inputs.map((input) => input.model)).toEqual(["agent"]);
    const failed = await storedRun(firstId);
    expect(failed).toMatchObject({
      status: "failed",
      model_alias: "agent",
      provider: "local",
      error: "empty",
      final_text: null,
    });
    const failedSteps = await storedSteps(firstId);
    expect(failedSteps.some((step) => step.kind === "parse_error")).toBe(true);
    for (const step of failedSteps) {
      expectCost(step.cost_usd, 0);
    }

    const second = scripted([textOutput("готово")]);
    const secondId = await execute("повтори ход", second, []);

    expect(second.inputs.map((input) => input.model)).toEqual(["coder-cloud"]);
    expect(second.inputs[0]?.tools).toEqual([]);
    const escalated = await storedRun(secondId);
    expect(escalated).toMatchObject({
      status: "succeeded",
      model_alias: "coder-cloud",
      provider: "external",
      final_text: "готово",
    });
    const escalatedSteps = await storedSteps(secondId);
    expect(escalatedSteps.length).toBeGreaterThan(0);
    expect(escalatedSteps[0]?.request_excerpt).toBe("coder-cloud\nповтори ход");
    for (const step of escalatedSteps) {
      expect(step.cost_usd).toBeNull();
    }
  });
});

function scripted(outputs: readonly ModelOutput[]): ChatModel & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  return {
    inputs,
    complete(input: ModelInput): Promise<ModelOutput> {
      const next = outputs[inputs.length];
      inputs.push({
        model: input.model,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        tools: input.tools.map((tool) => ({ ...tool })),
        messages: input.messages.map((message) => ({
          role: message.role,
          content: message.content,
          toolCallId: message.toolCallId,
          toolCalls: message.toolCalls === null ? null : message.toolCalls.map((call) => ({ ...call })),
        })),
      });
      if (next === undefined) {
        return Promise.reject(new Error("model script exhausted"));
      }
      return Promise.resolve(next);
    },
  };
}

async function execute(
  message: string,
  model: ChatModel,
  tools: readonly Tool[],
): Promise<string> {
  const queue = createRunQueue(sql);
  const journal = createRunJournal(sql, []);
  const enqueued = await queue.enqueue({
    tenantId: "local",
    agentId: CLERK_ID,
    source: "api",
    idempotencyKey: `route-${randomUUID()}`,
    message,
    chatId: null,
  });
  const claimed = await queue.claimNext(WORKER_ID, 120);
  if (claimed === null || claimed.id !== enqueued.run.id) {
    throw new Error("claim did not take the enqueued run");
  }

  const runner = new OpenAICompatRunner({
    loadAgent(agentId: string) {
      return loadRunnerAgent(sql, agentId);
    },
    fileRoot: FILE_ROOT,
    secrets: [],
    sql,
  });
  await runner.run(claimed, {
    workerId: WORKER_ID,
    leaseSeconds: 120,
    model,
    tools,
    heartbeat(runId, workerId, leaseSeconds) {
      return queue.heartbeat(runId, workerId, leaseSeconds);
    },
    finish(runId, workerId, outcome) {
      return queue.finish(runId, workerId, outcome);
    },
    appendStep(step) {
      return journal.appendStep(step);
    },
  });
  return claimed.id;
}

async function applyRouteRules(): Promise<void> {
  await sql.file(path.resolve(import.meta.dirname, "../../seed/route_rules.sql"));
}

interface StoredRun {
  status: string;
  model_alias: string | null;
  provider: string | null;
  error: string | null;
  final_text: string | null;
}

async function storedRun(runId: string): Promise<StoredRun> {
  const rows = await sql<StoredRun[]>`
    select status, model_alias, provider, error, final_text
    from runs
    where id = ${runId}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("run was not stored");
  }
  return row;
}

interface StoredStep {
  kind: string;
  request_excerpt: string | null;
  cost_usd: string | null;
}

async function storedSteps(runId: string): Promise<StoredStep[]> {
  return sql<StoredStep[]>`
    select kind, request_excerpt, cost_usd::text as cost_usd
    from run_steps
    where run_id = ${runId}
    order by step_index asc
  `;
}

function expectCost(value: string | null, expected: number): void {
  expect(value).not.toBeNull();
  expect(Number(value)).toBe(expected);
}

function textOutput(content: string | null, costUsd?: number): ModelOutput {
  const output: ModelOutput = {
    content,
    toolCalls: [],
    promptTokens: 1,
    completionTokens: 1,
    model: "reported",
  };
  if (costUsd !== undefined) {
    output.costUsd = costUsd;
  }
  return output;
}

function toolOutput(calls: readonly ToolCall[]): ModelOutput {
  return {
    content: null,
    toolCalls: calls,
    promptTokens: 1,
    completionTokens: 1,
    model: "reported",
  };
}
