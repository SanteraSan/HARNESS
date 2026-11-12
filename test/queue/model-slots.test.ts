import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { EnqueueInput } from "../../src/contracts/types.js";
import { loadConfig } from "../../src/config.js";
import { type Sql, createSql } from "../../src/db/client.js";
import { acquireModelSlot, createModelSlots, createRunQueue } from "../../src/queue/index.js";
import { sql } from "../helpers/db.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";

const queue = createRunQueue(sql);

describe("model slots", () => {
  it("должен захватить свободный слот и отпустить его без succeeded", async () => {
    await insertSlots([1]);
    const created = await queue.enqueue(enqueueInput("slot-ok", null));
    const claimed = mustClaim(await queue.claimNext("owner", 30));
    expect(claimed.id).toBe(created.run.id);

    const slots = createModelSlots(sql);
    expect(await slots.claim("owner", claimed.id, 30)).toBe(1);
    expect(await slots.heartbeat(1, "owner", claimed.id, 30)).toBe(true);
    expect(await slots.release(1, "owner", claimed.id)).toBe(true);

    const row = await slotRow(1);
    expect(row.locked_by).toBeNull();
    expect(row.run_id).toBeNull();
    expect(await runStatus(claimed.id)).toBe("running");
  });

  it("должен отказать чужому heartbeat и чужому отпусканию", async () => {
    await insertSlots([1]);
    await queue.enqueue(enqueueInput("slot-foreign", null));
    const claimed = mustClaim(await queue.claimNext("owner", 30));
    const slots = createModelSlots(sql);
    expect(await slots.claim("owner", claimed.id, 30)).toBe(1);
    await sql`
      update model_slots
      set locked_until = timestamptz '2020-01-01T00:00:00Z'
      where slot_index = 1
    `;

    expect(await slots.heartbeat(1, "intruder", claimed.id, 30)).toBe(false);
    expect(await slots.release(1, "intruder", claimed.id)).toBe(false);
    const held = await slotRow(1);
    expect(held.locked_by).toBe("owner");
    expect(held.locked_until?.toISOString()).toBe("2020-01-01T00:00:00.000Z");

    expect(await slots.heartbeat(1, "owner", claimed.id, 30)).toBe(true);
    const renewed = await slotRow(1);
    expect(renewed.locked_until).not.toBeNull();
    expect(renewed.locked_until?.toISOString()).not.toBe("2020-01-01T00:00:00.000Z");
    expect(await runStatus(claimed.id)).toBe("running");
  });

  it("должен двумя соединениями взять разные слоты, а третий захват оставить пустым", async () => {
    await insertSlots([1, 2]);
    await queue.enqueue(enqueueInput("slot-left", 11n));
    await queue.enqueue(enqueueInput("slot-right", 22n));
    const leftRun = mustClaim(await queue.claimNext("setup-left", 30));
    const rightRun = mustClaim(await queue.claimNext("setup-right", 30));

    await withTwoConnections(async (left, right) => {
      const [slotLeft, slotRight] = await Promise.all([
        createModelSlots(left).claim("left-worker", leftRun.id, 30),
        createModelSlots(right).claim("right-worker", rightRun.id, 30),
      ]);
      expect(slotLeft).not.toBeNull();
      expect(slotRight).not.toBeNull();
      expect(slotLeft).not.toBe(slotRight);
      expect(new Set([slotLeft, slotRight])).toEqual(new Set([1, 2]));
    });

    expect(await createModelSlots(sql).claim("third-worker", leftRun.id, 30)).toBeNull();
  });

  it("должен пропустить слот, залоченный другим соединением", async () => {
    await insertSlots([1, 2]);
    await queue.enqueue(enqueueInput("slot-held", null));
    const claimed = mustClaim(await queue.claimNext("setup", 30));

    await withTwoConnections(async (hold, worker) => {
      const workerSlots = createModelSlots(worker);
      await hold.begin(async (tx) => {
        await tx`select slot_index from model_slots where slot_index = 1 for update`;
        expect(await workerSlots.claim("worker-b", claimed.id, 30)).toBe(2);
      });
    });

    const first = await slotRow(1);
    expect(first.locked_by).toBeNull();
    const second = await slotRow(2);
    expect(second.locked_by).toBe("worker-b");
  });

  it("должен вернуть слот после потери лока запуска и не ставить succeeded", async () => {
    await insertSlots([1]);
    await queue.enqueue(enqueueInput("owner-run", 43n));
    const owned = mustClaim(await queue.claimNext("owner", 30));
    await queue.enqueue(enqueueInput("waiter-run", 44n));
    const waiter = mustClaim(await queue.claimNext("waiter", 30));
    const slots = createModelSlots(sql);
    expect(await slots.claim("owner", owned.id, 30)).toBe(1);

    await sql`
      update model_slots
      set locked_until = now() - interval '1 second'
      where slot_index = 1
    `;
    await sql`
      update runs
      set locked_until = now() - interval '1 second'
      where id = ${owned.id}
    `;

    expect(await slots.reapExpired()).toBe(1);
    expect(await runStatus(owned.id)).toBe("running");
    expect(await slots.claim("waiter", waiter.id, 30)).toBe(1);
    expect(await runStatus(owned.id)).not.toBe("succeeded");
  });

  it("должен не отдавать просроченный слот, пока лок запуска жив", async () => {
    await insertSlots([1]);
    await queue.enqueue(enqueueInput("live-owner", 54n));
    const owned = mustClaim(await queue.claimNext("owner", 120));
    await queue.enqueue(enqueueInput("live-waiter", 55n));
    const waiter = mustClaim(await queue.claimNext("waiter", 120));
    const slots = createModelSlots(sql);
    expect(await slots.claim("owner", owned.id, 120)).toBe(1);
    await sql`
      update model_slots
      set locked_until = now() - interval '1 second'
      where slot_index = 1
    `;

    expect(await slots.reapExpired()).toBe(0);
    expect(await slots.claim("waiter", waiter.id, 30)).toBeNull();
    const row = await slotRow(1);
    expect(row.locked_by).toBe("owner");
    expect(row.run_id).toBe(owned.id);
    expect(await runStatus(owned.id)).toBe("running");
  });

  it("должен в цикле ожидания снять слот мёртвого владельца до модели", async () => {
    await insertSlots([1]);
    await queue.enqueue(enqueueInput("dead-owner", 65n));
    const owned = mustClaim(await queue.claimNext("owner", 30));
    await queue.enqueue(enqueueInput("wait-run", 66n));
    const waiter = mustClaim(await queue.claimNext("waiter", 30));
    const slots = createModelSlots(sql);
    expect(await slots.claim("owner", owned.id, 30)).toBe(1);
    await sql`
      update model_slots
      set locked_until = now() - interval '1 second'
      where slot_index = 1
    `;
    await sql`
      update runs
      set locked_until = now() - interval '1 second'
      where id = ${owned.id}
    `;

    let slept = false;
    const acquired = await acquireModelSlot({
      slots,
      workerId: "waiter",
      runId: waiter.id,
      leaseSeconds: 30,
      signal: new AbortController().signal,
      sleep: () => {
        slept = true;
        return Promise.resolve();
      },
      heartbeatRun: (runId, workerId, leaseSeconds) =>
        queue.heartbeat(runId, workerId, leaseSeconds),
    });

    expect(acquired).toEqual({ slotIndex: 1 });
    expect(slept).toBe(false);
    expect(await runStatus(owned.id)).toBe("running");
    expect(await runStatus(owned.id)).not.toBe("succeeded");
  });

  it("должен не занимать второй слот вторым запуском того же чата", async () => {
    await insertSlots([1, 2]);
    const chatId = 424242n;
    const first = await queue.enqueue(enqueueInput("same-chat-1", chatId));
    expect(first.created).toBe(true);
    const claimed = mustClaim(await queue.claimNext("worker-a", 30));
    const slots = createModelSlots(sql);
    expect(await slots.claim("worker-a", claimed.id, 30)).toBe(1);

    const again = await queue.enqueue(enqueueInput("same-chat-2", chatId));
    expect(again.created).toBe(false);
    expect(again.reason).toBe("dialog_busy");
    expect(again.run.id).toBe(first.run.id);
    expect(await lockedSlotCount()).toBe(1);

    const other = await queue.enqueue(enqueueInput("other-chat", 424243n));
    expect(other.created).toBe(true);
    const otherRun = mustClaim(await queue.claimNext("worker-b", 30));
    expect(otherRun.id).toBe(other.run.id);
    expect(await slots.claim("worker-b", otherRun.id, 30)).toBe(2);
  });

  it("должен держать в захвате один for update skip locked и не читать имя модели", async () => {
    const source = await readFile("src/queue/model-slots.ts", "utf8");
    expect(source.match(/for update skip locked/g)).toHaveLength(1);
    expect(source.includes("num_parallel")).toBe(false);
    expect(source.toLowerCase().includes("qwen")).toBe(false);
    expect(source.toLowerCase().includes("ollama")).toBe(false);
    await insertSlots([1]);
    expect(await createModelSlots(sql).count()).toBe(1);
  });
});

function enqueueInput(idempotencyKey: string, chatId: bigint | null): EnqueueInput {
  return {
    tenantId: "local",
    agentId: AGENT_ID,
    source: "api",
    idempotencyKey,
    message: "привет",
    chatId,
  };
}

async function insertSlots(indexes: readonly number[]): Promise<void> {
  for (const slotIndex of indexes) {
    await sql`
      insert into model_slots (slot_index)
      values (${slotIndex})
    `;
  }
}

function mustClaim<T>(value: T | null): T {
  if (value === null) {
    throw new Error("claim is missing");
  }
  return value;
}

async function slotRow(slotIndex: number): Promise<{
  locked_by: string | null;
  locked_until: Date | null;
  run_id: string | null;
}> {
  const rows = await sql<
    {
      locked_by: string | null;
      locked_until: Date | null;
      run_id: string | null;
    }[]
  >`
    select locked_by, locked_until, run_id
    from model_slots
    where slot_index = ${slotIndex}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("slot is missing");
  }
  return row;
}

async function runStatus(id: string): Promise<string> {
  const rows = await sql<{ status: string }[]>`
    select status from runs where id = ${id}
  `;
  const status = rows[0]?.status;
  if (status === undefined) {
    throw new Error("run is missing");
  }
  return status;
}

async function lockedSlotCount(): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    select count(*)::int as count from model_slots where locked_by is not null
  `;
  const count = rows[0]?.count;
  if (count === undefined) {
    throw new Error("count is missing");
  }
  return count;
}

async function withTwoConnections(body: (left: Sql, right: Sql) => Promise<void>): Promise<void> {
  const databaseUrl = loadConfig().harnessTestDatabaseUrl;
  if (databaseUrl === null) {
    throw new Error("HARNESS_TEST_DATABASE_URL is required");
  }
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
