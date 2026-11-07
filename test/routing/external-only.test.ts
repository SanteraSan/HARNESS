import { randomUUID } from "node:crypto";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { Provider, ToolEffect } from "../../src/contracts/types.js";
import { resolveModel, type ResolveModelAgent } from "../../src/routing/resolve.js";
import { sql } from "../helpers/db.js";

const CLERK_ID = "00000000-0000-4000-8000-000000000001";
const EXTERNAL = { modelAlias: "coder-cloud", provider: "external" } as const;
const LOCAL = { modelAlias: "agent", provider: "local" } as const;

describe("external only route rules", () => {
  it("должен не вернуть локальный алиас после набора external_only", async () => {
    await applyExternalOnly();

    const rules = await sql<{ kind: string; model_alias: string; provider: string }[]>`
      select kind, model_alias, provider
      from route_rules
      where agent_id = ${CLERK_ID}
      order by kind
    `;
    expect(rules).toEqual([
      { kind: "second_parse_error", model_alias: "coder-cloud", provider: "external" },
      { kind: "write_tool", model_alias: "coder-cloud", provider: "external" },
    ]);

    const localRules = await sql<{ count: number }[]>`
      select count(*)::int as count
      from route_rules
      where provider <> 'external'
         or model_alias = 'agent'
         or btrim(model_alias) = ''
    `;
    expect(localRules[0]?.count).toBe(0);

    const clerk = await agentById(CLERK_ID);
    expect(clerk).toMatchObject({
      id: CLERK_ID,
      tenantId: "local",
      ...EXTERNAL,
    });

    const turns: readonly (readonly ToolEffect[])[] = [[], ["read"], ["write"], ["read", "write"]];
    for (const toolEffects of turns) {
      await expect(resolveModel(sql, clerk, { toolEffects })).resolves.toEqual(EXTERNAL);
    }

    await insertRecentParseError(CLERK_ID);
    await expect(resolveModel(sql, clerk, { toolEffects: [] })).resolves.toEqual(EXTERNAL);
    await expect(resolveModel(sql, clerk, { toolEffects: ["read"] })).resolves.toEqual(EXTERNAL);
  });

  it("должен вернуть локальный алиас клерка, пока набор external_only не применён", async () => {
    const rules = await sql<{ count: number }[]>`
      select count(*)::int as count
      from route_rules
    `;
    expect(rules[0]?.count).toBe(0);

    const clerk = await agentById(CLERK_ID);
    expect(clerk).toMatchObject({
      id: CLERK_ID,
      tenantId: "local",
      ...LOCAL,
    });
    await expect(resolveModel(sql, clerk, { toolEffects: [] })).resolves.toEqual(LOCAL);
    await expect(resolveModel(sql, clerk, { toolEffects: ["read"] })).resolves.toEqual(LOCAL);
    await expect(resolveModel(sql, clerk, { toolEffects: ["write"] })).resolves.toEqual(LOCAL);
  });

  it("должен оставить локальный алиас агенту вне этого набора", async () => {
    await applyExternalOnly();
    const otherId = randomUUID();
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
        ${otherId},
        'local',
        ${`outsider-${otherId}`},
        'Вне набора',
        'prompt',
        'agent',
        'local',
        8,
        array['read_file', 'list_dir']::text[]
      )
    `;

    const other = await agentById(otherId);
    expect(other.provider).toBe("local" satisfies Provider);
    await expect(resolveModel(sql, other, { toolEffects: [] })).resolves.toEqual(LOCAL);
    await expect(resolveModel(sql, other, { toolEffects: ["write"] })).resolves.toEqual(LOCAL);

    const clerk = await agentById(CLERK_ID);
    await expect(resolveModel(sql, clerk, { toolEffects: ["write"] })).resolves.toEqual(EXTERNAL);
  });
});

function applyExternalOnly(): Promise<unknown> {
  return sql.file(path.resolve(import.meta.dirname, "../../seed/external_only.sql"));
}

async function agentById(agentId: string): Promise<ResolveModelAgent> {
  const rows = await sql<{ tenant_id: string; model_alias: string; provider: string }[]>`
    select tenant_id, model_alias, provider
    from agents
    where id = ${agentId}
  `;
  const row = rows[0];
  if (row === undefined || rows.length !== 1) {
    throw new Error("agent row is missing");
  }
  if (row.provider !== "local" && row.provider !== "external") {
    throw new Error("agent provider is invalid");
  }
  return {
    id: agentId,
    tenantId: row.tenant_id,
    modelAlias: row.model_alias,
    provider: row.provider,
  };
}

async function insertRecentParseError(agentId: string): Promise<void> {
  const inserted = await sql<{ id: string }[]>`
    insert into runs (
      tenant_id,
      agent_id,
      source,
      status,
      payload,
      idempotency_key
    ) values (
      'local',
      ${agentId},
      'api',
      'failed',
      ${sql.json({ message: "ход" })},
      ${`parse-external-only-${randomUUID()}`}
    )
    returning id
  `;
  const runId = inserted[0]?.id;
  if (runId === undefined) {
    throw new Error("parse error run was not inserted");
  }
  await sql`
    insert into run_steps (run_id, step_index, kind)
    values (${runId}, 0, 'parse_error')
  `;
}
