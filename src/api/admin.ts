/* Каталог web не литерал: путь из URL проверяется realpath и префиксом с разделителем. */
/* eslint-disable security/detect-non-literal-fs-filename -- тюрьма web, как проверка пути I19 */
import { open, realpath } from "node:fs/promises";
import path from "node:path";

import { runPayloadSchema, type RunPayload } from "../contracts/payload.js";
import {
  PROVIDERS,
  RUN_STATUSES,
  SOURCES,
  STEP_KINDS,
  type Provider,
  type RunStatus,
  type Source,
  type StepKind,
} from "../contracts/types.js";
import type { Sql } from "../db/client.js";
import { ApiError } from "./errors.js";

/** Маска секрета коннектора. Шифртекст в ответ не кладётся и не расшифровывается. */
const SECRET_MASK = "••••";

const WEB_ROOT = path.resolve(import.meta.dirname, "../../web");
const MAX_ASSET_BYTES = 64 * 1024;

const CRON_KINDS = ["script", "agent"] as const;
type CronKind = (typeof CRON_KINDS)[number];

export interface WebAsset {
  body: Uint8Array;
  mediaType: string;
}

export interface AdminRunJson {
  id: string;
  agent_id: string;
  source: Source;
  status: RunStatus;
  chat_id: string | null;
  idempotency_key: string;
  attempt: number;
  model_alias: string | null;
  provider: Provider | null;
  error: string | null;
  final_text: string | null;
  payload: RunPayload;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AdminStepJson {
  id: string;
  run_id: string;
  step_index: number;
  kind: StepKind;
  tool_name: string | null;
  request_excerpt: string | null;
  response_excerpt: string | null;
  error: string | null;
  created_at: string;
}

export interface AdminSecretJson {
  name: string;
  secret: typeof SECRET_MASK;
}

export interface AdminAgentJson {
  id: string;
  slug: string;
  display_name: string;
  model_alias: string;
  provider: Provider;
  max_steps: number;
  tool_allowlist: string[];
  max_completion_tokens: number;
  secrets: AdminSecretJson[];
  created_at: string;
}

export interface AdminCronJson {
  id: string;
  agent_id: string;
  kind: CronKind;
  schedule: string;
  paused: boolean;
  pause_chat_id: string;
  pause_message: string | null;
  command: string[] | null;
  message: string | null;
  consecutive_failures: number;
  last_run_id: string | null;
  last_dispatched_at: string | null;
  created_at: string;
}

/**
 * Файл только из реального каталога web.
 * `..`, абсолютный путь и симлинк наружу не читаются.
 */
export async function readWebAsset(userPath: string): Promise<WebAsset | null> {
  const relative = normalizeAssetPath(userPath);
  if (relative === null) {
    return null;
  }

  const rootReal = await realpath(WEB_ROOT);
  const resolved = path.resolve(rootReal, relative);
  if (!isInsideRoot(rootReal, resolved) || resolved === rootReal) {
    return null;
  }

  let real: string;
  try {
    real = await realpath(resolved);
  } catch (error) {
    if (isMissingPath(error)) {
      return null;
    }
    throw error;
  }
  if (!isInsideRoot(rootReal, real) || real === rootReal) {
    return null;
  }

  const mediaType = mediaTypeOf(real);
  if (mediaType === null) {
    return null;
  }
  return readBounded(real, mediaType);
}

/** Списки админки. `tenant_id` — литерал, не параметр клиента. Не больше 100 строк. */
export async function listAdminRuns(sql: Sql): Promise<AdminRunJson[]> {
  const rows = await sql<Record<string, unknown>[]>`
    select
      id,
      agent_id,
      source,
      status,
      chat_id,
      idempotency_key,
      attempt,
      model_alias,
      provider,
      error,
      final_text,
      payload,
      created_at,
      started_at,
      finished_at
    from runs
    where tenant_id = 'local'
    order by created_at desc, id desc
    limit 100
  `;
  return rows.map((row) => mapRun(row));
}

export async function listAdminSteps(sql: Sql, runId: string): Promise<AdminStepJson[] | null> {
  return sql.begin(async (tx) => {
    const runs = await tx<{ id: string }[]>`
      select id
      from runs
      where id = ${runId}
        and tenant_id = 'local'
    `;
    if (runs.length === 0) {
      return null;
    }
    if (runs.length !== 1) {
      throw new ApiError("internal_error");
    }

    const steps = await tx<Record<string, unknown>[]>`
      select
        id,
        run_id,
        step_index,
        kind,
        tool_name,
        request_excerpt,
        response_excerpt,
        error,
        created_at
      from run_steps
      where run_id = ${runId}
      order by step_index asc
      limit 100
    `;
    return steps.map((row) => mapStep(row));
  });
}

export async function listAdminAgents(sql: Sql): Promise<AdminAgentJson[]> {
  return sql.begin(async (tx) => {
    const rows = await tx<Record<string, unknown>[]>`
      select
        id,
        slug,
        display_name,
        model_alias,
        provider,
        max_steps,
        tool_allowlist,
        max_completion_tokens,
        created_at
      from agents
      where tenant_id = 'local'
      order by slug asc, id asc
      limit 100
    `;
    // Имя и маска. Колонки шифртекста, nonce и salt в выборку не входят.
    const secrets = await tx<Record<string, unknown>[]>`
      select g.agent_id, s.name
      from connector_secret_grants g
      join connector_secrets s on s.id = g.secret_id
      join agents a on a.id = g.agent_id
      where a.tenant_id = 'local'
        and s.tenant_id = 'local'
        and g.agent_id is not null
      order by s.name asc
      limit 100
    `;
    return mapAgents(rows, secrets);
  });
}

export async function listAdminCrons(sql: Sql): Promise<AdminCronJson[]> {
  const rows = await sql<Record<string, unknown>[]>`
    select
      id,
      agent_id,
      kind,
      schedule,
      paused,
      pause_chat_id,
      pause_message,
      command,
      message,
      consecutive_failures,
      last_run_id,
      last_dispatched_at,
      created_at
    from cron_jobs
    where tenant_id = 'local'
    order by created_at desc, id desc
    limit 100
  `;
  return rows.map((row) => mapCron(row));
}

async function readBounded(real: string, mediaType: string): Promise<WebAsset | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(real, "r");
  } catch (error) {
    if (isMissingPath(error)) {
      return null;
    }
    throw error;
  }

  try {
    const buffer = Buffer.alloc(MAX_ASSET_BYTES + 1);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead > MAX_ASSET_BYTES) {
      return null;
    }
    return {
      body: Buffer.from(buffer.subarray(0, result.bytesRead)),
      mediaType,
    };
  } finally {
    await handle.close();
  }
}

function normalizeAssetPath(userPath: string): string | null {
  if (userPath.length === 0 || userPath.length > 512) {
    return null;
  }

  let current = userPath;
  if (current.includes("%")) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded.includes("%") || decoded.length === 0 || decoded.length > 512) {
        return null;
      }
      current = decoded;
    } catch {
      return null;
    }
  }

  if (
    current.includes("\0") ||
    current.includes("\\") ||
    current.includes("..") ||
    current.startsWith("/") ||
    path.isAbsolute(current)
  ) {
    return null;
  }

  const parts = current.split("/");
  for (const part of parts) {
    if (part.length === 0 || part === "." || part === "..") {
      return null;
    }
  }
  return parts.join("/");
}

function isInsideRoot(rootReal: string, candidate: string): boolean {
  const prefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  return candidate === rootReal || candidate.startsWith(prefix);
}

function mediaTypeOf(realPath: string): string | null {
  switch (path.extname(realPath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    default:
      return null;
  }
}

function isMissingPath(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = error.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function mapAgents(
  rows: readonly Record<string, unknown>[],
  secretRows: readonly Record<string, unknown>[],
): AdminAgentJson[] {
  const secrets = groupSecrets(secretRows);
  return rows.map((row) => {
    const id = requireText(row.id);
    return {
      id,
      slug: requireText(row.slug),
      display_name: requireText(row.display_name),
      model_alias: requireText(row.model_alias),
      provider: requireProvider(row.provider),
      max_steps: requireInteger(row.max_steps),
      tool_allowlist: requireStringArray(row.tool_allowlist),
      max_completion_tokens: requireInteger(row.max_completion_tokens),
      secrets: secrets.get(id) ?? [],
      created_at: requireIso(row.created_at),
    };
  });
}

function groupSecrets(rows: readonly Record<string, unknown>[]): Map<string, AdminSecretJson[]> {
  const grouped = new Map<string, AdminSecretJson[]>();
  for (const row of rows) {
    const agentId = requireText(row.agent_id);
    const item: AdminSecretJson = { name: requireText(row.name), secret: SECRET_MASK };
    const existing = grouped.get(agentId);
    if (existing === undefined) {
      grouped.set(agentId, [item]);
      continue;
    }
    existing.push(item);
  }
  return grouped;
}

function mapRun(row: Record<string, unknown>): AdminRunJson {
  return {
    id: requireText(row.id),
    agent_id: requireText(row.agent_id),
    source: requireSource(row.source),
    status: requireRunStatus(row.status),
    chat_id: requireBigintText(row.chat_id),
    idempotency_key: requireText(row.idempotency_key),
    attempt: requireInteger(row.attempt),
    model_alias: requireTextOrNull(row.model_alias),
    provider: requireProviderOrNull(row.provider),
    error: requireTextOrNull(row.error),
    final_text: requireTextOrNull(row.final_text),
    payload: requirePayload(row.payload),
    created_at: requireIso(row.created_at),
    started_at: requireIsoOrNull(row.started_at),
    finished_at: requireIsoOrNull(row.finished_at),
  };
}

function mapStep(row: Record<string, unknown>): AdminStepJson {
  return {
    id: requireText(row.id),
    run_id: requireText(row.run_id),
    step_index: requireInteger(row.step_index),
    kind: requireStepKind(row.kind),
    tool_name: requireTextOrNull(row.tool_name),
    request_excerpt: requireTextOrNull(row.request_excerpt),
    response_excerpt: requireTextOrNull(row.response_excerpt),
    error: requireTextOrNull(row.error),
    created_at: requireIso(row.created_at),
  };
}

function mapCron(row: Record<string, unknown>): AdminCronJson {
  return {
    id: requireText(row.id),
    agent_id: requireText(row.agent_id),
    kind: requireCronKind(row.kind),
    schedule: requireText(row.schedule),
    paused: requireBoolean(row.paused),
    pause_chat_id: requireBigint(row.pause_chat_id),
    pause_message: requireTextOrNull(row.pause_message),
    command: requireStringArrayOrNull(row.command),
    message: requireTextOrNull(row.message),
    consecutive_failures: requireInteger(row.consecutive_failures),
    last_run_id: requireTextOrNull(row.last_run_id),
    last_dispatched_at: requireIsoOrNull(row.last_dispatched_at),
    created_at: requireIso(row.created_at),
  };
}

function requirePayload(value: unknown): RunPayload {
  const parsed = runPayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError("internal_error");
  }
  return parsed.data;
}

function requireRunStatus(value: unknown): RunStatus {
  if (typeof value === "string" && isListed(RUN_STATUSES, value)) {
    return value;
  }
  throw new ApiError("internal_error");
}

function requireSource(value: unknown): Source {
  if (typeof value === "string" && isListed(SOURCES, value)) {
    return value;
  }
  throw new ApiError("internal_error");
}

function requireProvider(value: unknown): Provider {
  if (typeof value === "string" && isListed(PROVIDERS, value)) {
    return value;
  }
  throw new ApiError("internal_error");
}

function requireProviderOrNull(value: unknown): Provider | null {
  if (value === null) {
    return null;
  }
  return requireProvider(value);
}

function requireStepKind(value: unknown): StepKind {
  if (typeof value === "string" && isListed(STEP_KINDS, value)) {
    return value;
  }
  throw new ApiError("internal_error");
}

function requireCronKind(value: unknown): CronKind {
  if (typeof value === "string" && isListed(CRON_KINDS, value)) {
    return value;
  }
  throw new ApiError("internal_error");
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
    throw new ApiError("internal_error");
  }
  return value;
}

function requireTextOrNull(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return requireText(value);
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new ApiError("internal_error");
  }
  return value;
}

function requireInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ApiError("internal_error");
  }
  return value;
}

function requireStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ApiError("internal_error");
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new ApiError("internal_error");
    }
    items.push(item);
  }
  return items;
}

function requireStringArrayOrNull(value: unknown): string[] | null {
  if (value === null) {
    return null;
  }
  return requireStringArray(value);
}

/** int8 приходит строкой. Number() для идентификатора Telegram не вызывается. */
function requireBigintText(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return requireBigint(value);
}

function requireBigint(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 20) {
    throw new ApiError("internal_error");
  }
  const start = value.charCodeAt(0) === 45 ? 1 : 0;
  if (start === value.length) {
    throw new ApiError("internal_error");
  }
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) {
      throw new ApiError("internal_error");
    }
  }
  return value;
}

function requireIso(value: unknown): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ApiError("internal_error");
  }
  return value.toISOString();
}

function requireIsoOrNull(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return requireIso(value);
}
