import { timingSafeEqual } from "node:crypto";

import { toolResponseSchema, type ToolResponse } from "./envelope.js";
import { TOOL_CALL_ID_RE, UUID_RE } from "./limits.js";
import { ContractError } from "./result.js";

export interface StoredWrite {
  key: string;
  bodySha256: Uint8Array;
  state: "started" | "done";
  response: ToolResponse | null;
}

export type IdempotencyVerdict =
  | { kind: "read" }
  | { kind: "missing_key" }
  | { kind: "first" }
  | { kind: "replay"; response: ToolResponse }
  | { kind: "conflict"; status: 409; reason: "idempotency_conflict" }
  | { kind: "in_progress"; status: 409; reason: "idempotency_in_progress" };

/**
 * Чтение хранилище не трогает: при effect read строка stored не читается.
 * Запись в таблицу сервиса эта функция не делает. Её вызывает тот, у кого уже есть строка.
 */
export function compareIdempotency(input: {
  effect: "read" | "write";
  key: string | null;
  bodySha256: Uint8Array;
  stored: StoredWrite | null;
}): IdempotencyVerdict {
  if (input.effect === "read") {
    return { kind: "read" };
  }
  if (input.key === null || input.key.length === 0) {
    return { kind: "missing_key" };
  }
  if (input.bodySha256.byteLength !== 32) {
    throw new ContractError("body hash must be 32 bytes");
  }
  if (input.stored === null) {
    return { kind: "first" };
  }
  if (input.stored.key !== input.key) {
    throw new ContractError("stored idempotency key does not match");
  }
  if (input.stored.bodySha256.byteLength !== 32) {
    throw new ContractError("stored body hash must be 32 bytes");
  }
  const sameBody = timingSafeEqual(
    Buffer.from(input.bodySha256),
    Buffer.from(input.stored.bodySha256),
  );
  if (!sameBody) {
    return { kind: "conflict", status: 409, reason: "idempotency_conflict" };
  }
  if (input.stored.state === "started") {
    return { kind: "in_progress", status: 409, reason: "idempotency_in_progress" };
  }
  if (input.stored.response === null) {
    throw new ContractError("done idempotency row has no response");
  }
  const checked = toolResponseSchema.safeParse(input.stored.response);
  if (!checked.success) {
    throw new ContractError("stored response does not match harness.tool.v1");
  }
  return { kind: "replay", response: checked.data };
}

export function formatIdempotencyKey(runId: string, toolCallId: string): string | null {
  if (runId.length !== 36 || toolCallId.length === 0 || toolCallId.length > 128) {
    return null;
  }
  if (!UUID_RE.test(runId) || !TOOL_CALL_ID_RE.test(toolCallId)) {
    return null;
  }
  return `${runId}:${toolCallId}`;
}

export type IdempotencyHeader =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "present"; key: string; runId: string; toolCallId: string };

/** Ровно одна quoted-string. Повтор заголовка и параметры после кавычек — invalid. */
export function parseIdempotencyHeader(
  header: string | readonly string[] | null,
): IdempotencyHeader {
  if (header === null) {
    return { status: "absent" };
  }
  const values = typeof header === "string" ? [header] : header;
  if (values.length !== 1) {
    return { status: "invalid" };
  }
  const value = values[0];
  if (value === undefined) {
    return { status: "invalid" };
  }
  const parsed = parseQuotedKey(value);
  if (parsed === null) {
    return { status: "invalid" };
  }
  return {
    status: "present",
    key: `${parsed.runId}:${parsed.toolCallId}`,
    runId: parsed.runId,
    toolCallId: parsed.toolCallId,
  };
}

function parseQuotedKey(value: string): { runId: string; toolCallId: string } | null {
  if (value.length < 4 || value.length > 200) {
    return null;
  }
  if (!value.startsWith('"') || !value.endsWith('"')) {
    return null;
  }
  const inner = value.slice(1, -1);
  const colon = inner.indexOf(":");
  if (colon <= 0) {
    return null;
  }
  const runId = inner.slice(0, colon);
  const toolCallId = inner.slice(colon + 1);
  if (toolCallId.includes(":")) {
    return null;
  }
  if (formatIdempotencyKey(runId, toolCallId) === null) {
    return null;
  }
  return { runId, toolCallId };
}
