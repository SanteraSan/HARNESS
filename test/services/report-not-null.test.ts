import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { maintainServiceRows } from "../../src/services/store.js";
import { sql } from "../helpers/db.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";

describe("service report not null", () => {
  it("должен отвергнуть вставку report_status = valid при report is null", async () => {
    const invocationId = await insertCompletedInvocation("reject-null-report", false);

    const insert = sql`
      insert into service_results (
        invocation_id,
        ok,
        error_code,
        excerpt,
        truncated,
        report_status,
        report,
        claimed_duration_ms
      ) values (
        ${invocationId},
        true,
        null,
        'excerpt',
        false,
        'valid',
        null,
        0
      )
    `;

    await expect(insert).rejects.toMatchObject({
      code: "23514",
      constraint_name: "service_results_report_not_null",
    });

    const rows = await sql<{ count: number }[]>`
      select count(*)::int as count
      from service_results
      where invocation_id = ${invocationId}
    `;
    expect(rows[0]?.count).toBe(0);
  });

  it("должен принять valid с непустым report и absent с пустым report", async () => {
    const validId = await insertCompletedInvocation("accept-valid-report", false);
    await sql`
      insert into service_results (
        invocation_id,
        ok,
        error_code,
        excerpt,
        truncated,
        report_status,
        report,
        claimed_duration_ms,
        claimed_prompt_tokens
      ) values (
        ${validId},
        true,
        null,
        'excerpt',
        false,
        'valid',
        ${sql.json({ has_model: false })},
        0,
        1
      )
    `;

    const absentId = await insertCompletedInvocation("accept-absent-report", false);
    await sql`
      insert into service_results (
        invocation_id,
        ok,
        error_code,
        excerpt,
        truncated,
        report_status,
        report,
        claimed_duration_ms
      ) values (
        ${absentId},
        true,
        null,
        'excerpt',
        false,
        'absent',
        null,
        0
      )
    `;

    const rows = await sql<{ invocation_id: string; report_status: string }[]>`
      select invocation_id, report_status
      from service_results
      where invocation_id in (${validId}, ${absentId})
      order by report_status
    `;
    expect(rows.map((row) => row.report_status)).toEqual(["absent", "valid"]);
  });

  it("должен при уборке jsonb поставить absent и обнулить claimed", async () => {
    const oldId = await insertCompletedInvocation("clear-old-report", true);
    await sql`
      insert into service_results (
        invocation_id,
        ok,
        error_code,
        excerpt,
        truncated,
        report_status,
        report,
        claimed_duration_ms,
        claimed_prompt_tokens,
        claimed_completion_tokens,
        claimed_cost_usd,
        claimed_finish_reason
      ) values (
        ${oldId},
        true,
        null,
        'keep-excerpt',
        false,
        'valid',
        ${sql.json({ has_model: false })},
        10,
        12,
        3,
        '0',
        'stop'
      )
    `;
    await sql`
      insert into service_model_steps (invocation_id, step_index, excerpt)
      values (${oldId}, 0, 'keep-step')
    `;

    const freshId = await insertCompletedInvocation("keep-fresh-report", false);
    await sql`
      insert into service_results (
        invocation_id,
        ok,
        error_code,
        excerpt,
        truncated,
        report_status,
        report,
        claimed_duration_ms,
        claimed_prompt_tokens
      ) values (
        ${freshId},
        true,
        null,
        'fresh-excerpt',
        true,
        'valid',
        ${sql.json({ has_model: true })},
        4,
        7
      )
    `;

    await maintainServiceRows(sql);

    const old = await sql<
      {
        report_status: string;
        report: unknown;
        excerpt: string;
        ok: boolean;
        truncated: boolean;
        claimed_duration_ms: number;
        claimed_prompt_tokens: number | null;
        claimed_completion_tokens: number | null;
        claimed_cost_usd: string | null;
        claimed_finish_reason: string | null;
        run_status: string;
      }[]
    >`
      select
        result.report_status,
        result.report,
        result.excerpt,
        result.ok,
        result.truncated,
        result.claimed_duration_ms,
        result.claimed_prompt_tokens,
        result.claimed_completion_tokens,
        result.claimed_cost_usd::text as claimed_cost_usd,
        result.claimed_finish_reason,
        runs.status as run_status
      from service_results as result
      join service_invocations as invocation on invocation.id = result.invocation_id
      join runs on runs.id = invocation.run_id
      where result.invocation_id = ${oldId}
    `;
    expect(old[0]).toMatchObject({
      report_status: "absent",
      report: null,
      excerpt: "keep-excerpt",
      ok: true,
      truncated: false,
      claimed_duration_ms: 10,
      claimed_prompt_tokens: null,
      claimed_completion_tokens: null,
      claimed_cost_usd: null,
      claimed_finish_reason: null,
      run_status: "queued",
    });

    const steps = await sql<{ excerpt: string }[]>`
      select excerpt from service_model_steps where invocation_id = ${oldId}
    `;
    expect(steps).toEqual([{ excerpt: "keep-step" }]);

    const fresh = await sql<
      { report_status: string; report: unknown; claimed_prompt_tokens: number | null }[]
    >`
      select report_status, report, claimed_prompt_tokens
      from service_results
      where invocation_id = ${freshId}
    `;
    expect(fresh[0]?.report_status).toBe("valid");
    expect(fresh[0]?.report).toEqual({ has_model: true });
    expect(fresh[0]?.claimed_prompt_tokens).toBe(7);
  });
});

async function insertCompletedInvocation(key: string, olderThan30Days: boolean): Promise<string> {
  const runId = randomUUID();
  const invocationId = randomUUID();
  await sql`
    insert into runs (
      id,
      tenant_id,
      agent_id,
      source,
      status,
      payload,
      idempotency_key
    ) values (
      ${runId},
      'local',
      ${AGENT_ID},
      'api',
      'queued',
      ${sql.json({ message: key })},
      ${key}
    )
  `;
  if (olderThan30Days) {
    await sql`
      insert into service_invocations (
        id,
        tenant_id,
        service_id,
        run_id,
        tool_call_id,
        request_sha256,
        nonce,
        worker_id,
        status,
        finished_at
      ) values (
        ${invocationId},
        'local',
        'files',
        ${runId},
        ${`call-${key}`},
        ${Buffer.alloc(32, 9)},
        ${randomUUID()},
        'worker-report-test',
        'completed',
        now() - interval '31 days'
      )
    `;
    return invocationId;
  }
  await sql`
    insert into service_invocations (
      id,
      tenant_id,
      service_id,
      run_id,
      tool_call_id,
      request_sha256,
      nonce,
      worker_id,
      status,
      finished_at
    ) values (
      ${invocationId},
      'local',
      'files',
      ${runId},
      ${`call-${key}`},
      ${Buffer.alloc(32, 9)},
      ${randomUUID()},
      'worker-report-test',
      'completed',
      now()
    )
  `;
  return invocationId;
}
