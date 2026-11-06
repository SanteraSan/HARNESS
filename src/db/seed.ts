import path from "node:path";

import { errorCode, isMainModule, loadConfig, logger } from "../config.js";
import { createSql } from "./client.js";

export function seedFilePath(): string {
  return path.resolve(import.meta.dirname, "../../seed/local_agent.sql");
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
    await applySeed(config.databaseUrl, seedFilePath());
    logger.info("seed finished");
  } catch (error) {
    logger.error({ code: errorCode(error) }, "seed failed");
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  await main();
}
