import { logger } from "../config.js";
import type { EnqueueInput } from "../contracts/types.js";
import type { Sql } from "../db/client.js";
import { parseDecimalChatId } from "./chat-id.js";
import { MESSAGE_LIMIT } from "./decide.js";
import { TelegramError } from "./errors.js";
import { isUuid } from "./ids.js";

/** Границы Postgres int8. chat_id остаётся bigint, в число JS не переводится. */
const INT8_MIN = -9223372036854775808n;
const INT8_MAX = 9223372036854775807n;

export interface DialogMessage {
  tenantId: string;
  agentId: string;
  chatId: bigint;
  idempotencyKey: string;
  message: string;
}

export interface DialogEnqueueResult {
  runId: string;
  reason: "created" | "replay" | "dialog_busy";
}

export type DialogEnqueue = (input: EnqueueInput) => Promise<DialogEnqueueResult>;

export interface ReleasedDialog {
  runId: string;
  /** Десятичная строка int8. В Telegram уходит как текст, не как number. */
  chatId: string;
}

interface BufferedRow {
  id: string;
  tenantId: string;
  agentId: string;
  chatId: bigint;
  idempotencyKey: string;
  message: string;
}

/**
 * Хвост занятого чата. Повтор того же ключа не создаёт вторую строку.
 * chat_id пишется параметром int8 и остаётся bigint.
 */
export async function saveDialogMessage(sql: Sql, message: DialogMessage): Promise<void> {
  const tenantId = requireTenant(message.tenantId);
  const agentId = requireAgent(message.agentId);
  const chatId = requireChat(message.chatId);
  const idempotencyKey = requireKey(message.idempotencyKey);
  const text = requireMessage(message.message);
  await sql`
    insert into dialog_buffer (
      tenant_id,
      agent_id,
      chat_id,
      idempotency_key,
      message
    ) values (
      ${tenantId},
      ${agentId},
      ${sql.types.chat_id(chatId)},
      ${idempotencyKey},
      ${text}
    )
    on conflict (agent_id, idempotency_key) do nothing
  `;
}

export async function hasPendingDialog(
  sql: Sql,
  agentId: string,
  chatId: bigint,
): Promise<boolean> {
  const agent = requireAgent(agentId);
  const chat = requireChat(chatId);
  const rows = await sql<{ id: string }[]>`
    select id
    from dialog_buffer
    where agent_id = ${agent}
      and chat_id = ${sql.types.chat_id(chat)}
    limit 1
  `;
  return rows.length === 1;
}

/** Уже поставленный запуск с этим ключом. Вторая строка runs не нужна. */
export async function findExistingRun(
  sql: Sql,
  agentId: string,
  idempotencyKey: string,
): Promise<string | null> {
  const agent = requireAgent(agentId);
  const key = requireKey(idempotencyKey);
  const rows = await sql<{ id: string }[]>`
    select id
    from runs
    where agent_id = ${agent}
      and idempotency_key = ${key}
    limit 1
  `;
  const id = rows[0]?.id;
  if (id === undefined) {
    return null;
  }
  if (!isUuid(id)) {
    throw new TelegramError("invalid_run_row", "run id is invalid");
  }
  return id;
}

/**
 * Ставит самое старое сообщение чата, и только одно.
 * Живой queued/running оставляет строку в буфере: следующая ждёт его финиша.
 */
export async function releaseNextBuffered(
  sql: Sql,
  enqueue: DialogEnqueue,
  agentId: string,
  chatId: bigint,
): Promise<ReleasedDialog | null> {
  const agent = requireAgent(agentId);
  const chat = requireChat(chatId);
  const live = await sql<{ id: string }[]>`
    select id
    from runs
    where agent_id = ${agent}
      and chat_id = ${sql.types.chat_id(chat)}
      and status in ('queued', 'running')
    limit 1
  `;
  if (live.length > 0) {
    return null;
  }

  const rows = await sql<Record<string, unknown>[]>`
    select id, tenant_id, agent_id, chat_id, idempotency_key, message
    from dialog_buffer
    where agent_id = ${agent}
      and chat_id = ${sql.types.chat_id(chat)}
    order by buffer_seq asc
    limit 1
  `;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const buffered = mapBuffered(row);
  const result = await enqueue({
    tenantId: buffered.tenantId,
    agentId: buffered.agentId,
    source: "telegram",
    idempotencyKey: buffered.idempotencyKey,
    message: buffered.message,
    chatId: buffered.chatId,
  });
  if (result.reason === "dialog_busy") {
    return null;
  }
  await sql`
    delete from dialog_buffer
    where id = ${buffered.id}
  `;
  logger.info({ run_id: result.runId }, "telegram buffer enqueued");
  return { runId: result.runId, chatId: chat };
}

/** По одному сообщению на чат. Хвост остаётся, пока поставленный запуск не финиширует. */
export async function releaseReadyDialogs(
  sql: Sql,
  enqueue: DialogEnqueue,
  agentId: string,
): Promise<ReleasedDialog[]> {
  const agent = requireAgent(agentId);
  const chats = await sql<{ chat_id: string }[]>`
    select distinct chat_id
    from dialog_buffer
    where agent_id = ${agent}
  `;
  const released: ReleasedDialog[] = [];
  for (const entry of chats) {
    const chatId = parseDecimalChatId(entry.chat_id);
    if (chatId === null) {
      throw new TelegramError("invalid_chat", "buffered chat id is invalid");
    }
    const next = await releaseNextBuffered(sql, enqueue, agent, chatId);
    if (next !== null) {
      released.push(next);
    }
  }
  return released;
}

function mapBuffered(value: Record<string, unknown>): BufferedRow {
  const id = requireText(value.id);
  if (!isUuid(id)) {
    throw new TelegramError("invalid_row", "buffer id is invalid");
  }
  const chatText = requireText(value.chat_id);
  const chatId = parseDecimalChatId(chatText);
  if (chatId === null) {
    throw new TelegramError("invalid_chat", "buffered chat id is invalid");
  }
  return {
    id,
    tenantId: requireTenant(requireText(value.tenant_id)),
    agentId: requireAgent(requireText(value.agent_id)),
    chatId,
    idempotencyKey: requireKey(requireText(value.idempotency_key)),
    message: requireMessage(requireText(value.message)),
  };
}

function requireTenant(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new TelegramError("invalid_tenant", "tenant is invalid");
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const digit = code >= 48 && code <= 57;
    const lower = code >= 97 && code <= 122;
    const dash = code === 45;
    const under = code === 95;
    if (!digit && !lower && !dash && !under) {
      throw new TelegramError("invalid_tenant", "tenant is invalid");
    }
  }
  return value;
}

function requireAgent(value: string): string {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new TelegramError("invalid_agent", "agent id is invalid");
  }
  return value;
}

function requireChat(value: bigint): string {
  if (typeof value !== "bigint" || value < INT8_MIN || value > INT8_MAX) {
    throw new TelegramError("invalid_chat", "chat id is invalid");
  }
  const text = value.toString();
  if (parseDecimalChatId(text) !== value) {
    throw new TelegramError("invalid_chat", "chat id is invalid");
  }
  return text;
}

function requireKey(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw new TelegramError("invalid_key", "idempotency key is invalid");
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      throw new TelegramError("invalid_key", "idempotency key is invalid");
    }
  }
  return value;
}

function requireMessage(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MESSAGE_LIMIT) {
    throw new TelegramError("invalid_message", "buffered message is invalid");
  }
  return value;
}

function requireText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TelegramError("invalid_row", "buffer column is invalid");
  }
  return value;
}
