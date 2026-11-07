import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCronJob,
  tickCron,
  type CreateCronJob,
  type TickOptions,
} from "../../src/cron/index.js";
import { isValidSchedule, scheduleMatches } from "../../src/cron/schedule.js";
import { LiteLLMChatModel } from "../../src/model/litellm.js";
import { createRunQueue } from "../../src/queue/index.js";
import { sql } from "../helpers/db.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const CHAT_ID = 1234567890123456789n;
const CHAT_TEXT = "1234567890123456789";
const T0 = new Date("2026-11-07T10:00:00.000Z");

const queue = createRunQueue(sql);
const deps = { sql, queue };

describe("cron", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("должен выполнить script и не открывать ChatModel", async () => {
    const complete = vi
      .spyOn(LiteLLMChatModel.prototype, "complete")
      .mockRejectedValue(new Error("model opened"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const job = await createCronJob(sql, scriptJob(["echo", "cron-ok"]));
    const started = Date.now();
    const result = await tickCron(deps, job.id, rejectingDelay());

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toEqual({ action: "script", exitCode: 0, notice: null });
    expect(complete).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await countCronRuns()).toBe(0);

    const source = await cronSource();
    expect(source.includes("ChatModel")).toBe(false);
    expect(source.includes("litellm")).toBe(false);
    expect(source.includes("grammy")).toBe(false);
    expect(source.includes("process.env")).toBe(false);
    expect(source.includes("execSync")).toBe(false);
    expect(source.includes("execFile")).toBe(false);
    expect(source.includes("spawnSync")).toBe(false);
    expect(source.includes("shell: true")).toBe(false);
    expect(source.includes("shell:true")).toBe(false);
    expect(source.includes("child_process.exec")).toBe(false);
    expect(source.includes(".exec(")).toBe(false);
    expect(source.includes("shell: false")).toBe(true);
    expect(source.includes("spawn(")).toBe(true);
  });

  it("должен не создавать вторую строку, пока запуск этого крона жив", async () => {
    const complete = vi
      .spyOn(LiteLLMChatModel.prototype, "complete")
      .mockRejectedValue(new Error("model opened"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const message = "тик'); drop table cron_jobs; --";
    const job = await createCronJob(sql, agentJob(message));
    let allowDelay = true;
    const delays: number[] = [];
    const delay = async (ms: number): Promise<void> => {
      if (!allowDelay) {
        throw new Error("jitter on a skipped tick");
      }
      delays.push(ms);
      if (delays.length === 1) {
        expect(ms).toBe(15_000);
        expect(await countCronRuns()).toBe(0);
      }
    };
    const nextJitterMs = (): number => {
      if (!allowDelay) {
        throw new Error("jitter on a skipped tick");
      }
      return delays.length === 0 ? 15_000 : 0;
    };
    const started = Date.now();
    const first = await tickCron(deps, job.id, { now: T0, delay, nextJitterMs });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(first).toMatchObject({ action: "enqueued", created: true });
    if (first.action !== "enqueued") {
      throw new Error("run was not enqueued");
    }

    allowDelay = false;
    const second = await tickCron(deps, job.id, {
      now: addMinutes(T0, 1),
      delay,
      nextJitterMs,
    });
    expect(second).toEqual({ action: "skipped_live" });
    expect(await countCronRuns()).toBe(1);

    await sql`
      update runs
      set status = 'succeeded',
          final_text = 'ok',
          finished_at = now()
      where id = ${first.runId}
    `;
    const sameMinute = await tickCron(deps, job.id, { now: T0, delay, nextJitterMs });
    expect(sameMinute).toEqual({ action: "already_dispatched" });
    expect(await countCronRuns()).toBe(1);

    allowDelay = true;
    const third = await tickCron(deps, job.id, {
      now: addMinutes(T0, 2),
      delay,
      nextJitterMs,
    });
    expect(third).toMatchObject({ action: "enqueued", created: true });
    expect(delays).toEqual([15_000, 0]);
    expect(complete).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const rows = await sql<
      {
        source: string;
        chat_id: string | null;
        payload: { message: string };
        idempotency_key: string;
      }[]
    >`
      select source, chat_id, payload, idempotency_key
      from runs
      where source = 'cron'
      order by created_at
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.chat_id).toBeNull();
    expect(rows[1]?.chat_id).toBeNull();
    expect(rows[0]?.payload).toEqual({ message });
    expect(rows[1]?.payload).toEqual({ message });
    expect(rows[0]?.idempotency_key === rows[1]?.idempotency_key).toBe(false);
    expect(await countJobs()).toBe(1);
  });

  it("должен поставить паузу на третьем провале подряд", async () => {
    const complete = vi
      .spyOn(LiteLLMChatModel.prototype, "complete")
      .mockRejectedValue(new Error("model opened"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const job = await createCronJob(sql, scriptJob(["false"]));
    const first = await tickCron(deps, job.id, rejectingDelay());
    const second = await tickCron(deps, job.id, rejectingDelay());
    const third = await tickCron(deps, job.id, rejectingDelay());
    const text = `Крон ${job.id} на паузе после трёх провалов подряд.`;

    expect(first).toEqual({ action: "script", exitCode: 1, notice: null });
    expect(second).toEqual({ action: "script", exitCode: 1, notice: null });
    expect(third).toEqual({
      action: "script",
      exitCode: 1,
      notice: { chatId: CHAT_TEXT, text },
    });

    const row = await jobRow(job.id);
    expect(row.paused).toBe(true);
    expect(row.pause_message).toBe(text);
    expect(row.pause_chat_id).toBe(CHAT_TEXT);
    expect(typeof row.pause_chat_id).toBe("string");
    expect(row.consecutive_failures).toBe(3);

    const fourth = await tickCron(deps, job.id, rejectingDelay());
    expect(fourth).toEqual({ action: "paused", notice: { chatId: CHAT_TEXT, text } });
    expect((await jobRow(job.id)).consecutive_failures).toBe(3);
    expect(await countCronRuns()).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("должен сбросить серию провалов после успешного script", async () => {
    const job = await createCronJob(sql, scriptJob(["false"]));
    await tickCron(deps, job.id, rejectingDelay());
    await tickCron(deps, job.id, rejectingDelay());
    expect((await jobRow(job.id)).consecutive_failures).toBe(2);

    await sql`
      update cron_jobs
      set command = ${sql.array(["true"])}
      where id = ${job.id}
    `;
    const success = await tickCron(deps, job.id, rejectingDelay());
    expect(success).toEqual({ action: "script", exitCode: 0, notice: null });
    expect((await jobRow(job.id)).consecutive_failures).toBe(0);
    expect((await jobRow(job.id)).paused).toBe(false);

    await sql`
      update cron_jobs
      set command = ${sql.array(["false"])}
      where id = ${job.id}
    `;
    await tickCron(deps, job.id, rejectingDelay());
    const row = await jobRow(job.id);
    expect(row.consecutive_failures).toBe(1);
    expect(row.paused).toBe(false);
  });

  it("должен не запускать команду вне allowlist", async () => {
    const complete = vi
      .spyOn(LiteLLMChatModel.prototype, "complete")
      .mockRejectedValue(new Error("model opened"));
    const marker = path.join(tmpdir(), `harness-cron-${randomUUID()}`);

    await expect(createCronJob(sql, scriptJob(["bash", "-c", "echo hi"]))).rejects.toMatchObject({
      name: "CronError",
      code: "command_denied",
    });
    await expect(createCronJob(sql, scriptJob(["/usr/bin/true"]))).rejects.toMatchObject({
      code: "command_denied",
    });
    await expect(createCronJob(sql, scriptJob(["echo", "a;b"]))).rejects.toMatchObject({
      code: "command_denied",
    });
    expect(await countJobs()).toBe(0);

    const touchId = await insertCommand(["touch", marker]);
    const touch = await tickCron(deps, touchId, rejectingDelay());
    expect(touch).toEqual({ action: "denied", notice: null });
    expect(await markerExists(marker)).toBe(false);

    const pathId = await insertCommand(["/usr/bin/true"]);
    const absolute = await tickCron(deps, pathId, rejectingDelay());
    expect(absolute).toEqual({ action: "denied", notice: null });
    expect((await jobRow(pathId)).paused).toBe(false);
    expect(await countCronRuns()).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it("должен отпустить аренду, если джиттер больше 15 секунд", async () => {
    const job = await createCronJob(sql, agentJob("тик"));
    await expect(
      tickCron(deps, job.id, {
        now: T0,
        nextJitterMs: () => 15_001,
        delay: () => Promise.reject(new Error("delay after invalid jitter")),
      }),
    ).rejects.toMatchObject({ code: "invalid_jitter" });

    const result = await tickCron(deps, job.id, {
      now: T0,
      nextJitterMs: () => 0,
      delay: () => Promise.resolve(),
    });
    expect(result).toMatchObject({ action: "enqueued", created: true });
    expect(await countCronRuns()).toBe(1);
  });

  it("должен не ставить запуск вне расписания", async () => {
    const job = await createCronJob(sql, agentJob("нет", "0 0 1 1 *"));
    const result = await tickCron(deps, job.id, {
      now: T0,
      delay: () => Promise.reject(new Error("jitter off schedule")),
    });
    expect(result).toEqual({ action: "not_due" });
    expect(await countCronRuns()).toBe(0);
  });
});

describe("cron schedule", () => {
  it("должен принять пятипольное выражение и отказать лишнему полю", () => {
    const saturday = new Date("2026-11-07T10:00:00.000Z");
    const saturdayMinute = new Date("2026-11-07T10:34:00.000Z");
    const sunday = new Date("2026-11-08T00:00:00.000Z");
    expect(saturday.getUTCDay()).toBe(6);
    expect(sunday.getUTCDay()).toBe(0);

    expect(isValidSchedule("* * * * *")).toBe(true);
    expect(scheduleMatches("* * * * *", saturday)).toBe(true);
    expect(scheduleMatches("34 10 * * *", saturdayMinute)).toBe(true);
    expect(scheduleMatches("35 10 * * *", saturdayMinute)).toBe(false);
    expect(scheduleMatches("*/15 * * * *", new Date("2026-11-07T10:45:00.000Z"))).toBe(true);
    expect(scheduleMatches("*/15 * * * *", new Date("2026-11-07T10:10:00.000Z"))).toBe(false);
    expect(scheduleMatches("1-5/2 * * * *", new Date("2026-11-07T10:05:00.000Z"))).toBe(true);
    expect(scheduleMatches("1-5/2 * * * *", new Date("2026-11-07T10:04:00.000Z"))).toBe(false);
    expect(scheduleMatches("0 10 7 11 1", saturday)).toBe(true);
    expect(scheduleMatches("0 10 8 11 6", saturday)).toBe(true);
    expect(scheduleMatches("0 10 8 11 1", saturday)).toBe(false);
    expect(scheduleMatches("0 0 * * 7", sunday)).toBe(true);
    expect(scheduleMatches("0 0 * * 0", sunday)).toBe(true);

    expect(isValidSchedule("* * * *")).toBe(false);
    expect(isValidSchedule("* * * * * *")).toBe(false);
    expect(isValidSchedule("99 * * * *")).toBe(false);
    expect(isValidSchedule("")).toBe(false);
    expect(isValidSchedule("* * * * *; drop table runs")).toBe(false);
    expect(isValidSchedule("*".repeat(101))).toBe(false);
    expect(scheduleMatches("* * * * *; drop table runs", saturday)).toBe(false);
  });
});

function scriptJob(command: readonly string[]): CreateCronJob {
  return {
    tenantId: "local",
    agentId: AGENT_ID,
    kind: "script",
    schedule: "* * * * *",
    pauseChatId: CHAT_ID,
    command,
  };
}

function agentJob(message: string, schedule = "* * * * *"): CreateCronJob {
  return {
    tenantId: "local",
    agentId: AGENT_ID,
    kind: "agent",
    schedule,
    pauseChatId: CHAT_ID,
    message,
  };
}

function rejectingDelay(): TickOptions {
  return {
    delay: () => Promise.reject(new Error("script must not jitter")),
    nextJitterMs: () => {
      throw new Error("script must not jitter");
    },
  };
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

async function insertCommand(command: readonly string[]): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into cron_jobs (
      tenant_id,
      agent_id,
      kind,
      schedule,
      pause_chat_id,
      command
    ) values (
      'local',
      ${AGENT_ID},
      'script',
      '* * * * *',
      ${sql.types.chat_id(CHAT_TEXT)},
      ${sql.array([...command])}
    )
    returning id
  `;
  const id = rows[0]?.id;
  if (id === undefined || rows.length !== 1) {
    throw new Error("cron insert failed");
  }
  return id;
}

async function jobRow(id: string): Promise<{
  paused: boolean;
  pause_message: string | null;
  pause_chat_id: string;
  consecutive_failures: number;
}> {
  const rows = await sql<
    {
      paused: boolean;
      pause_message: string | null;
      pause_chat_id: string;
      consecutive_failures: number;
    }[]
  >`
    select paused, pause_message, pause_chat_id, consecutive_failures
    from cron_jobs
    where id = ${id}
  `;
  const row = rows[0];
  if (row === undefined || rows.length !== 1) {
    throw new Error("cron job is missing");
  }
  return row;
}

async function countCronRuns(): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    select count(*)::int as count from runs where source = 'cron'
  `;
  return requiredCount(rows[0]?.count);
}

async function countJobs(): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    select count(*)::int as count from cron_jobs
  `;
  return requiredCount(rows[0]?.count);
}

function requiredCount(value: number | undefined): number {
  if (value === undefined) {
    throw new Error("count is missing");
  }
  return value;
}

async function markerExists(marker: string): Promise<boolean> {
  // Случайный файл в tmp: запрещённая команда не должна его создать.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- маркер теста, не путь продукта
  return stat(marker).then(
    () => true,
    () => false,
  );
}

async function cronSource(): Promise<string> {
  const names = ["errors.ts", "index.ts", "jobs.ts", "schedule.ts", "script.ts"];
  const parts: string[] = [];
  for (const name of names) {
    const filePath = fileURLToPath(new URL(`../../src/cron/${name}`, import.meta.url));
    // Фиксированный каталог пакета, не путь из запуска.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- файлы src/cron
    parts.push(await readFile(filePath, "utf8"));
  }
  return parts.join("\n");
}
