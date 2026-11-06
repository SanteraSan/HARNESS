import type { RunStatus } from "../contracts/types.js";
import type { Sql } from "../db/client.js";
import { RUN_STATUSES } from "../contracts/types.js";
import type { RunSnapshot } from "./decide.js";
import { TelegramError } from "./errors.js";
import { isUuid } from "./ids.js";

/** M1 знает один арендатор. Фильтр всё равно стоит в запросе. */
const LOCAL_TENANT = "local";

/**
 * Короткое чтение статуса. Транзакция не открывается:
 * опрос не должен держать соединение, пока запуска нет.
 */
export async function readRunSnapshot(sql: Sql, runId: string): Promise<RunSnapshot | null> {
  if (!isUuid(runId)) {
    return null;
  }
  const rows = await sql<Record<string, unknown>[]>`
    select id, status, error, final_text
    from runs
    where id = ${runId}
      and tenant_id = ${LOCAL_TENANT}
  `;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  if (rows.length !== 1) {
    throw new TelegramError("invalid_run_row", "run id is not unique");
  }
  return {
    id: requireText(row.id),
    status: requireStatus(row.status),
    error: requireTextOrNull(row.error),
    finalText: requireTextOrNull(row.final_text),
  };
}

export async function findLocalAgentId(sql: Sql, slug: string): Promise<string> {
  const rows = await sql<Record<string, unknown>[]>`
    select id
    from agents
    where tenant_id = ${LOCAL_TENANT}
      and slug = ${slug}
  `;
  if (rows.length !== 1) {
    throw new TelegramError("unknown_agent", "agent slug was not found");
  }
  const id = rows[0]?.id;
  if (typeof id !== "string" || !isUuid(id)) {
    throw new TelegramError("invalid_agent", "agent id is invalid");
  }
  return id;
}

function requireStatus(value: unknown): RunStatus {
  if (typeof value === "string" && isListed(RUN_STATUSES, value)) {
    return value;
  }
  throw new TelegramError("invalid_run_row", "run status is invalid");
}

function isListed<T extends string>(options: readonly T[], value: string): value is T {
  for (const option of options) {
    if (option === value) {
      return true;
    }
  }
  return false;
}

function requireText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TelegramError("invalid_run_row", "run column is invalid");
  }
  return value;
}

function requireTextOrNull(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TelegramError("invalid_run_row", "run column is invalid");
  }
  return value;
}
