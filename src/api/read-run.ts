import type { Sql } from "../db/client.js";
import { runPayloadSchema, type RunPayload } from "../contracts/payload.js";
import {
  PROVIDERS,
  RUN_STATUSES,
  SOURCES,
  STEP_KINDS,
  type Provider,
  type RunStatus,
  type Source,
  type StepKind,
} from "../contracts/types.js";
import { parseDecimalChatId } from "./chat-id.js";
import { ApiError } from "./errors.js";

/** M1 знает один арендатор. Фильтр всё равно стоит в запросе. */
const LOCAL_TENANT = "local";

export interface RunJson {
  id: string;
  tenant_id: string;
  agent_id: string;
  parent_run_id: string | null;
  source: Source;
  status: RunStatus;
  priority: number;
  deadline_at: string | null;
  not_before: string | null;
  chat_id: string | null;
  payload: RunPayload;
  idempotency_key: string;
  attempt: number;
  max_attempts: number;
  locked_by: string | null;
  locked_until: string | null;
  model_alias: string | null;
  provider: Provider | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  error: string | null;
  final_text: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface StepJson {
  id: string;
  run_id: string;
  step_index: number;
  kind: StepKind;
  tool_name: string | null;
  request_excerpt: string | null;
  response_excerpt: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  error: string | null;
  created_at: string;
}

export interface RunView {
  run: RunJson;
  steps: StepJson[];
}

/**
 * Чтение запуска для HTTP. Журнал не меняется: шаг пишет раннер.
 * Транзакция короткая, модель внутри неё не вызывается.
 */
export async function readRunWithSteps(sql: Sql, runId: string): Promise<RunView | null> {
  return sql.begin(async (tx) => {
    const runs = await tx<Record<string, unknown>[]>`
      select
        id,
        tenant_id,
        agent_id,
        parent_run_id,
        source,
        status,
        priority,
        deadline_at,
        not_before,
        chat_id,
        payload,
        idempotency_key,
        attempt,
        max_attempts,
        locked_by,
        locked_until,
        model_alias,
        provider,
        prompt_tokens,
        completion_tokens,
        error,
        final_text,
        created_at,
        started_at,
        finished_at
      from runs
      where id = ${runId}
        and tenant_id = ${LOCAL_TENANT}
    `;
    const row = runs[0];
    if (row === undefined) {
      return null;
    }

    const steps = await tx<Record<string, unknown>[]>`
      select
        id,
        run_id,
        step_index,
        kind,
        tool_name,
        request_excerpt,
        response_excerpt,
        prompt_tokens,
        completion_tokens,
        error,
        created_at
      from run_steps
      where run_id = ${runId}
      order by step_index asc
    `;

    return {
      run: mapRun(row),
      steps: steps.map((step) => mapStep(step)),
    };
  });
}

export async function findLocalAgentId(sql: Sql, slug: string): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    select id
    from agents
    where tenant_id = ${LOCAL_TENANT}
      and slug = ${slug}
  `;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  if (rows.length !== 1 || typeof row.id !== "string" || row.id.length === 0) {
    throw new ApiError("internal_error");
  }
  return row.id;
}

function mapRun(row: Record<string, unknown>): RunJson {
  const tenantId = requireText(row.tenant_id);
  if (tenantId !== LOCAL_TENANT) {
    throw new ApiError("internal_error");
  }
  return {
    id: requireText(row.id),
    tenant_id: tenantId,
    agent_id: requireText(row.agent_id),
    parent_run_id: requireTextOrNull(row.parent_run_id),
    source: requireSource(row.source),
    status: requireRunStatus(row.status),
    priority: requireInteger(row.priority),
    deadline_at: requireIsoOrNull(row.deadline_at),
    not_before: requireIsoOrNull(row.not_before),
    chat_id: requireChatId(row.chat_id),
    payload: requirePayload(row.payload),
    idempotency_key: requireText(row.idempotency_key),
    attempt: requireInteger(row.attempt),
    max_attempts: requireInteger(row.max_attempts),
    locked_by: requireTextOrNull(row.locked_by),
    locked_until: requireIsoOrNull(row.locked_until),
    model_alias: requireTextOrNull(row.model_alias),
    provider: requireProvider(row.provider),
    prompt_tokens: requireIntegerOrNull(row.prompt_tokens),
    completion_tokens: requireIntegerOrNull(row.completion_tokens),
    error: requireTextOrNull(row.error),
    final_text: requireTextOrNull(row.final_text),
    created_at: requireIso(row.created_at),
    started_at: requireIsoOrNull(row.started_at),
    finished_at: requireIsoOrNull(row.finished_at),
  };
}

function mapStep(row: Record<string, unknown>): StepJson {
  return {
    id: requireText(row.id),
    run_id: requireText(row.run_id),
    step_index: requireInteger(row.step_index),
    kind: requireStepKind(row.kind),
    tool_name: requireTextOrNull(row.tool_name),
    request_excerpt: requireTextOrNull(row.request_excerpt),
    response_excerpt: requireTextOrNull(row.response_excerpt),
    prompt_tokens: requireIntegerOrNull(row.prompt_tokens),
    completion_tokens: requireIntegerOrNull(row.completion_tokens),
    error: requireTextOrNull(row.error),
    created_at: requireIso(row.created_at),
  };
}

function requirePayload(value: unknown): RunPayload {
  const parsed = runPayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError("internal_error");
  }
  return parsed.data;
}

/**
 * int8 приходит десятичной строкой из драйвера.
 * Number() не вызывается: идентификатор Telegram не помещается в точное целое.
 */
function requireChatId(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ApiError("internal_error");
  }
  const parsed = parseDecimalChatId(value);
  if (parsed === null) {
    throw new ApiError("internal_error");
  }
  return parsed.toString();
}

function requireRunStatus(value: unknown): RunStatus {
  if (typeof value === "string" && isListed(RUN_STATUSES, value)) {
    return value;
  }
  throw new ApiError("internal_error");
}

function requireSource(value: unknown): Source {
  if (typeof value === "string" && isListed(SOURCES, value)) {
    return value;
  }
  throw new ApiError("internal_error");
}

function requireProvider(value: unknown): Provider | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" && isListed(PROVIDERS, value)) {
    return value;
  }
  throw new ApiError("internal_error");
}

function requireStepKind(value: unknown): StepKind {
  if (typeof value === "string" && isListed(STEP_KINDS, value)) {
    return value;
  }
  throw new ApiError("internal_error");
}

function isListed<T extends string>(options: readonly T[], value: string): value is T {
  for (const option of options) {
    if (option === value) {
      return true;
    }
  }
  return false;
}

function requireText(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError("internal_error");
  }
  return value;
}

function requireTextOrNull(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return requireText(value);
}

function requireInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ApiError("internal_error");
  }
  return value;
}

function requireIntegerOrNull(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  return requireInteger(value);
}

function requireIso(value: unknown): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ApiError("internal_error");
  }
  return value.toISOString();
}

function requireIsoOrNull(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return requireIso(value);
}
