import type { Sql } from "../db/client.js";
import { runPayloadSchema, type RunPayload } from "../contracts/payload.js";
import type {
  ClaimedRun,
  EnqueueInput,
  EnqueueResult,
  FinishOutcome,
  Provider,
  RunQueue,
  RunRecord,
  RunStatus,
  Source,
} from "../contracts/types.js";

/**
 * Очередь запусков на Postgres.
 * Клиент модели сюда не импортируется: захват коммитится своим оператором.
 */
export class QueueError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "QueueError";
    this.code = code;
  }
}

export function createRunQueue(sql: Sql): RunQueue {
  const queue: RunQueue = {
    enqueue(input) {
      return enqueueRun(sql, input);
    },
    claimNext(workerId, leaseSeconds) {
      return claimNextRun(sql, workerId, leaseSeconds);
    },
    heartbeat(runId, workerId, leaseSeconds) {
      return heartbeatRun(sql, runId, workerId, leaseSeconds);
    },
    reapExpired() {
      return reapExpiredRuns(sql);
    },
    finish(runId, workerId, outcome) {
      return finishRun(sql, runId, workerId, outcome);
    },
  };
  return queue;
}

/**
 * Одна транзакция: блокировка ключа идемпотентности, затем живой диалог, затем insert.
 * Проверка и вставка разными авто-коммитами дают два запуска.
 */
async function enqueueRun(sql: Sql, input: EnqueueInput): Promise<EnqueueResult> {
  const chatId = input.chatId;
  const parentRunId = parentRunIdForInsert(input.parentRunId);
  return sql.begin(async (tx) => {
    const existing = await tx<Record<string, unknown>[]>`
      select *
      from runs
      where agent_id = ${input.agentId}
        and idempotency_key = ${input.idempotencyKey}
      for update
    `;
    const replay = existing[0];
    if (replay !== undefined) {
      return { run: mapRun(replay), created: false, reason: "replay" };
    }

    if (chatId !== null) {
      const busy = await tx<Record<string, unknown>[]>`
        select *
        from runs
        where agent_id = ${input.agentId}
          and chat_id = ${tx.types.chat_id(chatId.toString())}
          and status in ('queued', 'running')
        order by created_at asc
        for update
      `;
      const live = busy[0];
      if (live !== undefined) {
        return { run: mapRun(live), created: false, reason: "dialog_busy" };
      }
    }

    const priority = priorityForInsert(input.priority);
    const payload = requirePayload({ message: input.message });
    const inserted = await tx<Record<string, unknown>[]>`
      insert into runs (
        tenant_id,
        agent_id,
        parent_run_id,
        source,
        status,
        priority,
        chat_id,
        payload,
        idempotency_key,
        attempt
      ) values (
        ${input.tenantId},
        ${input.agentId},
        ${parentRunId},
        ${input.source},
        'queued',
        ${priority},
        ${chatId === null ? null : tx.types.chat_id(chatId.toString())},
        ${tx.json(payload)},
        ${input.idempotencyKey},
        0
      )
      returning *
    `;
    const insertedRow = inserted[0];
    if (insertedRow === undefined) {
      throw new QueueError("invalid_run_row", "enqueue insert returned no row");
    }
    return { run: mapRun(insertedRow), created: true, reason: "created" };
  });
}

/**
 * Захват — один UPDATE. Соединение отпускается вместе с оператором, до вызова модели.
 * Аренда считается через now() Postgres, не через часы процесса.
 */
async function claimNextRun(
  sql: Sql,
  workerId: string,
  leaseSeconds: number,
): Promise<ClaimedRun | null> {
  const rows = await sql<Record<string, unknown>[]>`
    update runs
    set status = 'running',
        locked_by = ${workerId},
        locked_until = now() + make_interval(secs => ${leaseSeconds}),
        attempt = attempt + 1,
        started_at = coalesce(started_at, now())
    where id = (
      select id
      from runs
      where status = 'queued'
        and attempt < max_attempts
        and (not_before is null or not_before <= now())
      order by priority asc, created_at asc
      for update skip locked
      limit 1
    )
    returning *
  `;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return requireClaimed(mapRun(row));
}

/**
 * Продлевает аренду только у running с тем же locked_by.
 * Ноль строк значит, что лок уже потерян.
 */
async function heartbeatRun(
  sql: Sql,
  runId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const updated = await sql<{ id: string }[]>`
    update runs
    set locked_until = now() + make_interval(secs => ${leaseSeconds})
    where id = ${runId}
      and locked_by = ${workerId}
      and status = 'running'
    returning id
  `;
  return updated.length === 1;
}

/**
 * Просроченная аренда возвращается в queued, attempt не сбрасывается.
 * При attempt >= max_attempts строка становится failed, error = lease expired.
 */
async function reapExpiredRuns(sql: Sql): Promise<number> {
  const updated = await sql`
    update runs
    set status = case when attempt >= max_attempts then 'failed' else 'queued' end,
        error = case when attempt >= max_attempts then 'lease expired' else error end,
        finished_at = case when attempt >= max_attempts then now() else finished_at end,
        locked_by = null,
        locked_until = null
    where status = 'running'
      and locked_until is not null
      and locked_until < now()
  `;
  return requireInteger(updated.count);
}

/**
 * Пишет итог только пока строка running у этого workerId.
 * Иначе false: чужой воркер не ставит succeeded и не снимает чужой лок.
 */
async function finishRun(
  sql: Sql,
  runId: string,
  workerId: string,
  outcome: FinishOutcome,
): Promise<boolean> {
  assertFinishOutcome(outcome);
  const updated = await sql<{ id: string }[]>`
    update runs
    set status = ${outcome.status},
        final_text = ${outcome.finalText},
        error = ${outcome.error},
        model_alias = ${outcome.modelAlias},
        provider = ${outcome.provider},
        prompt_tokens = ${outcome.promptTokens},
        completion_tokens = ${outcome.completionTokens},
        finished_at = now(),
        locked_by = null,
        locked_until = null
    where id = ${runId}
      and locked_by = ${workerId}
      and status = 'running'
    returning id
  `;
  return updated.length === 1;
}

function priorityForInsert(value: number | undefined): number {
  const priority = value ?? 100;
  if (!Number.isSafeInteger(priority)) {
    throw new QueueError("invalid_priority", "priority is invalid");
  }
  return priority;
}

/**
 * Необязательный родитель пишется в уже существующую колонку.
 * Захват этот идентификатор не разбирает и отдельный процесс под него не стартует.
 */
function parentRunIdForInsert(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !isUuid(value)) {
    throw new QueueError("invalid_parent_run", "parent run id is invalid");
  }
  return value;
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

function assertFinishOutcome(outcome: FinishOutcome): void {
  if (
    outcome.provider !== null &&
    outcome.provider !== "local" &&
    outcome.provider !== "external"
  ) {
    throw new QueueError("invalid_finish", "finish provider is invalid");
  }
  if (!isTokenCount(outcome.promptTokens) || !isTokenCount(outcome.completionTokens)) {
    throw new QueueError("invalid_finish", "finish tokens are invalid");
  }
}

function isTokenCount(value: number | null): boolean {
  return value === null || Number.isSafeInteger(value);
}

function requireClaimed(run: RunRecord): ClaimedRun {
  if (run.status !== "running" || run.lockedBy === null || run.lockedUntil === null) {
    throw new QueueError("claim_shape", "claimed run is missing its lock");
  }
  return {
    ...run,
    status: "running",
    lockedBy: run.lockedBy,
    lockedUntil: run.lockedUntil,
  };
}

/**
 * int8 приходит десятичной строкой. bigint собирается из неё.
 * Конструктор Number для chat_id не вызывается: значение не помещается в точное целое.
 */
function mapRun(value: unknown): RunRecord {
  if (!isRow(value)) {
    throw new QueueError("invalid_run_row", "run row is missing");
  }

  const status = requireStatus(value.status);
  const source = requireSource(value.source);
  return {
    id: requireText(value.id),
    tenantId: requireText(value.tenant_id),
    agentId: requireText(value.agent_id),
    parentRunId: requireNullableText(value.parent_run_id),
    source,
    status,
    priority: requireInteger(value.priority),
    deadlineAt: requireNullableDate(value.deadline_at),
    notBefore: requireNullableDate(value.not_before),
    chatId: requireChatId(value.chat_id),
    payload: requirePayload(value.payload),
    idempotencyKey: requireText(value.idempotency_key),
    attempt: requireInteger(value.attempt),
    maxAttempts: requireInteger(value.max_attempts),
    lockedBy: requireNullableText(value.locked_by),
    lockedUntil: requireNullableDate(value.locked_until),
    modelAlias: requireNullableText(value.model_alias),
    provider: requireProvider(value.provider),
    promptTokens: requireNullableInteger(value.prompt_tokens),
    completionTokens: requireNullableInteger(value.completion_tokens),
    error: requireNullableText(value.error),
    finalText: requireNullableText(value.final_text),
    createdAt: requireDate(value.created_at),
    startedAt: requireNullableDate(value.started_at),
    finishedAt: requireNullableDate(value.finished_at),
  };
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePayload(value: unknown): RunPayload {
  const parsed = runPayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new QueueError("invalid_payload", "run payload is invalid");
  }
  return parsed.data;
}

function requireStatus(value: unknown): RunStatus {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new QueueError("invalid_run_status", "run status is invalid");
}

function requireSource(value: unknown): Source {
  if (value === "api" || value === "telegram" || value === "cron" || value === "delegation") {
    return value;
  }
  throw new QueueError("invalid_run_source", "run source is invalid");
}

function requireProvider(value: unknown): Provider | null {
  if (value === null) {
    return null;
  }
  if (value === "local" || value === "external") {
    return value;
  }
  throw new QueueError("invalid_provider", "run provider is invalid");
}

function requireChatId(value: unknown): bigint | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !isCanonicalInt8(value)) {
    throw new QueueError("invalid_chat_id", "chat_id is not a decimal bigint");
  }
  return BigInt(value);
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
  return BigInt(value).toString() === value;
}

function requireText(value: unknown): string {
  if (typeof value !== "string") {
    throw new QueueError("invalid_run_row", "run column is invalid");
  }
  return value;
}

function requireNullableText(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return requireText(value);
}

function requireInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new QueueError("invalid_run_row", "run column is invalid");
  }
  return value;
}

function requireNullableInteger(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  return requireInteger(value);
}

function requireDate(value: unknown): Date {
  const parsed = requireNullableDate(value);
  if (parsed === null) {
    throw new QueueError("invalid_run_row", "run column is invalid");
  }
  return parsed;
}

function requireNullableDate(value: unknown): Date | null {
  if (value === null) {
    return null;
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new QueueError("invalid_run_row", "run column is invalid");
  }
  return value;
}
