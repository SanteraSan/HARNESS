import type postgres from "postgres";
import { z } from "zod";

import type { NewRunStep, StepKind } from "../contracts/types.js";
import type { Sql } from "../db/client.js";
import { createRunJournal } from "../journal/index.js";
import { REDACTED, containsListedSecret, redact } from "../model/redact.js";
import { SecretError, postgresCode } from "./errors.js";
import { assertEncryptionKey } from "./key.js";
import { openSealed, seal, type SealedSecret } from "./seal.js";

/** Как у журнала: маска, затем не длиннее 2000 кодпоинтов. */
const EXCERPT_LIMIT = 2000;

const PLAINTEXT_MAX_BYTES = 4096;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const tenantSchema = z.string().min(1).max(64);
const nameSchema = z.string().min(1).max(200);

export interface PutSecretInput {
  tenantId: string;
  name: string;
  plaintext: string;
}

export interface GrantSecretInput {
  tenantId: string;
  secretName: string;
  agentId: string | null;
  department: string | null;
}

export interface GrantResult {
  id: string;
  created: boolean;
}

export interface ConnectorRequest {
  tenantId: string;
  secretName: string;
  agentId: string;
  department: string | null;
  runId: string;
  toolName: string;
}

/** Текст для модели. Открытого секрета в этом объекте нет. */
export interface ConnectorUse {
  received: boolean;
  modelText: string;
}

/** Секрет приходит аргументом и не возвращается наружу. */
export type ConnectorTool = (secret: string) => Promise<string>;

export interface SecretVault {
  put(input: PutSecretInput): Promise<{ id: string }>;
  grant(input: GrantSecretInput): Promise<GrantResult>;
  deliver(request: ConnectorRequest, tool: ConnectorTool): Promise<ConnectorUse>;
}

type AgentGrant = {
  tenantId: string;
  secretName: string;
  agentId: string;
  department: null;
};

type DepartmentGrant = {
  tenantId: string;
  secretName: string;
  agentId: null;
  department: string;
};

type ParsedGrant = AgentGrant | DepartmentGrant;

interface ParsedPut {
  tenantId: string;
  name: string;
  plaintext: string;
}

interface ParsedRequest {
  tenantId: string;
  secretName: string;
  agentId: string;
  department: string | null;
  runId: string;
  toolName: string;
}

interface IdRow {
  id: string;
}

interface SealedRow {
  ciphertext: unknown;
  nonce: unknown;
  salt: unknown;
}

/**
 * Сейф коннектора. Ключ шифрования остаётся в процессе.
 * Выдача связи коммитится до инструмента: транзакция не ждёт коннектор.
 */
export function createSecretVault(sql: Sql, encryptionKey: string): SecretVault {
  const key = assertEncryptionKey(encryptionKey);
  return {
    put(input: PutSecretInput): Promise<{ id: string }> {
      return putSecret(sql, key, input);
    },
    grant(input: GrantSecretInput): Promise<GrantResult> {
      return grantSecret(sql, input);
    },
    deliver(request: ConnectorRequest, tool: ConnectorTool): Promise<ConnectorUse> {
      return deliverSecret(sql, key, request, tool);
    },
  };
}

async function putSecret(sql: Sql, key: string, input: PutSecretInput): Promise<{ id: string }> {
  const parsed = parsePut(input);
  const sealed = await seal(parsed.plaintext, key);
  try {
    const inserted = await sql<IdRow[]>`
      insert into connector_secrets (tenant_id, name, ciphertext, nonce, salt)
      values (
        ${parsed.tenantId},
        ${parsed.name},
        ${sealed.ciphertext},
        ${sealed.nonce},
        ${sealed.salt}
      )
      returning id
    `;
    const row = inserted[0];
    if (row === undefined) {
      throw new SecretError("invalid_secret", "connector secret was not stored");
    }
    return { id: row.id };
  } catch (error) {
    if (error instanceof SecretError) {
      throw error;
    }
    if (postgresCode(error) === "23505") {
      throw new SecretError("secret_exists", "connector secret already exists");
    }
    throw error;
  }
}

/**
 * Повтор той же пары (секрет, агент) или (секрет, отдел) возвращает первую строку.
 * Блокировка строки секрета закрывает гонку двух выдач до уникального индекса.
 */
async function grantSecret(sql: Sql, input: GrantSecretInput): Promise<GrantResult> {
  const parsed = parseGrant(input);
  try {
    return await insertGrant(sql, parsed);
  } catch (error) {
    if (postgresCode(error) !== "23505") {
      throw error;
    }
    const existing = await findGrant(sql, parsed);
    if (existing === null) {
      throw new SecretError("invalid_grant", "connector grant was not stored");
    }
    return { id: existing, created: false };
  }
}

async function insertGrant(sql: Sql, input: ParsedGrant): Promise<GrantResult> {
  return sql.begin(async (tx) => {
    const secrets = await tx<IdRow[]>`
      select id
      from connector_secrets
      where tenant_id = ${input.tenantId}
        and name = ${input.secretName}
      for update
    `;
    const stored = secrets[0];
    if (stored === undefined) {
      throw new SecretError("secret_not_found", "connector secret does not exist");
    }

    const existing = await lockExistingGrant(tx, stored.id, input);
    if (existing !== null) {
      return { id: existing, created: false };
    }

    try {
      const inserted = await tx<IdRow[]>`
        insert into connector_secret_grants (secret_id, agent_id, department)
        values (${stored.id}, ${input.agentId}, ${input.department})
        returning id
      `;
      const row = inserted[0];
      if (row === undefined) {
        throw new SecretError("invalid_grant", "connector grant was not stored");
      }
      return { id: row.id, created: true };
    } catch (error) {
      if (error instanceof SecretError) {
        throw error;
      }
      if (postgresCode(error) === "23503") {
        throw new SecretError("agent_not_found", "agent does not exist");
      }
      throw error;
    }
  });
}

async function deliverSecret(
  sql: Sql,
  key: string,
  request: ConnectorRequest,
  tool: ConnectorTool,
): Promise<ConnectorUse> {
  const parsed = parseRequest(request);
  const sealed = await loadGranted(sql, parsed);
  const keyOnly = [key];
  if (sealed === null) {
    return deny(sql, keyOnly, parsed, "no_grant");
  }

  let plaintext: string;
  try {
    plaintext = await openSealed(sealed, key);
  } catch (error) {
    if (error instanceof SecretError) {
      return deny(sql, keyOnly, parsed, "decrypt_failed");
    }
    throw error;
  }

  // Расшифровка уже вне транзакции: обратный вызов коннектора базу не держит.
  const secrets = [key, plaintext];
  let raw: string;
  let failed = false;
  try {
    const value: unknown = await tool(plaintext);
    raw = typeof value === "string" ? value : "tool failed";
  } catch (error) {
    failed = true;
    raw = error instanceof Error ? error.message : "tool failed";
  }

  const modelText = mask(raw, secrets);
  await writeStep(sql, secrets, {
    runId: parsed.runId,
    kind: "tool_result",
    toolName: safeToolName(parsed.toolName, secrets),
    requestExcerpt: mask(`secret:${parsed.secretName}`, secrets),
    responseExcerpt: modelText,
    promptTokens: null,
    completionTokens: null,
    error: failed ? "tool_failed" : null,
  });
  return { received: true, modelText };
}

async function deny(
  sql: Sql,
  secrets: readonly string[],
  request: ParsedRequest,
  error: string,
): Promise<ConnectorUse> {
  const modelText = "secret is not available";
  await writeStep(sql, secrets, {
    runId: request.runId,
    kind: "policy_deny",
    toolName: safeToolName(request.toolName, secrets),
    requestExcerpt: mask(`secret:${request.secretName}`, secrets),
    responseExcerpt: modelText,
    promptTokens: null,
    completionTokens: null,
    error,
  });
  return { received: false, modelText };
}

async function loadGranted(sql: Sql, request: ParsedRequest): Promise<SealedSecret | null> {
  const rows = await sql<SealedRow[]>`
    select s.ciphertext, s.nonce, s.salt
    from connector_secrets s
    join connector_secret_grants g on g.secret_id = s.id
    where s.tenant_id = ${request.tenantId}
      and s.name = ${request.secretName}
      and (
        g.agent_id = ${request.agentId}
        or g.department = ${request.department}
      )
    limit 1
  `;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const ciphertext = asBuffer(row.ciphertext);
  const nonce = asBuffer(row.nonce);
  const salt = asBuffer(row.salt);
  if (ciphertext === null || nonce === null || salt === null) {
    throw new SecretError("decrypt_failed", "connector secret could not be opened");
  }
  return { ciphertext, nonce, salt };
}

async function findGrant(sql: Sql, input: ParsedGrant): Promise<string | null> {
  const rows =
    input.agentId !== null
      ? await sql<IdRow[]>`
          select g.id
          from connector_secret_grants g
          join connector_secrets s on s.id = g.secret_id
          where s.tenant_id = ${input.tenantId}
            and s.name = ${input.secretName}
            and g.agent_id = ${input.agentId}
        `
      : await sql<IdRow[]>`
          select g.id
          from connector_secret_grants g
          join connector_secrets s on s.id = g.secret_id
          where s.tenant_id = ${input.tenantId}
            and s.name = ${input.secretName}
            and g.department = ${input.department}
        `;
  return rows[0]?.id ?? null;
}

async function lockExistingGrant(
  tx: postgres.TransactionSql<{ chat_id: string }>,
  secretId: string,
  input: ParsedGrant,
): Promise<string | null> {
  const rows =
    input.agentId !== null
      ? await tx<IdRow[]>`
          select id
          from connector_secret_grants
          where secret_id = ${secretId}
            and agent_id = ${input.agentId}
          for update
        `
      : await tx<IdRow[]>`
          select id
          from connector_secret_grants
          where secret_id = ${secretId}
            and department = ${input.department}
          for update
        `;
  return rows[0]?.id ?? null;
}

async function writeStep(
  sql: Sql,
  secrets: readonly string[],
  step: NewRunStep & { kind: StepKind },
): Promise<void> {
  await createRunJournal(sql, secrets).appendStep(step);
}

function parsePut(input: PutSecretInput): ParsedPut {
  const parsed = z
    .object({
      tenantId: tenantSchema,
      name: nameSchema,
      plaintext: z.string().min(1).max(PLAINTEXT_MAX_BYTES),
    })
    .strict()
    .safeParse({
      tenantId: input.tenantId.trim(),
      name: input.name.trim(),
      plaintext: input.plaintext,
    });
  if (!parsed.success || parsed.data.plaintext === REDACTED) {
    throw new SecretError("invalid_secret", "connector secret is invalid");
  }
  if (Buffer.byteLength(parsed.data.plaintext, "utf8") > PLAINTEXT_MAX_BYTES) {
    throw new SecretError("invalid_secret", "connector secret is invalid");
  }
  return parsed.data;
}

function parseGrant(input: GrantSecretInput): ParsedGrant {
  const parsed = z
    .object({
      tenantId: tenantSchema,
      secretName: nameSchema,
      agentId: z.string().regex(UUID_PATTERN).nullable(),
      department: z.string().min(1).max(200).nullable(),
    })
    .strict()
    .safeParse({
      tenantId: input.tenantId.trim(),
      secretName: input.secretName.trim(),
      agentId: input.agentId,
      department: input.department === null ? null : input.department.trim(),
    });
  if (!parsed.success) {
    throw new SecretError("invalid_grant", "connector grant is invalid");
  }
  const { tenantId, secretName, agentId, department } = parsed.data;
  if (agentId !== null && department === null) {
    return { tenantId, secretName, agentId, department: null };
  }
  if (agentId === null && department !== null) {
    return { tenantId, secretName, agentId: null, department };
  }
  throw new SecretError("invalid_grant", "connector grant needs one subject");
}

function parseRequest(input: ConnectorRequest): ParsedRequest {
  const parsed = z
    .object({
      tenantId: tenantSchema,
      secretName: nameSchema,
      agentId: z.string().regex(UUID_PATTERN),
      department: z.string().min(1).max(200).nullable(),
      runId: z.string().regex(UUID_PATTERN),
      toolName: z.string().regex(TOOL_NAME_PATTERN),
    })
    .strict()
    .safeParse({
      tenantId: input.tenantId.trim(),
      secretName: input.secretName.trim(),
      agentId: input.agentId,
      department: input.department === null ? null : input.department.trim(),
      runId: input.runId,
      toolName: input.toolName,
    });
  if (!parsed.success) {
    throw new SecretError("invalid_request", "connector request is invalid");
  }
  return parsed.data;
}

function mask(text: string, secrets: readonly string[]): string {
  return truncateUnicode(redact(text, secrets), EXCERPT_LIMIT);
}

function safeToolName(toolName: string, secrets: readonly string[]): string {
  if (containsListedSecret(toolName, secrets)) {
    return "connector";
  }
  return toolName;
}

function truncateUnicode(text: string, limit: number): string {
  let count = 0;
  let units = 0;
  for (const character of text) {
    if (count === limit) {
      return text.slice(0, units);
    }
    count += 1;
    units += character.length;
  }
  return text;
}

function asBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  return null;
}
