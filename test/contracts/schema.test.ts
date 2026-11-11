import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { applyMigrations, listMigrationFiles, migrationsDirectory } from "../../src/db/migrate.js";
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
    const expectedVersions = [
      "001_init.sql",
      "002_route.sql",
      "003_tasks.sql",
      "004_cron.sql",
      "005_dialog_buffer.sql",
      "006_connector_secrets.sql",
      "007_chat_model.sql",
      "008_completion_limit.sql",
    ];
    expect(versions.map((row) => row.version)).toEqual(expectedVersions);
    expect(await listMigrationFiles(migrationsDirectory())).toEqual(expectedVersions);

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

  it("должен ставить меньший числовой префикс раньше, когда сортировка без компаратора путает порядок", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-migrations-"));
    try {
      // Код единицы меньше кода двойки, поэтому sort() без компаратора ставит 10 раньше 2.
      await writeFile(path.join(dir, "10_later.sql"), "select 1;\n", "utf8");
      await writeFile(path.join(dir, "2_earlier.sql"), "select 1;\n", "utf8");
      expect(await listMigrationFiles(dir)).toEqual(["2_earlier.sql", "10_later.sql"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("должен при равном числовом префиксе сортировать полные имена без локали машины", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-migrations-tie-"));
    try {
      // Числовое сравнение 2 и 02 даёт 0. Код «0» меньше кода «2», поэтому 02 раньше 2.
      await writeFile(path.join(dir, "10_later.sql"), "select 1;\n", "utf8");
      await writeFile(path.join(dir, "2_step.sql"), "select 1;\n", "utf8");
      await writeFile(path.join(dir, "02_step.sql"), "select 1;\n", "utf8");
      expect(await listMigrationFiles(dir)).toEqual(["02_step.sql", "2_step.sql", "10_later.sql"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
        max_completion_tokens: number;
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
        max_completion_tokens,
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
    expect(agent?.max_completion_tokens).toBe(4096);
    expect(agent?.tool_allowlist).toEqual(["read_file", "list_dir"]);
    expect(agent?.prompt_length).toBeGreaterThan(0);
    expect(agent?.prompt_length).toBeLessThanOrEqual(800);
  });

  it("должен отвергнуть предел ответа вне 1..8192", async () => {
    await expect(sql`
      insert into agents (
        id,
        tenant_id,
        slug,
        display_name,
        system_prompt,
        model_alias,
        provider,
        max_steps,
        tool_allowlist,
        max_completion_tokens
      ) values (
        '00000000-0000-4000-8000-0000000000aa',
        'local',
        'limit-zero',
        'Предел',
        'короткий',
        'agent',
        'local',
        8,
        array['read_file']::text[],
        0
      )
    `).rejects.toThrow();
  });
});
