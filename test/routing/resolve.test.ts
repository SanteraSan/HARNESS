import { randomUUID } from "node:crypto";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveModel } from "../../src/routing/resolve.js";
import { sql } from "../helpers/db.js";

const CLERK_ID = "00000000-0000-4000-8000-000000000001";

describe("resolveModel", () => {
  it("должен вернуть modelAlias и provider строки агента", async () => {
    await expect(
      resolveModel(
        sql,
        {
          id: randomUUID(),
          tenantId: "local",
          modelAlias: "agent",
          provider: "local",
        },
        { toolEffects: ["read"] },
      ),
    ).resolves.toEqual({
      modelAlias: "agent",
      provider: "local",
    });
  });

  it("должен вернуть внешний алиас как есть, если правила нет", async () => {
    await expect(
      resolveModel(
        sql,
        {
          id: randomUUID(),
          tenantId: "local",
          modelAlias: "openrouter/other",
          provider: "external",
        },
        { toolEffects: [] },
      ),
    ).resolves.toEqual({
      modelAlias: "openrouter/other",
      provider: "external",
    });
  });

  it("должен прочитать из сида алиас coder-cloud и оставить ход чтения локальным", async () => {
    await applyRouteRules();

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

    await expect(resolveClerk(["read"])).resolves.toEqual({
      modelAlias: "agent",
      provider: "local",
    });
  });

  it("должен выбрать coder-cloud на эффект write и остаться локальным без правила", async () => {
    await expect(resolveClerk(["write"])).resolves.toEqual({
      modelAlias: "agent",
      provider: "local",
    });

    await applyRouteRules();
    await expect(resolveClerk(["read", "write"])).resolves.toEqual({
      modelAlias: "coder-cloud",
      provider: "external",
    });
  });

  it("должен оставить первый parse_error локальным и увести следующий за сутки на внешний алиас", async () => {
    await applyRouteRules();
    await expect(resolveClerk([])).resolves.toEqual({
      modelAlias: "agent",
      provider: "local",
    });

    await insertParseError("recent");
    await expect(resolveClerk(["read"])).resolves.toEqual({
      modelAlias: "coder-cloud",
      provider: "external",
    });
  });

  it("должен не считать parse_error старше суток", async () => {
    await applyRouteRules();
    await insertParseError("old");
    await expect(resolveClerk([])).resolves.toEqual({
      modelAlias: "agent",
      provider: "local",
    });
  });

  it("должен отказать правилу с чужим kind и локальным provider", async () => {
    const badKind = sql`
      insert into route_rules (id, tenant_id, agent_id, kind, model_alias, provider)
      values (${randomUUID()}, 'local', ${CLERK_ID}, 'cron', 'coder-cloud', 'external')
    `;
    await expect(badKind).rejects.toMatchObject({ code: "23514" });

    const badProvider = sql`
      insert into route_rules (id, tenant_id, agent_id, kind, model_alias, provider)
      values (${randomUUID()}, 'local', ${CLERK_ID}, 'write_tool', 'coder-cloud', 'local')
    `;
    await expect(badProvider).rejects.toMatchObject({ code: "23514" });

    const left = await sql<{ count: number }[]>`
      select count(*)::int as count from route_rules
    `;
    expect(left[0]?.count).toBe(0);
  });

  it("должен хранить cost_usd как numeric", async () => {
    const columns = await sql<{ data_type: string }[]>`
      select data_type
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'run_steps'
        and column_name = 'cost_usd'
    `;
    expect(columns.map((column) => column.data_type)).toEqual(["numeric"]);
  });
});

function resolveClerk(toolEffects: readonly ("read" | "write")[]) {
  return resolveModel(
    sql,
    {
      id: CLERK_ID,
      tenantId: "local",
      modelAlias: "agent",
      provider: "local",
    },
    { toolEffects },
  );
}

async function applyRouteRules(): Promise<void> {
  await sql.file(path.resolve(import.meta.dirname, "../../seed/route_rules.sql"));
}

async function insertParseError(age: "recent" | "old"): Promise<void> {
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
      ${CLERK_ID},
      'api',
      'failed',
      ${sql.json({ message: "ход" })},
      ${`parse-${age}-${randomUUID()}`}
    )
    returning id
  `;
  const runId = inserted[0]?.id;
  if (runId === undefined) {
    throw new Error("parse error run was not inserted");
  }
  if (age === "old") {
    await sql`
      insert into run_steps (run_id, step_index, kind, created_at)
      values (${runId}, 0, 'parse_error', now() - interval '2 days')
    `;
    return;
  }
  await sql`
    insert into run_steps (run_id, step_index, kind)
    values (${runId}, 0, 'parse_error')
  `;
}
