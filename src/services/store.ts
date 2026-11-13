import type { Sql } from "../db/client.js";
import type { ReportStep } from "./report.js";

export type InvocationStatus = "pending" | "completed" | "timeout" | "transport_error" | "abandoned";

export type TransportCode =
  | "timeout"
  | "connection_error"
  | "payload_too_large"
  | "unknown_field"
  | "invalid_envelope"
  | "echo_mismatch"
  | "unauthorized"
  | "idempotency_conflict"
  | "http_error";

export interface StoredInvocation {
  id: string;
  status: InvocationStatus;
  nonce: string;
}

export interface StoredToolText {
  ok: boolean;
  excerpt: string;
}

interface FinishInput {
  id: string;
  workerId: string;
  status: Exclude<InvocationStatus, "pending" | "abandoned">;
  transportCode: TransportCode | null;
  httpStatus: number | null;
  responseBytes: number | null;
  result: ResultInput | null;
}

export interface ResultInput {
  ok: boolean;
  errorCode: string | null;
  excerpt: string;
  truncated: boolean;
  reportStatus: "absent" | "valid" | "invalid";
  report: unknown;
  claimedDurationMs: number;
  claimedPromptTokens: number | null;
  claimedCompletionTokens: number | null;
  claimedCostUsd: string | null;
  claimedFinishReason: string | null;
  steps: ReportStep[];
}

export async function findInvocation(
  sql: Sql,
  runId: string,
  toolCallId: string,
): Promise<StoredInvocation | null> {
  const rows = await sql<{ id: string; status: InvocationStatus; nonce: string }[]>`
    select id, status, nonce::text as nonce
    from service_invocations
    where run_id = ${runId}
      and tool_call_id = ${toolCallId}
  `;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return row;
}

export async function insertPending(
  sql: Sql,
  input: {
    id: string;
    tenantId: string;
    serviceId: string;
    runId: string;
    toolCallId: string;
    requestSha256: Buffer;
    nonce: string;
    workerId: string;
  },
): Promise<void> {
  await sql`
    insert into service_invocations (
      id, tenant_id, service_id, run_id, tool_call_id,
      request_sha256, nonce, worker_id, status
    ) values (
      ${input.id},
      ${input.tenantId},
      ${input.serviceId},
      ${input.runId},
      ${input.toolCallId},
      ${input.requestSha256},
      ${input.nonce},
      ${input.workerId},
      'pending'
    )
  `;
}

/** Ноль строк: лок уже не наш. Результат и succeeded отсюда не пишутся. */
export async function finishInvocation(sql: Sql, input: FinishInput): Promise<boolean> {
  return sql.begin(async (tx) => {
    const updated = await tx<{ id: string }[]>`
      update service_invocations
      set status = ${input.status},
          finished_at = now(),
          hub_duration_ms = greatest(
            0,
            floor(extract(epoch from (now() - started_at)) * 1000)::integer
          ),
          http_status = ${input.httpStatus},
          transport_code = ${input.transportCode},
          response_bytes = ${input.responseBytes}
      where id = ${input.id}
        and status = 'pending'
        and worker_id = ${input.workerId}
        and exists (
          select 1
          from runs
          where runs.id = service_invocations.run_id
            and runs.status = 'running'
            and runs.locked_by = ${input.workerId}
        )
      returning id
    `;
    if (updated.length === 0) {
      return false;
    }
    const result = input.result;
    if (result === null) {
      return true;
    }
    await tx`
      insert into service_results (
        invocation_id, ok, error_code, excerpt, truncated, report_status, report,
        claimed_duration_ms, claimed_prompt_tokens, claimed_completion_tokens,
        claimed_cost_usd, claimed_finish_reason
      ) values (
        ${input.id},
        ${result.ok},
        ${result.errorCode},
        ${result.excerpt},
        ${result.truncated},
        ${result.reportStatus},
        ${result.report == null ? null : tx.json(asJson(result.report))},
        ${result.claimedDurationMs},
        ${result.claimedPromptTokens},
        ${result.claimedCompletionTokens},
        ${result.claimedCostUsd},
        ${result.claimedFinishReason}
      )
    `;
    for (const step of result.steps) {
      await tx`
        insert into service_model_steps (
          invocation_id, step_index, excerpt, finish_reason,
          claimed_prompt_tokens, claimed_completion_tokens, claimed_cost_usd, tool_calls
        ) values (
          ${input.id},
          ${step.stepIndex},
          ${step.excerpt},
          ${step.finishReason},
          ${step.claimedPromptTokens},
          ${step.claimedCompletionTokens},
          ${step.claimedCostUsd},
          ${step.toolCalls === null ? null : tx.json(asJson(step.toolCalls))}
        )
      `;
    }
    return true;
  });
}

export async function loadStoredText(sql: Sql, invocationId: string): Promise<StoredToolText | null> {
  const rows = await sql<{ ok: boolean; excerpt: string }[]>`
    select ok, excerpt
    from service_results
    where invocation_id = ${invocationId}
  `;
  return rows[0] ?? null;
}

/**
 * pending без живого лока становится abandoned.
 * jsonb старше 30 суток обнуляется, не больше 20 строк. succeeded не ставится.
 */
export async function maintainServiceRows(sql: Sql): Promise<void> {
  await sql`
    update service_invocations
    set status = 'abandoned', finished_at = now()
    where id in (
      select invocation.id
      from service_invocations as invocation
      where invocation.status = 'pending'
        and not exists (
          select 1
          from runs
          where runs.id = invocation.run_id
            and runs.status = 'running'
            and runs.locked_by = invocation.worker_id
        )
      limit 20
    )
  `;
  await sql`
    update service_results
    set report = null
    where invocation_id in (
      select result.invocation_id
      from service_results as result
      join service_invocations as invocation on invocation.id = result.invocation_id
      where result.report is not null
        and invocation.finished_at < now() - interval '30 days'
      limit 20
    )
  `;
}

function asJson(value: unknown): Parameters<Sql["json"]>[0] {
  return JSON.parse(JSON.stringify(value)) as Parameters<Sql["json"]>[0];
}
