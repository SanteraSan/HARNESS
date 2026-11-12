import { z } from "zod";

/**
 * Текст роли tool, который модель увидит следующим ходом.
 * Сырой JSON и заголовки сюда не входят.
 * При ok false в роль tool идёт строка error после той же подготовки, что и text.
 * Вызовы внутри текста не разбираются.
 * Скрытые символы снимаются с полного текста, затем redact вызывающего,
 * и только потом хвост режется до 8000 кодпоинтов.
 */
export const MODEL_TOOL_TEXT_CHARS = 8000;

/**
 * Потолок тела ответа сервиса. Совпадает с RESPONSE_BODY_LIMIT_BYTES:
 * худший JSON текста файла в 64 КиБ плюс конверт. Тело принимается целиком,
 * prepareToolResultText режет модель до 8000 кодпоинтов.
 */
export const SERVICE_RESPONSE_BODY_BYTES = 393_627;

const SERVICE_TEXT_MAX_CODE_POINTS = 65_536;

const SERVICE_ERROR_MAX_CODE_POINTS = 200;

const SERVICE_DURATION_MAX_MS = 600_000;

const SERVICE_BLOBS_MAX = 8;

const SCAN_DEPTH_MAX = 32;

export const SERVICE_CONTRACT_VERSION = "harness.tool.v1";

export type ServiceRejection =
  "unknown_field" | "unsupported_version" | "payload_too_large" | "invalid_body";

export type PreparedToolText = { ok: true; text: string } | { ok: false; reason: ServiceRejection };

export type ToolResultInput =
  { source: "tool"; text: string } | { source: "service"; body: string };

const blobIdSchema = z.string().refine((value) => isLowerUuid(value));

const successSchema = z
  .object({
    contract: z.literal(SERVICE_CONTRACT_VERSION),
    ok: z.literal(true),
    text: z.string().refine((value) => codePointLength(value) <= SERVICE_TEXT_MAX_CODE_POINTS),
    truncated: z.boolean(),
    duration_ms: z.number().int().min(0).max(SERVICE_DURATION_MAX_MS),
    blobs: z
      .array(blobIdSchema)
      .max(SERVICE_BLOBS_MAX)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();

const failureSchema = z
  .object({
    contract: z.literal(SERVICE_CONTRACT_VERSION),
    ok: z.literal(false),
    error: z.string().refine((value) => isServiceErrorText(value)),
    error_code: z.string(),
    truncated: z.boolean(),
    duration_ms: z.number().int().min(0).max(SERVICE_DURATION_MAX_MS),
    blobs: z.array(blobIdSchema).max(0),
  })
  .strict();

const serviceResponseSchema = z.discriminatedUnion("ok", [successSchema, failureSchema]);

interface Cursor {
  index: number;
}

/**
 * Готовит текст для роли tool.
 * `source: "tool"` — уже отделённый текст read_file, list_dir и любого локального результата.
 * `source: "service"` — тело ответа сервиса: при ok true в модель попадает поле text,
 * при ok false — строка error. Оба проходят одну подготовку. Сырой JSON не возвращается.
 * `redactText` вызывается после снятия скрытых символов и до обрезки.
 */
export function prepareToolResultForModel(
  input: { source: "tool"; text: string },
  redactText?: (value: string) => string,
): {
  ok: true;
  text: string;
};
export function prepareToolResultForModel(
  input: {
    source: "service";
    body: string;
  },
  redactText?: (value: string) => string,
): PreparedToolText;
export function prepareToolResultForModel(
  input: ToolResultInput,
  redactText?: (value: string) => string,
): PreparedToolText {
  if (input.source === "tool") {
    return { ok: true, text: textForModel(input.text, redactText) };
  }
  return serviceTextForModel(input.body, redactText);
}

/** Режет скрытые символы и хвост. Обычные буквы, цифры, таб и перевод строки оставляет. */
export function prepareToolResultText(text: string): string {
  return textForModel(text);
}

/**
 * Обрезка до redact оставляет префикс секрета, который начинается до 8000-й границы.
 * Скрытый символ внутри секрета снимается раньше, иначе маска его не видит.
 */
function textForModel(text: string, redactText?: (value: string) => string): string {
  const stripped = stripToolResultControls(text);
  const masked = redactText === undefined ? stripped : redactText(stripped);
  return clipToolResultText(masked);
}

function stripToolResultControls(text: string): string {
  let result = "";
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code === undefined || isHiddenCodePoint(code)) {
      continue;
    }
    result += character;
  }
  return result;
}

function clipToolResultText(text: string): string {
  let result = "";
  let count = 0;
  for (const character of text) {
    if (count === MODEL_TOOL_TEXT_CHARS) {
      break;
    }
    result += character;
    count += 1;
  }
  return result;
}

function serviceTextForModel(
  raw: string,
  redactText?: (value: string) => string,
): PreparedToolText {
  if (Buffer.byteLength(raw, "utf8") > SERVICE_RESPONSE_BODY_BYTES) {
    return { ok: false, reason: "payload_too_large" };
  }
  // Повтор ключа склеился бы в JSON.parse, и второе text подменило бы первое.
  if (!jsonKeysAreUnique(raw)) {
    return { ok: false, reason: "invalid_body" };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: "invalid_body" };
  }

  const scanned = scanParsed(value, 0);
  if (scanned !== null) {
    return { ok: false, reason: scanned };
  }
  if (!isPlainObject(value)) {
    return { ok: false, reason: "invalid_body" };
  }
  if (foreignContract(value)) {
    return { ok: false, reason: "unsupported_version" };
  }

  const parsed = serviceResponseSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: issueReason(parsed.error.issues) };
  }
  if (parsed.data.ok === false) {
    return { ok: true, text: textForModel(parsed.data.error, redactText) };
  }
  return { ok: true, text: textForModel(parsed.data.text, redactText) };
}

function foreignContract(value: object): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, "contract");
  if (descriptor === undefined || descriptor.enumerable !== true) {
    return false;
  }
  return descriptor.value !== SERVICE_CONTRACT_VERSION;
}

function issueReason(issues: readonly { code: string }[]): ServiceRejection {
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      return "unknown_field";
    }
  }
  return "invalid_body";
}

/**
 * C0 кроме перевода строки и таба, плюс символы, которыми прячут направление текста.
 * U+007F и C1 сюда не входят: правило их не называет.
 */
function isHiddenCodePoint(code: number): boolean {
  if (code === 0x09 || code === 0x0a) {
    return false;
  }
  if (code <= 0x1f) {
    return true;
  }
  if (code >= 0x200b && code <= 0x200f) {
    return true;
  }
  if (code >= 0x202a && code <= 0x202e) {
    return true;
  }
  if (code >= 0x2066 && code <= 0x2069) {
    return true;
  }
  return code === 0xfeff;
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function scanParsed(value: unknown, depth: number): ServiceRejection | null {
  if (depth > SCAN_DEPTH_MAX) {
    return "invalid_body";
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return "invalid_body";
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = scanParsed(item, depth + 1);
      if (reason !== null) {
        return reason;
      }
    }
    return null;
  }
  if (!isPlainObject(value)) {
    return "unknown_field";
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return "unknown_field";
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      continue;
    }
    const reason = scanParsed(descriptor.value, depth + 1);
    if (reason !== null) {
      return reason;
    }
  }
  return null;
}

function isServiceErrorText(value: string): boolean {
  const length = codePointLength(value);
  return length >= 1 && length <= SERVICE_ERROR_MAX_CODE_POINTS && !hasControlCharacter(value);
}

function codePointLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length;) {
    const code = value.codePointAt(index);
    count += 1;
    index += code !== undefined && code > 0xffff ? 2 : 1;
  }
  return count;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) {
      return true;
    }
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function isLowerUuid(value: string): boolean {
  if (value.length !== 36) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      if (code !== 45) {
        return false;
      }
      continue;
    }
    const digit = code >= 48 && code <= 57;
    const lowerHex = code >= 97 && code <= 102;
    if (!digit && !lowerHex) {
      return false;
    }
  }
  return true;
}

function jsonKeysAreUnique(source: string): boolean {
  const cursor: Cursor = { index: 0 };
  if (!readValue(source, cursor, 0)) {
    return false;
  }
  skipWhitespace(source, cursor);
  return cursor.index === source.length;
}

function skipWhitespace(source: string, cursor: Cursor): void {
  const length = source.length;
  while (cursor.index < length) {
    const code = source.charCodeAt(cursor.index);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) {
      return;
    }
    cursor.index += 1;
  }
}

function readValue(source: string, cursor: Cursor, depth: number): boolean {
  if (depth > SCAN_DEPTH_MAX) {
    return false;
  }
  skipWhitespace(source, cursor);
  const code = source.charCodeAt(cursor.index);
  if (code === 123) {
    return readObject(source, cursor, depth);
  }
  if (code === 91) {
    return readArray(source, cursor, depth);
  }
  if (code === 34) {
    return readString(source, cursor) !== null;
  }
  return readLiteral(source, cursor);
}

function readObject(source: string, cursor: Cursor, depth: number): boolean {
  cursor.index += 1;
  const seen = new Set<string>();
  skipWhitespace(source, cursor);
  if (source.charCodeAt(cursor.index) === 125) {
    cursor.index += 1;
    return true;
  }
  for (;;) {
    const key = readString(source, cursor);
    if (key === null) {
      return false;
    }
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    skipWhitespace(source, cursor);
    if (source.charCodeAt(cursor.index) !== 58) {
      return false;
    }
    cursor.index += 1;
    if (!readValue(source, cursor, depth + 1)) {
      return false;
    }
    skipWhitespace(source, cursor);
    const next = source.charCodeAt(cursor.index);
    if (next === 125) {
      cursor.index += 1;
      return true;
    }
    if (next !== 44) {
      return false;
    }
    cursor.index += 1;
    skipWhitespace(source, cursor);
  }
}

function readArray(source: string, cursor: Cursor, depth: number): boolean {
  cursor.index += 1;
  skipWhitespace(source, cursor);
  if (source.charCodeAt(cursor.index) === 93) {
    cursor.index += 1;
    return true;
  }
  for (;;) {
    if (!readValue(source, cursor, depth + 1)) {
      return false;
    }
    skipWhitespace(source, cursor);
    const next = source.charCodeAt(cursor.index);
    if (next === 93) {
      cursor.index += 1;
      return true;
    }
    if (next !== 44) {
      return false;
    }
    cursor.index += 1;
    skipWhitespace(source, cursor);
  }
}

function readLiteral(source: string, cursor: Cursor): boolean {
  const start = cursor.index;
  const length = source.length;
  while (cursor.index < length) {
    const code = source.charCodeAt(cursor.index);
    if (
      code === 44 ||
      code === 125 ||
      code === 93 ||
      code === 32 ||
      code === 9 ||
      code === 10 ||
      code === 13
    ) {
      break;
    }
    cursor.index += 1;
  }
  return cursor.index > start;
}

function readString(source: string, cursor: Cursor): string | null {
  if (source.charCodeAt(cursor.index) !== 34) {
    return null;
  }
  cursor.index += 1;
  let text = "";
  const length = source.length;
  while (cursor.index < length) {
    const code = source.charCodeAt(cursor.index);
    if (code === 34) {
      cursor.index += 1;
      return text;
    }
    if (code < 0x20) {
      return null;
    }
    if (code === 92) {
      const escaped = readEscape(source, cursor);
      if (escaped === null) {
        return null;
      }
      text += escaped;
      continue;
    }
    const character = readCodePoint(source, cursor, code);
    if (character === null) {
      return null;
    }
    text += character;
  }
  return null;
}

function readCodePoint(source: string, cursor: Cursor, code: number): string | null {
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = source.charCodeAt(cursor.index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) {
      cursor.index += 2;
      return String.fromCodePoint((code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000);
    }
  }
  cursor.index += 1;
  return String.fromCharCode(code);
}

function readEscape(source: string, cursor: Cursor): string | null {
  const escaped = source.charCodeAt(cursor.index + 1);
  if (Number.isNaN(escaped)) {
    return null;
  }
  if (escaped === 34 || escaped === 92 || escaped === 47) {
    cursor.index += 2;
    return String.fromCharCode(escaped);
  }
  if (escaped === 98) {
    cursor.index += 2;
    return "\b";
  }
  if (escaped === 102) {
    cursor.index += 2;
    return "\f";
  }
  if (escaped === 110) {
    cursor.index += 2;
    return "\n";
  }
  if (escaped === 114) {
    cursor.index += 2;
    return "\r";
  }
  if (escaped === 116) {
    cursor.index += 2;
    return "\t";
  }
  if (escaped !== 117) {
    return null;
  }
  const hex = hex4(source, cursor.index + 2);
  if (hex === null) {
    return null;
  }
  cursor.index += 6;
  return String.fromCharCode(hex);
}

function hex4(source: string, index: number): number | null {
  if (index + 4 > source.length) {
    return null;
  }
  let value = 0;
  for (let offset = 0; offset < 4; offset += 1) {
    const digit = hexDigit(source.charCodeAt(index + offset));
    if (digit === null) {
      return null;
    }
    value = value * 16 + digit;
  }
  return value;
}

function hexDigit(code: number): number | null {
  if (code >= 48 && code <= 57) {
    return code - 48;
  }
  if (code >= 97 && code <= 102) {
    return code - 87;
  }
  if (code >= 65 && code <= 70) {
    return code - 55;
  }
  return null;
}
