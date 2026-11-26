import { afterAll, beforeEach } from "vitest";

import { loadConfig } from "../../src/config.js";
import { type Sql, createSql } from "../../src/db/client.js";
import { applyMigrations, migrationsDirectory } from "../../src/db/migrate.js";
import { seedFilePath } from "../../src/db/seed.js";

export class TestDatabaseError extends Error {
  readonly code = "test_database_refused";

  constructor(message = "test database name must end with _test") {
    super(message);
    this.name = "TestDatabaseError";
  }
}

/** Имя из URL, без пользовательской части и пароля. Суффикс `_test` проверяется до любого delete. */
export function assertTestDatabase(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new TestDatabaseError("database url is invalid");
  }

  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (name.length === 0 || name.includes("/")) {
    throw new TestDatabaseError("database url is invalid");
  }
  if (!name.endsWith("_test")) {
    throw new TestDatabaseError("test database name must end with _test");
  }
  return name;
}

export async function cleanTestDatabase(
  sql: Sql,
  databaseUrl: string,
  seedFile: string,
): Promise<void> {
  const expected = assertTestDatabase(databaseUrl);
  const current = await sql<{ name: string }[]>`select current_database() as name`;
  const actual = current[0]?.name;
  if (actual !== expected) {
    throw new TestDatabaseError("connected database does not match the test url");
  }

  await sql.begin(async (tx) => {
    await tx`delete from model_slots`;
    await tx`delete from service_model_steps`;
    await tx`delete from service_results`;
    await tx`delete from service_invocations`;
    await tx`update runs set parent_run_id = null`;
    await tx`delete from run_steps`;
    await tx`delete from runs`;
    await tx`delete from agents`;
    await tx.file(seedFile);
  });
}

const config = loadConfig();
const testDatabaseUrl = config.harnessTestDatabaseUrl;
if (testDatabaseUrl === null) {
  throw new TestDatabaseError("HARNESS_TEST_DATABASE_URL is required");
}
assertTestDatabase(testDatabaseUrl);

export const sql = createSql(testDatabaseUrl);
const seedFile = seedFilePath();

try {
  await applyMigrations(testDatabaseUrl, migrationsDirectory());
} catch (error) {
  await sql.end({ timeout: 5 });
  throw error;
}

beforeEach(async () => {
  await cleanTestDatabase(sql, testDatabaseUrl, seedFile);
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});
