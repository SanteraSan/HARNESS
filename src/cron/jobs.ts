import { randomInt } from "node:crypto";

import type postgres from "postgres";

import type { RunQueue } from "../contracts/types.js";
import { logger } from "../config.js";
import type { Sql } from "../db/client.js";
import { CronError } from "./errors.js";
import { isValidSchedule, scheduleMatches } from "./schedule.js";
import { parseCommand, runAllowlisted, type AllowedCommand } from "./script.js";

/**
 * Джиттер до 15 с стоит вне транзакции: idle_in_transaction_session_timeout короче.
 * Повторный тик при живом запуске этого крона не ставит вторую строку.
 * Три провала подряд ставят паузу и готовят текст, но в Telegram его не отправляют.
 */

const PAUSE_AFTER = 3;

const JITTER_MAX_MS = 15_000;

const INT8_MIN = -9223372036854775808n;

const INT8_MAX = 9223372036854775807n;

const MESSAGE_MAX = 8000;

type Db = Sql | postgres.TransactionSql<{ chat_id: string }>;

export interface CronDeps {
  sql: Sql;
  queue: RunQueue;
}

export interface PauseNotice {
  /** Десятичная строка int8. Number() для chat id Telegram не используется. */
  chatId: string;
  text: string;
}

export interface CronJob {
  id: string;
  tenantId: string;
  agentId: string;
  kind: "script" | "agent";
  schedule: string;
  paused: boolean;
  pauseChatId: string;
  pauseMessage: string | null;
  command: readonly string[] | null;
  message: string | null;
  consecutiveFailures: number;
}

export type CreateCronJob =
  | {
      tenantId: string;
      agentId: string;
      kind: "script";
      schedule: string;
      pauseChatId: bigint;
      command: readonly string[];
    }
  | {
      tenantId: string;
      agentId: string;
      kind: "agent";
      schedule: string;
      pauseChatId: bigint;
      message: string;
    };

export interface TickOptions {
  now?: Date;
  /** Подмена ожидания. В тесте не спим 15 секунд. */
  delay?: (ms: number) => Promise<void>;
  nextJitterMs?: () => number;
}

export type TickResult =
  | { action: "not_due" }
  | { action: "paused"; notice: PauseNotice }
  | { action: "skipped_live" }
  | { action: "skipped_busy" }
  | { action: "already_dispatched" }
  | { action: "lost_lease" }
  | { action: "denied"; notice: PauseNotice | null }
  | { action: "script"; exitCode: number; notice: PauseNotice | null }
  | { action: "enqueued"; runId: string; created: boolean };

interface Job {
  id: string;
  tenantId: string;
  agentId: string;
  kind: "script" | "agent";
  schedule: string;
  paused: boolean;
  pauseChatId: string;
  pauseMessage: string | null;
  command: readonly string[] | null;
  message: string | null;
  consecutiveFailures: number;
  countedFailureRunId: string | null;
  lastRunId: string | null;
  lastDispatchedAt: Date | null;
  dispatchToken: string | null;
  busy: boolean;
}

type Claim =
  | { kind: "done"; result: TickResult }
  | { kind: "script"; token: string; name: AllowedCommand; args: readonly string[] }
  | { kind: "agent"; token: string };

type Gate = { kind: "done"; result: TickResult } | { kind: "ready"; job: Job };

export async function createCronJob(sql: Sql, input: CreateCronJob): Promise<CronJob> {
  const tenantId = requireTenant(input.tenantId);
  const agentId = requireUuid(input.agentId, "invalid_agent", "agent id is invalid");
  const schedule = requireSchedule(input.schedule);
  const pauseChatId = requireChat(input.pauseChatId);
  if (input.kind === "script") {
    const parsed = parseCommand(input.command);
    if (parsed === null) {
      throw new CronError("command_denied", "command is not in the allowlist");
    }
    const id = await insertScript(sql, {
      tenantId,
      agentId,
      schedule,
      pauseChatId,
      command: [parsed.name, ...parsed.args],
    });
    return toPublic(await loadJob(sql, id, false));
  }
  if (input.kind === "agent") {
    const message = requireMessage(input.message);
    const id = await insertAgent(sql, { tenantId, agentId, schedule, pauseChatId, message });
    return toPublic(await loadJob(sql, id, false));
  }
  throw new CronError("invalid_kind", "cron kind is invalid");
}

export async function tickCron(
  deps: CronDeps,
  jobId: string,
  options: TickOptions = {},
): Promise<TickResult> {
  if (!isUuid(jobId)) {
    throw new CronError("invalid_job", "cron job id is invalid");
  }
  const now = await resolveNow(deps.sql, options.now);
  const slot = minuteSlot(now);
  const claim = await claimJob(deps.sql, jobId, slot);
  if (claim.kind === "done") {
    return claim.result;
  }
  try {
    if (claim.kind === "script") {
      return await runClaimedScript(deps.sql, jobId, claim);
    }
    const ms = resolveJitter(options);
    await waitJitter(options, ms);
    const gate = await recheckAgent(deps.sql, jobId, claim.token);
    if (gate.kind === "done") {
      return gate.result;
    }
    return await enqueueClaimed(deps, gate.job, slot, claim.token);
  } finally {
    await releaseToken(deps.sql, jobId, claim.token);
  }
}

async function insertScript(
  sql: Sql,
  row: {
    tenantId: string;
    agentId: string;
    schedule: string;
    pauseChatId: string;
    command: string[];
  },
): Promise<string> {
  const inserted = await sql<Record<string, unknown>[]>`
    insert into cron_jobs (
      tenant_id,
      agent_id,
      kind,
      schedule,
      pause_chat_id,
      command
    ) values (
      ${row.tenantId},
      ${row.agentId},
      'script',
      ${row.schedule},
      ${sql.types.chat_id(row.pauseChatId)},
      ${sql.array(row.command)}
    )
    returning id
  `;
  return requireInsertedId(inserted);
}

async function insertAgent(
  sql: Sql,
  row: {
    tenantId: string;
    agentId: string;
    schedule: string;
    pauseChatId: string;
    message: string;
  },
): Promise<string> {
  const inserted = await sql<Record<string, unknown>[]>`
    insert into cron_jobs (
      tenant_id,
      agent_id,
      kind,
      schedule,
      pause_chat_id,
      message
    ) values (
      ${row.tenantId},
      ${row.agentId},
      'agent',
      ${row.schedule},
      ${sql.types.chat_id(row.pauseChatId)},
      ${row.message}
    )
    returning id
  `;
  return requireInsertedId(inserted);
}

async function claimJob(sql: Sql, jobId: string, slot: Date): Promise<Claim> {
  return sql.begin(async (tx) => {
    const job = await loadJob(tx, jobId, true);
    if (!isValidSchedule(job.schedule)) {
      throw new CronError("invalid_schedule", "schedule is invalid");
    }
    if (job.paused) {
      return finished({ action: "paused", notice: noticeOf(job) });
    }
    if (!scheduleMatches(job.schedule, slot)) {
      return finished({ action: "not_due" });
    }
    if (job.kind === "agent") {
      return claimAgent(tx, job, slot);
    }
    return claimScript(tx, job);
  });
}

async function claimAgent(tx: Db, job: Job, slot: Date): Promise<Claim> {
  const observed = await observeLastRun(tx, job);
  if (observed.status === "paused") {
    return finished({ action: "paused", notice: observed.notice });
  }
  const liveId = await findLiveRun(tx, job);
  if (liveId !== null) {
    await adoptLive(tx, job, liveId);
    return finished({ action: "skipped_live" });
  }
  if (job.busy) {
    return finished({ action: "skipped_busy" });
  }
  if (job.lastDispatchedAt !== null && sameMinute(job.lastDispatchedAt, slot)) {
    return finished({ action: "already_dispatched" });
  }
  const token = await takeLease(tx, job.id);
  return { kind: "agent", token };
}

async function claimScript(tx: Db, job: Job): Promise<Claim> {
  if (job.busy) {
    return finished({ action: "skipped_busy" });
  }
  const parsed = parseCommand(job.command ?? []);
  if (parsed === null) {
    const notice = await noteFailure(tx, job, null);
    return finished({ action: "denied", notice });
  }
  const token = await takeLease(tx, job.id);
  return { kind: "script", token, name: parsed.name, args: parsed.args };
}

async function observeLastRun(
  tx: Db,
  job: Job,
): Promise<{ status: "continue" } | { status: "paused"; notice: PauseNotice }> {
  if (job.lastRunId === null) {
    return { status: "continue" };
  }
  const status = await readRunStatus(tx, job.lastRunId);
  if (status === "succeeded") {
    if (job.consecutiveFailures !== 0) {
      await tx`
        update cron_jobs
        set consecutive_failures = 0
        where id = ${job.id}
      `;
    }
    return { status: "continue" };
  }
  if (status !== "failed" || job.countedFailureRunId === job.lastRunId) {
    return { status: "continue" };
  }
  const next = job.consecutiveFailures + 1;
  if (next >= PAUSE_AFTER) {
    const notice = await markPaused(tx, job, next, job.lastRunId);
    return { status: "paused", notice };
  }
  await tx`
    update cron_jobs
    set consecutive_failures = ${next},
        counted_failure_run_id = ${job.lastRunId}
    where id = ${job.id}
  `;
  return { status: "continue" };
}

async function runClaimedScript(
  sql: Sql,
  jobId: string,
  claim: Extract<Claim, { kind: "script" }>,
): Promise<TickResult> {
  let exitCode: number;
  try {
    exitCode = await runAllowlisted(claim.name, claim.args);
  } catch (error) {
    logger.error({ job_id: jobId, err: error }, "cron script failed");
    throw error;
  }
  const notice = await recordOwnedOutcome(
    sql,
    jobId,
    claim.token,
    exitCode === 0 ? "success" : "failure",
  );
  return { action: "script", exitCode, notice };
}

async function recheckAgent(sql: Sql, jobId: string, token: string): Promise<Gate> {
  return sql.begin(async (tx) => {
    const job = await loadJob(tx, jobId, true);
    if (job.dispatchToken !== token || !job.busy) {
      return finished({ action: "lost_lease" });
    }
    if (job.paused) {
      return finished({ action: "paused", notice: noticeOf(job) });
    }
    const liveId = await findLiveRun(tx, job);
    if (liveId !== null) {
      await adoptLive(tx, job, liveId);
      return finished({ action: "skipped_live" });
    }
    return { kind: "ready", job };
  });
}

/**
 * chat_id запуска пустой: паузный чат не должен занимать диалог по I6.
 * Живой запуск ищется по префиксу ключа этого крона, не по чату.
 */
async function enqueueClaimed(
  deps: CronDeps,
  job: Job,
  slot: Date,
  token: string,
): Promise<TickResult> {
  if (job.kind !== "agent" || job.message === null) {
    throw new CronError("invalid_row", "cron job is not an agent");
  }
  let result: Awaited<ReturnType<RunQueue["enqueue"]>>;
  try {
    result = await deps.queue.enqueue({
      tenantId: job.tenantId,
      agentId: job.agentId,
      source: "cron",
      idempotencyKey: cronIdempotencyKey(job.id, slot),
      message: job.message,
      chatId: null,
    });
  } catch (error) {
    logger.error({ job_id: job.id, err: error }, "cron enqueue failed");
    await recordOwnedOutcome(deps.sql, job.id, token, "failure");
    throw error;
  }
  if (result.run.source !== "cron" || result.reason === "dialog_busy") {
    await recordOwnedOutcome(deps.sql, job.id, token, "failure");
    throw new CronError("enqueue_rejected", "cron enqueue was rejected");
  }
  await linkRun(deps.sql, job.id, token, result.run.id, slot);
  logger.info({ job_id: job.id, run_id: result.run.id }, "cron enqueued");
  return { action: "enqueued", runId: result.run.id, created: result.created };
}

async function recordOwnedOutcome(
  sql: Sql,
  jobId: string,
  leaseId: string,
  outcome: "success" | "failure",
): Promise<PauseNotice | null> {
  return sql.begin(async (tx) => {
    const job = await loadJob(tx, jobId, true);
    if (job.dispatchToken !== leaseId) {
      throw new CronError("lost_lease", "cron lease was lost");
    }
    if (outcome === "success") {
      const updated = await tx<{ id: string }[]>`
        update cron_jobs
        set consecutive_failures = 0,
            busy_until = null,
            dispatch_token = null
        where id = ${job.id}
          and dispatch_token = ${leaseId}
        returning id
      `;
      if (updated.length !== 1) {
        throw new CronError("lost_lease", "cron lease was lost");
      }
      return null;
    }
    const next = job.consecutiveFailures + 1;
    if (next >= PAUSE_AFTER) {
      return markPaused(tx, job, next, job.countedFailureRunId);
    }
    const updated = await tx<{ id: string }[]>`
      update cron_jobs
      set consecutive_failures = ${next},
          busy_until = null,
          dispatch_token = null
      where id = ${job.id}
        and dispatch_token = ${leaseId}
      returning id
    `;
    if (updated.length !== 1) {
      throw new CronError("lost_lease", "cron lease was lost");
    }
    return null;
  });
}

async function noteFailure(
  tx: Db,
  job: Job,
  countedRunId: string | null,
): Promise<PauseNotice | null> {
  const next = job.consecutiveFailures + 1;
  if (next >= PAUSE_AFTER) {
    return markPaused(tx, job, next, countedRunId);
  }
  await tx`
    update cron_jobs
    set consecutive_failures = ${next},
        counted_failure_run_id = ${countedRunId}
    where id = ${job.id}
  `;
  return null;
}

async function markPaused(
  tx: Db,
  job: Job,
  failures: number,
  countedRunId: string | null,
): Promise<PauseNotice> {
  const text = pauseText(job.id);
  const updated = await tx<{ id: string }[]>`
    update cron_jobs
    set paused = true,
        pause_message = ${text},
        consecutive_failures = ${failures},
        counted_failure_run_id = ${countedRunId},
        busy_until = null,
        dispatch_token = null
    where id = ${job.id}
    returning id
  `;
  if (updated.length !== 1) {
    throw new CronError("invalid_row", "cron pause was not saved");
  }
  logger.info({ job_id: job.id }, "cron paused");
  return { chatId: job.pauseChatId, text };
}

async function takeLease(tx: Db, jobId: string): Promise<string> {
  // 30 с > джиттер 15 с. Сравнение аренды — now() Postgres, не часы процесса.
  const rows = await tx<Record<string, unknown>[]>`
    update cron_jobs
    set busy_until = now() + make_interval(secs => 30),
        dispatch_token = gen_random_uuid()
    where id = ${jobId}
    returning dispatch_token
  `;
  const token = rows.length === 1 ? rows[0]?.dispatch_token : undefined;
  if (typeof token !== "string" || !isUuid(token)) {
    throw new CronError("invalid_row", "cron lease is invalid");
  }
  return token;
}

async function findLiveRun(tx: Db, job: Job): Promise<string | null> {
  const prefix = `cron:${job.id}:`;
  const rows = await tx<Record<string, unknown>[]>`
    select id
    from runs
    where agent_id = ${job.agentId}
      and source = 'cron'
      and status in ('queued', 'running')
      and left(idempotency_key, ${prefix.length}) = ${prefix}
    limit 1
  `;
  if (rows.length === 0) {
    return null;
  }
  const id = rows[0]?.id;
  if (rows.length !== 1 || typeof id !== "string" || !isUuid(id)) {
    throw new CronError("invalid_row", "live run is invalid");
  }
  return id;
}

async function adoptLive(tx: Db, job: Job, liveId: string): Promise<void> {
  if (job.lastRunId === liveId) {
    return;
  }
  await tx`
    update cron_jobs
    set last_run_id = ${liveId}
    where id = ${job.id}
  `;
}

async function readRunStatus(tx: Db, runId: string): Promise<string | null> {
  const rows = await tx<Record<string, unknown>[]>`
    select status
    from runs
    where id = ${runId}
  `;
  if (rows.length !== 1) {
    return null;
  }
  const status = rows[0]?.status;
  if (typeof status !== "string") {
    return null;
  }
  return status;
}

async function linkRun(
  sql: Sql,
  jobId: string,
  token: string,
  runId: string,
  slot: Date,
): Promise<void> {
  const updated = await sql<{ id: string }[]>`
    update cron_jobs
    set last_run_id = ${runId},
        last_dispatched_at = ${slot},
        busy_until = null,
        dispatch_token = null
    where id = ${jobId}
      and dispatch_token = ${token}
    returning id
  `;
  if (updated.length !== 1) {
    throw new CronError("lost_lease", "cron lease was lost");
  }
}

async function releaseToken(sql: Sql, jobId: string, token: string): Promise<void> {
  await sql`
    update cron_jobs
    set busy_until = null,
        dispatch_token = null
    where id = ${jobId}
      and dispatch_token = ${token}
  `;
}

async function loadJob(db: Db, jobId: string, lock: boolean): Promise<Job> {
  if (lock) {
    const rows = await db<Record<string, unknown>[]>`
      select
        id,
        tenant_id,
        agent_id,
        kind,
        schedule,
        paused,
        pause_chat_id,
        pause_message,
        command,
        message,
        consecutive_failures,
        counted_failure_run_id,
        last_run_id,
        last_dispatched_at,
        dispatch_token,
        (busy_until is not null and busy_until > now()) as busy
      from cron_jobs
      where id = ${jobId}
      for update
    `;
    return mapJob(requireRow(rows));
  }
  const rows = await db<Record<string, unknown>[]>`
    select
      id,
      tenant_id,
      agent_id,
      kind,
      schedule,
      paused,
      pause_chat_id,
      pause_message,
      command,
      message,
      consecutive_failures,
      counted_failure_run_id,
      last_run_id,
      last_dispatched_at,
      dispatch_token,
      (busy_until is not null and busy_until > now()) as busy
    from cron_jobs
    where id = ${jobId}
  `;
  return mapJob(requireRow(rows));
}

function mapJob(row: Record<string, unknown>): Job {
  const kind = requireKind(row.kind);
  return {
    id: requireUuid(row.id, "invalid_row", "cron job id is invalid"),
    tenantId: requireText(row.tenant_id, "cron tenant is invalid"),
    agentId: requireUuid(row.agent_id, "invalid_row", "cron agent is invalid"),
    kind,
    schedule: requireText(row.schedule, "cron schedule is invalid"),
    paused: requireBoolean(row.paused),
    pauseChatId: requireChatColumn(row.pause_chat_id),
    pauseMessage: requireNullableText(row.pause_message),
    command: requireCommand(row.command),
    message: requireNullableText(row.message),
    consecutiveFailures: requireInteger(row.consecutive_failures),
    countedFailureRunId: requireNullableUuid(row.counted_failure_run_id),
    lastRunId: requireNullableUuid(row.last_run_id),
    lastDispatchedAt: requireNullableDate(row.last_dispatched_at),
    dispatchToken: requireNullableUuid(row.dispatch_token),
    busy: requireBoolean(row.busy),
  };
}

function toPublic(job: Job): CronJob {
  return {
    id: job.id,
    tenantId: job.tenantId,
    agentId: job.agentId,
    kind: job.kind,
    schedule: job.schedule,
    paused: job.paused,
    pauseChatId: job.pauseChatId,
    pauseMessage: job.pauseMessage,
    command: job.command,
    message: job.message,
    consecutiveFailures: job.consecutiveFailures,
  };
}

function finished(result: TickResult): { kind: "done"; result: TickResult } {
  return { kind: "done", result };
}

function noticeOf(job: Job): PauseNotice {
  return {
    chatId: job.pauseChatId,
    text: job.pauseMessage ?? pauseText(job.id),
  };
}

function pauseText(jobId: string): string {
  const text = `Крон ${jobId} на паузе после трёх провалов подряд.`;
  if (text.length > 500) {
    throw new CronError("invalid_pause", "pause message is invalid");
  }
  return text;
}

function cronIdempotencyKey(jobId: string, slot: Date): string {
  const key = `cron:${jobId}:${formatMinute(slot)}`;
  if (key.length > 200) {
    throw new CronError("invalid_job", "cron idempotency key is invalid");
  }
  return key;
}

function formatMinute(slot: Date): string {
  const year = slot.getUTCFullYear().toString().padStart(4, "0");
  const month = (slot.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = slot.getUTCDate().toString().padStart(2, "0");
  const hour = slot.getUTCHours().toString().padStart(2, "0");
  const minute = slot.getUTCMinutes().toString().padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function minuteSlot(now: Date): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
    ),
  );
}

function sameMinute(previous: Date, slot: Date): boolean {
  return minuteSlot(previous).getTime() === slot.getTime();
}

async function resolveNow(sql: Sql, now: Date | undefined): Promise<Date> {
  if (now === undefined) {
    return databaseNow(sql);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new CronError("invalid_clock", "clock is invalid");
  }
  return now;
}

async function databaseNow(sql: Sql): Promise<Date> {
  const rows = await sql<{ now: Date }[]>`select now() as now`;
  const value = rows[0]?.now;
  if (rows.length !== 1 || !(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new CronError("invalid_clock", "database clock is invalid");
  }
  return value;
}

function resolveJitter(options: TickOptions): number {
  const next = options.nextJitterMs ?? defaultJitter;
  const value = next();
  if (!Number.isSafeInteger(value) || value < 0 || value > JITTER_MAX_MS) {
    throw new CronError("invalid_jitter", "jitter is invalid");
  }
  return value;
}

function defaultJitter(): number {
  return randomInt(0, JITTER_MAX_MS + 1);
}

async function waitJitter(options: TickOptions, ms: number): Promise<void> {
  const delay = options.delay ?? sleep;
  await delay(ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function requireSchedule(expression: string): string {
  if (typeof expression !== "string" || !isValidSchedule(expression)) {
    throw new CronError("invalid_schedule", "schedule is invalid");
  }
  return expression;
}

function requireMessage(message: string): string {
  if (typeof message !== "string" || message.length < 1 || message.length > MESSAGE_MAX) {
    throw new CronError("invalid_message", "cron message is invalid");
  }
  if (message.includes("\0")) {
    throw new CronError("invalid_message", "cron message is invalid");
  }
  return message;
}

function requireTenant(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new CronError("invalid_tenant", "tenant is invalid");
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const digit = code >= 48 && code <= 57;
    const lower = code >= 97 && code <= 122;
    const dash = code === 45;
    const under = code === 95;
    if (!digit && !lower && !dash && !under) {
      throw new CronError("invalid_tenant", "tenant is invalid");
    }
  }
  return value;
}

function requireChat(value: bigint): string {
  if (typeof value !== "bigint" || value < INT8_MIN || value > INT8_MAX) {
    throw new CronError("invalid_chat", "pause chat is invalid");
  }
  return value.toString();
}

function requireInsertedId(rows: readonly Record<string, unknown>[]): string {
  const id = rows.length === 1 ? rows[0]?.id : undefined;
  return requireUuid(id, "invalid_row", "cron job insert returned no row");
}

function requireRow(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
  const row = rows[0];
  if (row === undefined || rows.length !== 1) {
    throw new CronError("not_found", "cron job is missing");
  }
  return row;
}

function requireKind(value: unknown): "script" | "agent" {
  if (value === "script" || value === "agent") {
    return value;
  }
  throw new CronError("invalid_row", "cron kind is invalid");
}

function requireCommand(value: unknown): readonly string[] | null {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new CronError("invalid_row", "cron command is invalid");
  }
  const command: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new CronError("invalid_row", "cron command is invalid");
    }
    command.push(item);
  }
  return command;
}

function requireChatColumn(value: unknown): string {
  if (typeof value !== "string" || !isCanonicalInt8(value)) {
    throw new CronError("invalid_row", "pause chat is invalid");
  }
  return value;
}

function isCanonicalInt8(value: string): boolean {
  if (value.length < 1 || value.length > 20) {
    return false;
  }
  const digitsStart = value.charCodeAt(0) === 45 ? 1 : 0;
  if (digitsStart === value.length) {
    return false;
  }
  for (let index = digitsStart; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) {
      return false;
    }
  }
  const parsed = BigInt(value);
  return parsed >= INT8_MIN && parsed <= INT8_MAX && parsed.toString() === value;
}

function requireUuid(value: unknown, code: string, message: string): string {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new CronError(code, message);
  }
  return value;
}

function requireNullableUuid(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return requireUuid(value, "invalid_row", "cron id is invalid");
}

function isUuid(value: string): boolean {
  if (value.length !== 36) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const hyphenAt = index === 8 || index === 13 || index === 18 || index === 23;
    if (hyphenAt) {
      if (code !== 45) {
        return false;
      }
      continue;
    }
    const digit = code >= 48 && code <= 57;
    const lower = code >= 97 && code <= 102;
    const upper = code >= 65 && code <= 70;
    if (!digit && !lower && !upper) {
      return false;
    }
  }
  return true;
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new CronError("invalid_row", message);
  }
  return value;
}

function requireNullableText(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return requireText(value, "cron text is invalid");
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new CronError("invalid_row", "cron flag is invalid");
  }
  return value;
}

function requireInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CronError("invalid_row", "cron counter is invalid");
  }
  return value;
}

function requireNullableDate(value: unknown): Date | null {
  if (value === null) {
    return null;
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new CronError("invalid_row", "cron time is invalid");
  }
  return value;
}
