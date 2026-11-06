import { readdir } from "node:fs/promises";
import path from "node:path";

import { errorCode, isMainModule, loadConfig, logger } from "../config.js";
import { createSql } from "./client.js";

export class MigrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
  }
}

export function migrationsDirectory(): string {
  return path.resolve(import.meta.dirname, "../../migrations");
}

/**
 * Применяет SQL-файлы по имени. Версия пишется в schema_migrations в той же транзакции.
 * Повторный запуск пропускает уже записанную версию и не создаёт вторую копию таблиц.
 */
export async function applyMigrations(
  databaseUrl: string,
  migrationsDir: string,
): Promise<readonly string[]> {
  const sql = createSql(databaseUrl);
  const applied: string[] = [];
  try {
    await sql`
      create table if not exists schema_migrations (
        version text primary key
      )
    `;

    const names = await listMigrationFiles(migrationsDir);
    for (const fileName of names) {
      const existing = await sql<{ version: string }[]>`
        select version from schema_migrations where version = ${fileName}
      `;
      if (existing.length > 0) {
        continue;
      }

      const fullPath = path.join(migrationsDir, fileName);
      await sql.begin(async (tx) => {
        await tx.file(fullPath);
        await tx`insert into schema_migrations (version) values (${fileName})`;
      });
      applied.push(fileName);
    }

    return applied;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  // Каталог собран из расположения модуля, не из ввода. Список файлов нужен, чтобы новый SQL шёл по имени без правки этого скрипта.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- аргумент не литерал: это фиксированный каталог migrations репозитория
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) {
      continue;
    }
    if (path.basename(entry.name) !== entry.name) {
      throw new MigrationError("migration_name", "migration file name is invalid");
    }
    names.push(entry.name);
  }
  names.sort();
  return names;
}

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    const applied = await applyMigrations(config.databaseUrl, migrationsDirectory());
    logger.info({ applied: applied.length }, "migrations finished");
  } catch (error) {
    logger.error({ code: errorCode(error) }, "migrations failed");
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  await main();
}
