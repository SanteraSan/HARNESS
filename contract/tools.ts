import { z } from "zod";

import { canonicalBody } from "./canonical.js";
import { enumerableNames, isPlainObject, readOwn, scanData } from "./data.js";
import { issueReason, parseToolRequest, type ToolRequest } from "./envelope.js";
import { parseIdempotencyHeader } from "./idempotency.js";
import { RECORD_NOTE_TEXT_MAX, TOOL_NAME_RE, TOOL_PATH_MAX } from "./limits.js";
import { CONTRACT_VERSION, type ParseResult } from "./result.js";

export const TOOL_CALL_METHOD = "POST";

export const TOOL_CALL_CONTENT_TYPE = "application/json; charset=utf-8";

export const CONTRACT_HEADER_NAME = "X-Contract-Version";

export const IDEMPOTENCY_HEADER_NAME = "Idempotency-Key";

export const READ_FILE_DESCRIPTION =
  "Читает текстовый файл UTF-8 внутри рабочего каталога. Каталог, бинарные данные и путь снаружи корня — ошибка.";

export const LIST_DIR_DESCRIPTION =
  "Показывает один уровень каталога: имя и признак каталога. Во вложенные каталоги не спускается.";

export const RECORD_NOTE_DESCRIPTION =
  "Записывает текстовый файл в каталог out. Повтор с тем же ключом идемпотентности возвращает первый результат и не создаёт второй файл.";

const pathSchema = z.string().min(1).max(TOOL_PATH_MAX);

export const readFileArgumentsSchema = z
  .object({
    path: pathSchema,
  })
  .strict();

export const listDirArgumentsSchema = z
  .object({
    path: pathSchema.optional(),
  })
  .strict();

/**
 * path и text — те же имена, что в src/tools/record-note.ts.
 * idempotency_key в аргументах процесса сюда не входит: ключ пишет заголовок,
 * а оставшееся поле strict помечает как unknown_field.
 * maxLength text здесь 32768, в процессе — 65536: тело вызова не больше 32 КиБ.
 */
export const recordNoteArgumentsSchema = z
  .object({
    path: pathSchema,
    text: z.string().min(1).max(RECORD_NOTE_TEXT_MAX),
  })
  .strict();

export const HUB_TOOLS = [
  {
    name: "read_file",
    description: READ_FILE_DESCRIPTION,
    effect: "read",
    acceptsBlobs: false,
    call: {
      method: TOOL_CALL_METHOD,
      path: "/v1/tools/read_file",
      idempotency: "optional",
    },
  },
  {
    name: "list_dir",
    description: LIST_DIR_DESCRIPTION,
    effect: "read",
    acceptsBlobs: false,
    call: {
      method: TOOL_CALL_METHOD,
      path: "/v1/tools/list_dir",
      idempotency: "optional",
    },
  },
  {
    name: "record_note",
    description: RECORD_NOTE_DESCRIPTION,
    effect: "write",
    acceptsBlobs: false,
    call: {
      method: TOOL_CALL_METHOD,
      path: "/v1/tools/record_note",
      idempotency: "required",
    },
  },
] as const;

export type HubToolName = (typeof HUB_TOOLS)[number]["name"];

export type HubToolEffect = (typeof HUB_TOOLS)[number]["effect"];

export interface ParsedToolCall {
  request: ToolRequest;
  toolName: HubToolName;
  effect: HubToolEffect;
  arguments: Record<string, unknown>;
  canonicalText: string;
  bodySha256: Uint8Array;
  idempotencyKey: string | null;
}

export interface ToolCallInput {
  body: string | Uint8Array;
  contractHeader: string | null;
  idempotencyKey: string | readonly string[] | null;
  pathName: string;
}

export function toolCallPath(name: string): string | null {
  if (name.length === 0 || name.length > 64 || !TOOL_NAME_RE.test(name)) {
    return null;
  }
  return `/v1/tools/${name}`;
}

/** Один сегмент пути. Слэш, `.` и `..` именем инструмента не являются. */
export function decodeToolPathName(segment: string): string | null {
  if (segment.length === 0 || segment.length > 256) {
    return null;
  }
  if (segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (decoded.length === 0 || decoded.length > 64 || decoded === "." || decoded === "..") {
    return null;
  }
  if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
    return null;
  }
  if (!TOOL_NAME_RE.test(decoded)) {
    return null;
  }
  return decoded;
}

/**
 * Копия аргументов без idempotency_key.
 * Сервис это поле не принимает; хаб снимает его до отправки, если модель его прислала.
 */
export function omitIdempotencyArgument(value: unknown): ParseResult<Record<string, unknown>> {
  const scanned = scanData(value);
  if (!scanned.ok) {
    return scanned;
  }
  if (!isPlainObject(value)) {
    return { ok: false, reason: "invalid_body" };
  }
  const copy: Record<string, unknown> = {};
  for (const key of enumerableNames(value)) {
    if (key === "idempotency_key") {
      continue;
    }
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: readOwn(value, key),
      writable: true,
    });
  }
  return { ok: true, value: copy };
}

export function parseToolArguments(
  name: string,
  args: unknown,
): ParseResult<Record<string, unknown>> {
  if (name === "read_file") {
    return parseArguments(readFileArgumentsSchema, args);
  }
  if (name === "list_dir") {
    return parseArguments(listDirArgumentsSchema, args);
  }
  if (name === "record_note") {
    return parseArguments(recordNoteArgumentsSchema, args);
  }
  return { ok: false, reason: "unknown_tool" };
}

function parseArguments(
  schema: z.ZodType<unknown>,
  args: unknown,
): ParseResult<Record<string, unknown>> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, reason: issueReason(parsed.error.issues) };
  }
  if (!isPlainObject(parsed.data)) {
    return { ok: false, reason: "invalid_body" };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Разбор вызова. Сеть не открывает и воркер отсюда не зовётся.
 * Для write заголовок идемпотентности обязателен. Для read его отсутствие — не ошибка.
 */
export function parseToolCall(input: ToolCallInput): ParseResult<ParsedToolCall> {
  const pathName = decodeToolPathName(input.pathName);
  if (pathName === null) {
    return { ok: false, reason: "invalid_body" };
  }
  const request = parseToolRequest(input.body);
  if (!request.ok) {
    return request;
  }
  if (input.contractHeader !== CONTRACT_VERSION) {
    return { ok: false, reason: "unsupported_version" };
  }
  if (pathName !== request.value.name) {
    return { ok: false, reason: "invalid_body" };
  }
  const tool = findHubTool(request.value.name);
  if (tool === undefined) {
    return { ok: false, reason: "unknown_tool" };
  }
  const args = parseToolArguments(tool.name, request.value.arguments);
  if (!args.ok) {
    return args;
  }
  const header = parseIdempotencyHeader(input.idempotencyKey);
  if (header.status === "invalid") {
    return { ok: false, reason: "invalid_body" };
  }
  if (tool.effect === "write" && header.status !== "present") {
    return { ok: false, reason: "invalid_body" };
  }
  if (
    header.status === "present" &&
    (header.runId !== request.value.run_id || header.toolCallId !== request.value.tool_call_id)
  ) {
    return { ok: false, reason: "invalid_body" };
  }
  const canonical = canonicalBody(request.value);
  if (!canonical.ok) {
    return canonical;
  }
  return {
    ok: true,
    value: {
      request: request.value,
      toolName: tool.name,
      effect: tool.effect,
      arguments: args.value,
      canonicalText: canonical.value.text,
      bodySha256: canonical.value.sha256,
      idempotencyKey: header.status === "present" ? header.key : null,
    },
  };
}

function findHubTool(name: string): (typeof HUB_TOOLS)[number] | undefined {
  for (const tool of HUB_TOOLS) {
    if (tool.name === name) {
      return tool;
    }
  }
  return undefined;
}
