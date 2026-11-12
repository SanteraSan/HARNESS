import { describe, expect, it } from "vitest";

import type { ModelOutput, ModelToolSpec, RunnerContext } from "../../src/contracts/types.js";
import { createRunJournal } from "../../src/journal/index.js";
import { createModelSlots, createRunQueue } from "../../src/queue/index.js";
import { OpenAICompatRunner } from "../../src/runner/index.js";
import type { ServiceCatalog } from "../../src/services/catalog.js";
import { toolRegistry } from "../../src/tools/index.js";
import { loadRunnerAgent } from "../../src/worker.js";
import { sql } from "../helpers/db.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const WORKER_ID = "worker-slots";

const queue = createRunQueue(sql);
const journal = createRunJournal(sql, []);

describe("model slot turn", () => {
  it("должен отпустить слот до HTTP сервиса и записать успешный ответ", async () => {
    await insertSlot();
    const created = await enqueue("turn-ok");
    const claimed = mustClaim(await queue.claimNext(WORKER_ID, 30));
    expect(claimed.id).toBe(created.run.id);

    const marks: string[] = [];
    const script: ModelOutput[] = [
      {
        content: null,
        toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
        promptTokens: 1,
        completionTokens: 1,
        model: "agent",
      },
      {
        content: "готово",
        toolCalls: [],
        promptTokens: 2,
        completionTokens: 3,
        model: "agent",
      },
    ];
    const services: ServiceCatalog = {
      has: (name) => name === "read_file",
      modelTools: (): ModelToolSpec[] => [
        { name: "read_file", description: "read", parameters: { type: "object", properties: {} } },
      ],
      execute: async () => {
        const row = await slotLock();
        expect(row.locked_by).toBeNull();
        marks.push("service");
        return { lockLost: false, text: "файл", error: null, requestExcerpt: "read_file" };
      },
    };
    const runner = new OpenAICompatRunner({
      loadAgent: () => loadRunnerAgent(sql, AGENT_ID),
      fileRoot: "./workspace",
      secrets: [],
      services,
    });
    runner.assignModelTurn({
      slots: createModelSlots(sql),
      heartbeatSeconds: 3600,
      signal: new AbortController().signal,
      sleep: () => Promise.reject(new Error("slot wait must not run")),
    });

    await runner.run(
      claimed,
      context({
        complete: async () => {
          const row = await slotLock();
          expect(row.locked_by).toBe(WORKER_ID);
          expect(row.run_id).toBe(claimed.id);
          marks.push("model");
          const output = script.shift();
          if (output === undefined) {
            throw new Error("model script exhausted");
          }
          return output;
        },
      }),
    );

    expect(marks).toEqual(["model", "service", "model"]);
    const stored = await storedRun(claimed.id);
    expect(stored.status).toBe("succeeded");
    expect(stored.final_text).toBe("готово");
    expect(stored.error).toBeNull();
    expect((await slotLock()).locked_by).toBeNull();
  });

  it("должен отпустить слот, если вызов модели упал, и не ставить succeeded", async () => {
    await insertSlot();
    const created = await enqueue("turn-fail");
    const claimed = mustClaim(await queue.claimNext(WORKER_ID, 30));
    expect(claimed.id).toBe(created.run.id);
    let finished = false;
    const runner = new OpenAICompatRunner({
      loadAgent: () => loadRunnerAgent(sql, AGENT_ID),
      fileRoot: "./workspace",
      secrets: [],
    });
    runner.assignModelTurn({
      slots: createModelSlots(sql),
      heartbeatSeconds: 3600,
      signal: new AbortController().signal,
      sleep: () => Promise.reject(new Error("slot wait must not run")),
    });

    await expect(
      runner.run(
        claimed,
        context({
          complete: () => Promise.reject(new Error("model down")),
          finish: () => {
            finished = true;
            return Promise.resolve(true);
          },
        }),
      ),
    ).rejects.toThrow("model down");

    expect(finished).toBe(false);
    expect((await slotLock()).locked_by).toBeNull();
    expect((await storedRun(claimed.id)).status).toBe("running");
  });

  it("должен записать slot_lost и не класть текст ответа в succeeded", async () => {
    await insertSlot();
    const created = await enqueue("turn-lost");
    const claimed = mustClaim(await queue.claimNext(WORKER_ID, 30));
    expect(claimed.id).toBe(created.run.id);
    const runner = new OpenAICompatRunner({
      loadAgent: () => loadRunnerAgent(sql, AGENT_ID),
      fileRoot: "./workspace",
      secrets: [],
    });
    runner.assignModelTurn({
      slots: createModelSlots(sql),
      heartbeatSeconds: 3600,
      signal: new AbortController().signal,
      sleep: () => Promise.reject(new Error("slot wait must not run")),
    });

    await runner.run(
      claimed,
      context({
        complete: async () => {
          await sql`
          update model_slots
          set locked_by = null, locked_until = null, run_id = null
          where slot_index = 1
        `;
          return {
            content: "не-успех",
            toolCalls: [],
            promptTokens: 4,
            completionTokens: 4,
            model: "agent",
          };
        },
      }),
    );

    const stored = await storedRun(claimed.id);
    expect(stored.status).toBe("failed");
    expect(stored.error).toBe("slot_lost");
    expect(stored.final_text).toBeNull();
    expect(stored.final_text).not.toBe("не-успех");
  });
});

function enqueue(idempotencyKey: string) {
  return queue.enqueue({
    tenantId: "local",
    agentId: AGENT_ID,
    source: "api",
    idempotencyKey,
    message: "прочитай",
    chatId: null,
  });
}

async function insertSlot(): Promise<void> {
  await sql`insert into model_slots (slot_index) values (1)`;
}

function context(patch: {
  complete: RunnerContext["model"]["complete"];
  finish?: RunnerContext["finish"];
}): RunnerContext {
  return {
    workerId: WORKER_ID,
    leaseSeconds: 30,
    tools: toolRegistry,
    model: { complete: patch.complete },
    heartbeat: (runId, workerId, leaseSeconds) => queue.heartbeat(runId, workerId, leaseSeconds),
    finish: patch.finish ?? ((runId, workerId, outcome) => queue.finish(runId, workerId, outcome)),
    appendStep: (step) => journal.appendStep(step),
  };
}

function mustClaim<T>(value: T | null): T {
  if (value === null) {
    throw new Error("claim is missing");
  }
  return value;
}

async function slotLock(): Promise<{ locked_by: string | null; run_id: string | null }> {
  const rows = await sql<{ locked_by: string | null; run_id: string | null }[]>`
    select locked_by, run_id from model_slots where slot_index = 1
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("slot is missing");
  }
  return row;
}

async function storedRun(id: string): Promise<{
  status: string;
  final_text: string | null;
  error: string | null;
}> {
  const rows = await sql<
    {
      status: string;
      final_text: string | null;
      error: string | null;
    }[]
  >`
    select status, final_text, error from runs where id = ${id}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("run is missing");
  }
  return row;
}
