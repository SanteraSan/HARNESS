import { z } from "zod";

import { runPayloadSchema } from "../contracts/payload.js";
import { ApiError } from "./errors.js";
import { parseDecimalChatId } from "./chat-id.js";

/** Тело HTTP — JSON, не больше 32 КиБ. */
export const JSON_BODY_LIMIT_BYTES = 32 * 1024;

/**
 * Поля постановки. Неизвестные ключи zod отбрасывает.
 * message — те же 8000 символов, что и в payload контракта.
 * chat_id — строка, не число: bigint не прогоняется через Number.
 */
const createRunSchema = z.object({
  agent_slug: z.string().min(1).max(64),
  idempotency_key: z.string().min(1).max(256),
  message: z.string().max(8000),
  chat_id: z.string().min(1).max(20).nullable().optional(),
});

export interface CreateRunInput {
  agentSlug: string;
  idempotencyKey: string;
  message: string;
  chatId: bigint | null;
}

export type ContentLengthStatus = "ok" | "invalid" | "too_large";

export function contentLengthStatus(value: string): ContentLengthStatus {
  if (value.length === 0) {
    return "invalid";
  }
  if (value.length > 10) {
    return "too_large";
  }
  let parsed = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) {
      return "invalid";
    }
    parsed = parsed * 10 + (code - 48);
  }
  if (parsed > JSON_BODY_LIMIT_BYTES) {
    return "too_large";
  }
  return "ok";
}

export async function readCreateRunInput(request: Request): Promise<CreateRunInput> {
  const parsed = await readJsonObject(request);
  return parseCreateRunBody(parsed);
}

export function parseCreateRunBody(value: unknown): CreateRunInput {
  const parsed = createRunSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError("invalid_body");
  }
  const payload = runPayloadSchema.safeParse({ message: parsed.data.message });
  if (!payload.success) {
    throw new ApiError("invalid_body");
  }

  const chatField = parsed.data.chat_id;
  if (chatField === undefined || chatField === null) {
    return {
      agentSlug: parsed.data.agent_slug,
      idempotencyKey: parsed.data.idempotency_key,
      message: payload.data.message,
      chatId: null,
    };
  }

  const chatId = parseDecimalChatId(chatField);
  if (chatId === null) {
    throw new ApiError("invalid_body");
  }
  return {
    agentSlug: parsed.data.agent_slug,
    idempotencyKey: parsed.data.idempotency_key,
    message: payload.data.message,
    chatId,
  };
}

async function readJsonObject(request: Request): Promise<unknown> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    throw new ApiError("invalid_body");
  }

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const status = contentLengthStatus(declared);
    if (status === "invalid") {
      throw new ApiError("invalid_body");
    }
    if (status === "too_large") {
      throw new ApiError("payload_too_large");
    }
  }

  const bytes = await readLimitedBytes(request);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError("invalid_body");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ApiError("invalid_body");
  }
  if (!isPlainRecord(parsed)) {
    throw new ApiError("invalid_body");
  }
  return parsed;
}

function isJsonContentType(value: string | null): boolean {
  if (value === null || value.length === 0 || value.length > 200) {
    return false;
  }
  const parts = value.split(";");
  const mime = parts[0]?.trim().toLowerCase();
  if (mime !== "application/json") {
    return false;
  }
  if (parts.length > 2) {
    return false;
  }
  const parameter = parts[1];
  if (parameter === undefined) {
    return true;
  }
  return parameter.trim().toLowerCase() === "charset=utf-8";
}

/**
 * Объект JSON.parse, не массив и не null.
 * Ключи __proto__/constructor наружу не копируются: схема читает только свои поля.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function readLimitedBytes(request: Request): Promise<Uint8Array> {
  const body = request.body;
  if (body === null) {
    throw new ApiError("invalid_body");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      const bytes = asBytes(next.value as unknown);
      total += bytes.byteLength;
      if (total > JSON_BODY_LIMIT_BYTES) {
        throw new ApiError("payload_too_large");
      }
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) {
    throw new ApiError("invalid_body");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function asBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  throw new ApiError("invalid_body");
}
