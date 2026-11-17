import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { RunQueue } from "../../src/contracts/types.js";
import { createRunJournal } from "../../src/journal/index.js";
import { createModelSlots, createRunQueue } from "../../src/queue/index.js";
import { toolRegistry } from "../../src/tools/index.js";
import { assertModelSlotCount, runReadyWorker, type WorkerLoopOptions } from "../../src/worker.js";
import { sql } from "../helpers/db.js";

const WORKER_ID = "worker-slots";

describe("worker model slots", () => {
  it("должен пустить проверку, когда строк столько, сколько MODEL_SLOTS", async () => {
    await sql`insert into model_slots (slot_index) values (1)`;
    await expect(assertModelSlotCount(createModelSlots(sql), 1)).resolves.toBeUndefined();
  });

  it("должен не пускать цикл захвата, если MODEL_SLOTS больше числа строк", async () => {
    await sql`insert into model_slots (slot_index) values (1)`;
    const claims: string[] = [];
    const real = createRunQueue(sql);
    const queue: RunQueue = {
      enqueue: (input) => real.enqueue(input),
      claimNext: async (workerId, leaseSeconds) => {
        claims.push(workerId);
        return real.claimNext(workerId, leaseSeconds);
      },
      heartbeat: (runId, workerId, leaseSeconds) => real.heartbeat(runId, workerId, leaseSeconds),
      reapExpired: () => real.reapExpired(),
      finish: (runId, workerId, outcome) => real.finish(runId, workerId, outcome),
    };
    const slots = createModelSlots(sql);

    await expect(runReadyWorker(options(queue), { slots, modelSlots: 2 })).rejects.toMatchObject({
      name: "WorkerError",
      code: "model_slots_mismatch",
    });

    expect(claims).toEqual([]);
    try {
      await assertModelSlotCount(slots, 2);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).not.toContain("postgres://");
        expect(error.message).not.toContain("DATABASE_URL");
      }
    }
  });

  it("должен не порождать процессы и не ставить succeeded из обработчика сигнала", async () => {
    const source = await readFile("src/worker.ts", "utf8");
    expect(source.match(/claimNext\(/g)).toHaveLength(1);
    expect(source.includes("child_process")).toBe(false);
    expect(source.includes("worker_threads")).toBe(false);
    expect(source.includes("num_parallel")).toBe(false);
    const start = source.indexOf("export function bindWorkerSignals");
    const end = source.indexOf("async function runIteration");
    const body = source.slice(start, end);
    expect(body.includes(".finish(")).toBe(false);
    expect(body.includes("succeeded")).toBe(false);
  });
});

function options(queue: RunQueue): WorkerLoopOptions {
  return {
    queue,
    runner: {
      run: () => Promise.reject(new Error("runner must not start")),
    },
    journal: createRunJournal(sql, []),
    model: {
      complete: () => Promise.reject(new Error("model must not start")),
    },
    tools: toolRegistry,
    workerId: WORKER_ID,
    leaseSeconds: 30,
    heartbeatSeconds: 15,
    signal: AbortSignal.abort(),
  };
}
