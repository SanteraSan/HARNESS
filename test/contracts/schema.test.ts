import { describe, expect, it } from "vitest";

import { applyMigrations, migrationsDirectory } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import { sql } from "../helpers/db.js";

const LOCAL_AGENT_ID = "00000000-0000-4000-8000-000000000001";

describe("migration 001", () => {
  it("должен оставить одну копию таблиц после двух запусков", async () => {
    const config = loadConfig();
    const databaseUrl = config.harnessTestDatabaseUrl;
    if (databaseUrl === null) {
      throw new Error("HARNESS_TEST_DATABASE_URL is required");
    }

    const first = await applyMigrations(databaseUrl, migrationsDirectory());
    const second = await applyMigrations(databaseUrl, migrationsDirectory());
    expect(first).toEqual([]);
    expect(second).toEqual([]);

    const tables = await sql<{ relname: string }[]>`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relname in ('agents', 'runs', 'run_steps', 'schema_migrations')
      order by c.relname
    `;
    expect(tables.map((row) => row.relname)).toEqual([
      "agents",
      "run_steps",
      "runs",
      "schema_migrations",
    ]);

    const versions = await sql<{ version: string }[]>`
      select version from schema_migrations order by version
    `;
    expect(versions.map((row) => row.version)).toEqual([
      "001_init.sql",
      "002_route.sql",
      "003_tasks.sql",
      "004_cron.sql",
      "005_dialog_buffer.sql",
      "006_connector_secrets.sql",
    ]);

    const agents = await sql<{ count: number }[]>`select count(*)::int as count from agents`;
    expect(agents[0]?.count).toBe(1);

    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
        and indexname in ('runs_claim_idx', 'runs_dialog_idx')
      order by indexname
    `;
    expect(indexes.map((row) => row.indexname)).toEqual(["runs_claim_idx", "runs_dialog_idx"]);
    expect(indexes[0]?.indexdef).toContain("queued");
    expect(indexes[1]?.indexdef.toLowerCase()).toContain("chat_id");
  });

  it("должен принять source = cron и сохранить chat_id строкой", async () => {
    const chatId = "1234567890123456789";
    await sql`
      insert into runs (
        tenant_id,
        agent_id,
        source,
        status,
        payload,
        idempotency_key,
        chat_id
      ) values (
        'local',
        ${LOCAL_AGENT_ID},
        'cron',
        'queued',
        ${sql.json({ message: "tick" })},
        'cron-ok',
        ${sql.types.chat_id(chatId)}
      )
    `;

    const rows = await sql<{ source: string; chat_id: string }[]>`
      select source, chat_id
      from runs
      where idempotency_key = 'cron-ok'
    `;
    expect(rows[0]?.source).toBe("cron");
    expect(rows[0]?.chat_id).toBe(chatId);
    expect(typeof rows[0]?.chat_id).toBe("string");
  });

  it("должен отказать произвольной строке source", async () => {
    const insertArbitrary = sql`
      insert into runs (
        tenant_id,
        agent_id,
        source,
        status,
        payload,
        idempotency_key
      ) values (
        'local',
        ${LOCAL_AGENT_ID},
        'nope',
        'queued',
        ${sql.json({ message: "no" })},
        'bad-source'
      )
    `;

    await expect(insertArbitrary).rejects.toMatchObject({ code: "23514" });

    const rows = await sql<{ count: number }[]>`
      select count(*)::int as count from runs where idempotency_key = 'bad-source'
    `;
    expect(rows[0]?.count).toBe(0);
  });

  it("должен засеять клерка с алиасом agent", async () => {
    const rows = await sql<
      {
        id: string;
        tenant_id: string;
        slug: string;
        model_alias: string;
        provider: string;
        max_steps: number;
        tool_allowlist: string[];
        prompt_length: number;
      }[]
    >`
      select
        id,
        tenant_id,
        slug,
        model_alias,
        provider,
        max_steps,
        tool_allowlist,
        char_length(system_prompt)::int as prompt_length
      from agents
    `;
    const agent = rows[0];
    expect(agent?.id).toBe(LOCAL_AGENT_ID);
    expect(agent?.tenant_id).toBe("local");
    expect(agent?.slug).toBe("clerk");
    expect(agent?.model_alias).toBe("agent");
    expect(agent?.provider).toBe("local");
    expect(agent?.max_steps).toBe(8);
    expect(agent?.tool_allowlist).toEqual(["read_file", "list_dir"]);
    expect(agent?.prompt_length).toBeGreaterThan(0);
    expect(agent?.prompt_length).toBeLessThanOrEqual(800);
  });
});
