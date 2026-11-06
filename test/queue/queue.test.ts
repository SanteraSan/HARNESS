import { describe, expect, it } from "vitest";

import type { ClaimedRun, EnqueueInput, FinishOutcome } from "../../src/contracts/types.js";
import { loadConfig } from "../../src/config.js";
import { type Sql, createSql } from "../../src/db/client.js";
import { createRunQueue } from "../../src/queue/index.js";
import { sql } from "../helpers/db.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const BIG_CHAT_ID = 1234567890123456789n;

const queue = createRunQueue(sql);

describe("RunQueue", () => {
  it("должен вернуть первую строку и не создавать вторую при повторе ключа", async () => {
    const key = "key'); delete from runs; --";
    const message = "первый'; drop table runs; --";
    const first = await queue.enqueue(enqueueInput(key, BIG_CHAT_ID, { message }));

    expect(first.created).toBe(true);
    expect(first.reason).toBe("created");
    expect(first.run.status).toBe("queued");
    expect(first.run.attempt).toBe(0);
    expect(first.run.maxAttempts).toBe(3);
    expect(first.run.priority).toBe(100);
    expect(first.run.source).toBe("api");
    expect(first.run.tenantId).toBe("local");
    expect(first.run.agentId).toBe(AGENT_ID);
    expect(first.run.parentRunId).toBeNull();
    expect(first.run.notBefore).toBeNull();
    expect(first.run.deadlineAt).toBeNull();
    expect(first.run.chatId).toBe(BIG_CHAT_ID);
    expect(typeof first.run.chatId).toBe("bigint");
    expect(first.run.payload).toEqual({ message });
    expect(first.run.modelAlias).toBeNull();
    expect(first.run.provider).toBeNull();
    expect(first.run.lockedBy).toBeNull();
    expect(first.run.lockedUntil).toBeNull();
    expect(first.run.startedAt).toBeNull();
    expect(first.run.finishedAt).toBeNull();
    expect(first.run.finalText).toBeNull();
    expect(first.run.error).toBeNull();
    expect(first.run.promptTokens).toBeNull();
    expect(first.run.completionTokens).toBeNull();

    const stored = await storedRun(first.run.id);
    expect(stored.chat_id).toBe("1234567890123456789");
    expect(typeof stored.chat_id).toBe("string");

    const second = await queue.enqueue(enqueueInput(key, 1n, { message: "второй", priority: 1 }));
    expect(second.created).toBe(false);
    expect(second.reason).toBe("replay");
    expect(second.run.id).toBe(first.run.id);
    expect(second.run.chatId).toBe(BIG_CHAT_ID);
    expect(second.run.payload.message).toBe(message);
    expect(second.run.priority).toBe(100);
    expect(await countRuns()).toBe(1);
    expect(await countAgents()).toBe(1);
  });

  it("должен вернуть dialog_busy и не создавать строку при живом chat_id", async () => {
    const chatId = 4242n;
    const first = await queue.enqueue(enqueueInput("dialog-1", chatId, { message: "один" }));
    expect(first.created).toBe(true);
    expect(first.reason).toBe("created");

    const queued = await queue.enqueue(enqueueInput("dialog-2", chatId, { message: "два" }));
    expect(queued.created).toBe(false);
    expect(queued.reason).toBe("dialog_busy");
    expect(queued.run.id).toBe(first.run.id);
    expect(queued.run.payload.message).toBe("один");
    expect(queued.run.chatId).toBe(chatId);
    expect(await countRuns()).toBe(1);

    const claimed = mustClaim(await queue.claimNext("worker-a", 30));
    expect(claimed.id).toBe(first.run.id);
    const running = await queue.enqueue(enqueueInput("dialog-3", chatId, { message: "три" }));
    expect(running.created).toBe(false);
    expect(running.reason).toBe("dialog_busy");
    expect(running.run.id).toBe(first.run.id);
    expect(await countRuns()).toBe(1);
  });

  it("должен создать новый запуск с тем же chat_id после succeeded", async () => {
    const chatId = 5252n;
    const first = await queue.enqueue(enqueueInput("done-1", chatId));
    const claimed = mustClaim(await queue.claimNext("worker-a", 30));
    expect(await queue.finish(claimed.id, "worker-a", succeeded("готово"))).toBe(true);

    const second = await queue.enqueue(enqueueInput("done-2", chatId, { message: "снова" }));
    expect(second.created).toBe(true);
    expect(second.reason).toBe("created");
    expect(second.run.id).not.toBe(first.run.id);
    expect(second.run.chatId).toBe(chatId);
    expect(await countRuns()).toBe(2);
  });

  it("должен создать два API-запуска с chat_id = null и разными ключами", async () => {
    const first = await queue.enqueue(enqueueInput("api-1", null, { message: "a" }));
    const second = await queue.enqueue(enqueueInput("api-2", null, { message: "b" }));

    expect(first.created).toBe(true);
    expect(first.reason).toBe("created");
    expect(second.created).toBe(true);
    expect(second.reason).toBe("created");
    expect(first.run.id).not.toBe(second.run.id);
    expect(first.run.chatId).toBeNull();
    expect(second.run.chatId).toBeNull();
    expect(first.run.source).toBe("api");
    expect(second.run.source).toBe("api");
    expect(await countRuns()).toBe(2);
  });

  it("должен создать запуск с тем же chat_id у другого агента", async () => {
    const otherAgentId = "00000000-0000-4000-8000-000000000002";
    await sql`
      insert into agents (
        id,
        tenant_id,
        slug,
        display_name,
        system_prompt,
        model_alias,
        provider,
        max_steps,
        tool_allowlist
      ) values (
        ${otherAgentId},
        'local',
        'other',
        'Другой',
        'prompt',
        'agent',
        'local',
        8,
        array['read_file', 'list_dir']::text[]
      )
    `;

    const chatId = 99n;
    const first = await queue.enqueue(enqueueInput("same-chat-a", chatId));
    const second = await queue.enqueue(
      enqueueInput("same-chat-b", chatId, { agentId: otherAgentId }),
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.run.agentId).toBe(otherAgentId);
    expect(second.run.chatId).toBe(chatId);
    expect(await countRuns()).toBe(2);
  });

  it("должен сохранить source telegram", async () => {
    const created = await queue.enqueue({
      ...enqueueInput("tg-1", 77n),
      source: "telegram",
    });
    expect(created.created).toBe(true);
    expect(created.reason).toBe("created");
    expect(created.run.source).toBe("telegram");
    expect(created.run.chatId).toBe(77n);
  });

  it("должен отдать двум соединениям две разные строки", async () => {
    const first = await queue.enqueue(enqueueInput("par-1", null));
    const second = await queue.enqueue(enqueueInput("par-2", null));

    await withTwoConnections(async (left, right) => {
      const [claimLeft, claimRight] = await Promise.all([
        createRunQueue(left).claimNext("left-worker", 30),
        createRunQueue(right).claimNext("right-worker", 30),
      ]);
      const leftRun = mustClaim(claimLeft);
      const rightRun = mustClaim(claimRight);
      expect(leftRun.id).not.toBe(rightRun.id);
      expect(leftRun.lockedBy).toBe("left-worker");
      expect(rightRun.lockedBy).toBe("right-worker");
      expect(leftRun.status).toBe("running");
      expect(rightRun.status).toBe("running");
      expect(new Set([leftRun.id, rightRun.id])).toEqual(new Set([first.run.id, second.run.id]));
    });

    expect(await queue.claimNext("late-worker", 30)).toBeNull();
  });

  it("должен пропустить строку, залоченную другим соединением", async () => {
    const hot = await queue.enqueue(enqueueInput("hot", null, { priority: 1 }));
    const cold = await queue.enqueue(enqueueInput("cold", null, { priority: 100 }));

    // Чужое соединение держит строку с лучшим priority: захват не ждёт её.
    await withTwoConnections(async (hold, worker) => {
      const workerQueue = createRunQueue(worker);
      await hold.begin(async (tx) => {
        await tx`select id from runs where id = ${hot.run.id} for update`;
        const claimed = mustClaim(await workerQueue.claimNext("worker-b", 30));
        expect(claimed.id).toBe(cold.run.id);
        expect(claimed.lockedBy).toBe("worker-b");
      });
    });

    expect((await storedRun(hot.run.id)).status).toBe("queued");
    expect((await storedRun(hot.run.id)).attempt).toBe(0);
    expect((await storedRun(cold.run.id)).status).toBe("running");
    expect((await storedRun(cold.run.id)).locked_by).toBe("worker-b");

    const released = mustClaim(await queue.claimNext("worker-a", 30));
    expect(released.id).toBe(hot.run.id);
    expect(released.attempt).toBe(1);
  });

  it("должен захватывать меньший priority раньше, а при равном — более ранний created_at", async () => {
    const leaseSeconds = 30;
    const low = await queue.enqueue(enqueueInput("low", null, { priority: 0 }));
    const early = await queue.enqueue(enqueueInput("early", null, { priority: 50 }));
    const late = await queue.enqueue(enqueueInput("late", null, { priority: 50 }));
    await setCreatedAt(low.run.id, new Date("2026-06-01T00:00:03Z"));
    await setCreatedAt(early.run.id, new Date("2026-06-01T00:00:01Z"));
    await setCreatedAt(late.run.id, new Date("2026-06-01T00:00:02Z"));

    const first = mustClaim(await queue.claimNext("worker-a", leaseSeconds));
    const second = mustClaim(await queue.claimNext("worker-a", leaseSeconds));
    const third = mustClaim(await queue.claimNext("worker-a", leaseSeconds));
    expect(first.id).toBe(low.run.id);
    expect(second.id).toBe(early.run.id);
    expect(third.id).toBe(late.run.id);
    expect(first.attempt).toBe(1);
    expect(first.status).toBe("running");
    expect(first.lockedBy).toBe("worker-a");
    expect(first.lockedUntil).toBeInstanceOf(Date);
    expect((await storedRun(low.run.id)).priority).toBe(0);
    expect(await queue.claimNext("worker-a", leaseSeconds)).toBeNull();

    const window = await sql<{ in_future: boolean; within_lease: boolean }[]>`
      select
        locked_until > now() as in_future,
        extract(epoch from (locked_until - now())) > 0
          and extract(epoch from (locked_until - now())) <= ${leaseSeconds} as within_lease
      from runs
      where id = ${first.id}
    `;
    expect(window[0]?.in_future).toBe(true);
    expect(window[0]?.within_lease).toBe(true);
  });

  it("должен не захватывать строку с not_before в будущем", async () => {
    const future = await queue.enqueue(enqueueInput("future", null, { priority: 1 }));
    const past = await queue.enqueue(enqueueInput("past", null, { priority: 5 }));
    const open = await queue.enqueue(enqueueInput("open", null, { priority: 50 }));
    await sql`
      update runs
      set not_before = now() + interval '1 hour'
      where id = ${future.run.id}
    `;
    await sql`
      update runs
      set not_before = now() - interval '1 minute'
      where id = ${past.run.id}
    `;

    const first = mustClaim(await queue.claimNext("worker-a", 30));
    const second = mustClaim(await queue.claimNext("worker-a", 30));
    expect(first.id).toBe(past.run.id);
    expect(second.id).toBe(open.run.id);
    expect(await queue.claimNext("worker-a", 30)).toBeNull();
    expect((await storedRun(future.run.id)).status).toBe("queued");
  });

  it("должен вернуть просроченную аренду в queued и увеличить attempt на следующем захвате", async () => {
    expect(await queue.reapExpired()).toBe(0);

    const first = await queue.enqueue(enqueueInput("reap-a", null));
    const second = await queue.enqueue(enqueueInput("reap-b", null));
    await setCreatedAt(first.run.id, new Date("2026-06-01T00:00:01Z"));
    await setCreatedAt(second.run.id, new Date("2026-06-01T00:00:02Z"));

    const claimA = mustClaim(await queue.claimNext("worker-a", 30));
    const claimB = mustClaim(await queue.claimNext("worker-b", 30));
    expect(claimA.id).toBe(first.run.id);
    expect(claimA.attempt).toBe(1);
    expect(claimA.startedAt).toBeInstanceOf(Date);
    expect(claimB.id).toBe(second.run.id);

    const liveStamp = await lockedUntilText(claimB.id);
    const started = await startedAtText(claimA.id);
    await expireLease(claimA.id);
    expect(await queue.reapExpired()).toBe(1);

    const requeued = await storedRun(claimA.id);
    expect(requeued.status).toBe("queued");
    expect(requeued.attempt).toBe(1);
    expect(requeued.error).toBeNull();
    expect(requeued.locked_by).toBeNull();
    expect(requeued.finished_at).toBeNull();
    expect(await lockedUntilText(claimA.id)).toBeNull();
    expect(await startedAtText(claimA.id)).toBe(started);

    const stillRunning = await storedRun(claimB.id);
    expect(stillRunning.status).toBe("running");
    expect(stillRunning.locked_by).toBe("worker-b");
    expect(stillRunning.attempt).toBe(1);
    expect(await lockedUntilText(claimB.id)).toBe(liveStamp);

    const again = mustClaim(await queue.claimNext("worker-c", 30));
    expect(again.id).toBe(claimA.id);
    expect(again.attempt).toBe(2);
    expect(await startedAtText(again.id)).toBe(started);
    expect((await storedRun(claimB.id)).status).toBe("running");
  });

  it("должен поставить failed и error = lease expired, когда attempt >= max_attempts", async () => {
    const chatId = 6161n;
    const created = await queue.enqueue(enqueueInput("give-up", chatId));
    await sql`update runs set max_attempts = 1 where id = ${created.run.id}`;
    const claimed = mustClaim(await queue.claimNext("worker-a", 30));
    expect(claimed.attempt).toBe(1);
    await expireLease(claimed.id);
    expect(await queue.reapExpired()).toBe(1);

    const failedRun = await storedRun(claimed.id);
    expect(failedRun.status).toBe("failed");
    expect(failedRun.error).toBe("lease expired");
    expect(failedRun.attempt).toBe(1);
    expect(failedRun.finished_at).toBeInstanceOf(Date);
    expect(failedRun.locked_by).toBeNull();
    expect(await queue.claimNext("worker-b", 30)).toBeNull();

    const next = await queue.enqueue(enqueueInput("give-up-2", chatId, { message: "ещё" }));
    expect(next.created).toBe(true);
    expect(next.reason).toBe("created");
    expect(next.run.id).not.toBe(created.run.id);
    expect(await countRuns()).toBe(2);
  });

  it("должен продлить locked_until своему воркеру", async () => {
    const created = await queue.enqueue(enqueueInput("beat-own", null));
    const claimed = mustClaim(await queue.claimNext("worker-a", 30));
    expect(claimed.id).toBe(created.run.id);
    const before = await lockedUntilText(claimed.id);
    if (before === null) {
      throw new Error("locked_until is missing");
    }

    expect(await queue.heartbeat(claimed.id, "worker-a", 600)).toBe(true);
    const after = await lockedUntilText(claimed.id);
    expect(after).not.toBe(before);
    const moved = await sql<{ moved: boolean }[]>`
      select locked_until > cast(${before} as timestamptz) as moved
      from runs
      where id = ${claimed.id}
    `;
    expect(moved[0]?.moved).toBe(true);
    expect((await storedRun(claimed.id)).locked_by).toBe("worker-a");
    expect((await storedRun(claimed.id)).status).toBe("running");
  });

  it("должен вернуть false на heartbeat чужого workerId и не двигать locked_until", async () => {
    const created = await queue.enqueue(enqueueInput("beat-foreign", null));
    const claimed = mustClaim(await queue.claimNext("worker-a", 30));
    expect(claimed.id).toBe(created.run.id);
    const before = await lockedUntilText(claimed.id);

    expect(await queue.heartbeat(claimed.id, "worker-b", 600)).toBe(false);
    expect(await lockedUntilText(claimed.id)).toBe(before);
    expect(
      await queue.heartbeat(claimed.id, "worker'; update runs set status = 'failed'; --", 600),
    ).toBe(false);
    expect(await lockedUntilText(claimed.id)).toBe(before);

    const row = await storedRun(claimed.id);
    expect(row.status).toBe("running");
    expect(row.locked_by).toBe("worker-a");
    expect(await queue.heartbeat(claimed.id, "worker-a", 30)).toBe(true);
  });

  it("должен вернуть false на finish чужого воркера и оставить running", async () => {
    const created = await queue.enqueue(enqueueInput("finish-foreign", null));
    expect(await queue.finish(created.run.id, "worker-a", succeeded("рано"))).toBe(false);
    expect((await storedRun(created.run.id)).status).toBe("queued");
    expect((await storedRun(created.run.id)).final_text).toBeNull();

    const claimed = mustClaim(await queue.claimNext("worker-a", 30));
    expect(await queue.finish(claimed.id, "worker-b", succeeded("чужой"))).toBe(false);
    const row = await storedRun(claimed.id);
    expect(row.status).toBe("running");
    expect(row.locked_by).toBe("worker-a");
    expect(row.final_text).toBeNull();
    expect(row.finished_at).toBeNull();
    expect(row.model_alias).toBeNull();

    expect(
      await queue.finish("00000000-0000-4000-8000-00000000ffff", "worker-a", succeeded("нет")),
    ).toBe(false);
  });

  it("должен скрыть успешный finish от следующего захвата", async () => {
    const created = await queue.enqueue(enqueueInput("finish-ok", null, { message: "вопрос" }));
    const claimed = mustClaim(await queue.claimNext("worker-a", 30));
    expect(claimed.id).toBe(created.run.id);
    expect(await queue.finish(claimed.id, "worker-a", succeeded("готово"))).toBe(true);
    expect(await queue.finish(claimed.id, "worker-a", succeeded("ещё раз"))).toBe(false);

    const row = await storedRun(claimed.id);
    expect(row.status).toBe("succeeded");
    expect(row.final_text).toBe("готово");
    expect(row.error).toBeNull();
    expect(row.model_alias).toBe("agent");
    expect(row.provider).toBe("local");
    expect(row.prompt_tokens).toBe(3);
    expect(row.completion_tokens).toBe(4);
    expect(row.locked_by).toBeNull();
    expect(row.finished_at).toBeInstanceOf(Date);
    expect(await queue.claimNext("worker-b", 30)).toBeNull();
  });

  it("должен записать failed и не отдавать запуск повторно", async () => {
    const created = await queue.enqueue(enqueueInput("finish-bad", null));
    const claimed = mustClaim(await queue.claimNext("worker-a", 30));
    expect(claimed.id).toBe(created.run.id);
    expect(await queue.finish(claimed.id, "worker-a", failed("step_budget_exhausted"))).toBe(true);

    const row = await storedRun(claimed.id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("step_budget_exhausted");
    expect(row.final_text).toBeNull();
    expect(row.locked_by).toBeNull();
    expect(await queue.claimNext("worker-b", 30)).toBeNull();
  });

  it("должен отказать нецелой priority и слишком длинному message", async () => {
    await expect(
      queue.enqueue(enqueueInput("bad-priority", null, { priority: 1.5 })),
    ).rejects.toMatchObject({
      code: "invalid_priority",
    });
    expect(await countRuns()).toBe(0);

    const key = "long-replay";
    const first = await queue.enqueue(enqueueInput(key, null, { message: "ok" }));
    const replay = await queue.enqueue(
      enqueueInput(key, null, { message: "а".repeat(8001), priority: 1.5 }),
    );
    expect(replay.reason).toBe("replay");
    expect(replay.run.id).toBe(first.run.id);

    await expect(
      queue.enqueue(enqueueInput("too-long", null, { message: "а".repeat(8001) })),
    ).rejects.toMatchObject({ code: "invalid_payload" });
    expect(await countRuns()).toBe(1);
  });
});

function enqueueInput(
  idempotencyKey: string,
  chatId: bigint | null,
  overrides: { message?: string; priority?: number; agentId?: string } = {},
): EnqueueInput {
  const input: EnqueueInput = {
    tenantId: "local",
    agentId: overrides.agentId ?? AGENT_ID,
    source: "api",
    idempotencyKey,
    message: overrides.message ?? "привет",
    chatId,
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
    promptTokens: 3,
    completionTokens: 4,
  };
}

function failed(error: string): FinishOutcome {
  return {
    status: "failed",
    finalText: null,
    error,
    modelAlias: "agent",
    provider: "local",
    promptTokens: null,
    completionTokens: null,
  };
}

function mustClaim(run: ClaimedRun | null): ClaimedRun {
  if (run === null) {
    throw new Error("claim returned no run");
  }
  return run;
}

interface StoredRun {
  status: string;
  attempt: number;
  error: string | null;
  locked_by: string | null;
  final_text: string | null;
  chat_id: string | null;
  finished_at: Date | null;
  model_alias: string | null;
  provider: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  priority: number;
}

async function storedRun(id: string): Promise<StoredRun> {
  const rows = await sql<StoredRun[]>`
    select
      status,
      attempt,
      error,
      locked_by,
      final_text,
      chat_id,
      finished_at,
      model_alias,
      provider,
      prompt_tokens,
      completion_tokens,
      priority
    from runs
    where id = ${id}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("run is missing");
  }
  return row;
}

async function countRuns(): Promise<number> {
  return countTable("runs");
}

async function countAgents(): Promise<number> {
  return countTable("agents");
}

async function countTable(table: "runs" | "agents"): Promise<number> {
  const rows =
    table === "runs"
      ? await sql<{ count: number }[]>`select count(*)::int as count from runs`
      : await sql<{ count: number }[]>`select count(*)::int as count from agents`;
  const count = rows[0]?.count;
  if (count === undefined) {
    throw new Error("count is missing");
  }
  return count;
}

async function lockedUntilText(id: string): Promise<string | null> {
  const rows = await sql<{ stamp: string | null }[]>`
    select locked_until::text as stamp from runs where id = ${id}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("run is missing");
  }
  return row.stamp;
}

async function startedAtText(id: string): Promise<string | null> {
  const rows = await sql<{ stamp: string | null }[]>`
    select started_at::text as stamp from runs where id = ${id}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("run is missing");
  }
  return row.stamp;
}

async function setCreatedAt(id: string, at: Date): Promise<void> {
  await sql`update runs set created_at = ${at} where id = ${id}`;
}

async function expireLease(id: string): Promise<void> {
  await sql`
    update runs
    set locked_until = now() - interval '1 second'
    where id = ${id}
  `;
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
