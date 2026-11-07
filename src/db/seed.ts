import path from "node:path";

import { errorCode, isMainModule, loadConfig, logger } from "../config.js";
import { createSql } from "./client.js";

/** Только агент: тестовый хелпер подставляет этот путь и правила сам не применяет. */
export function seedFilePath(): string {
  return path.resolve(import.meta.dirname, "../../seed/local_agent.sql");
}

/** Ссылка на клерка, поэтому файл идёт после local_agent.sql. */
function routeRulesSeedPath(): string {
  return path.resolve(import.meta.dirname, "../../seed/route_rules.sql");
}

export async function applySeed(databaseUrl: string, seedFile: string): Promise<void> {
  const sql = createSql(databaseUrl);
  try {
    await sql.file(seedFile);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    // Повтор безопасен: в обоих файлах on conflict do nothing.
    await applySeed(config.databaseUrl, seedFilePath());
    await applySeed(config.databaseUrl, routeRulesSeedPath());
    logger.info("seed finished");
  } catch (error) {
    logger.error({ code: errorCode(error) }, "seed failed");
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  await main();
}
