import { createHash } from "node:crypto";

import { enumerableNames, isPlainObject, readOwn, scanData } from "./data.js";
import { JSON_BODY_LIMIT_BYTES } from "./limits.js";
import { type ParseResult } from "./result.js";

const MAX_SCAN_DEPTH = 32;

interface Cursor {
  index: number;
}

/** Повтор ключа в одном объекте — invalid_body ещё до хеша. Сканер не компилирует pattern схемы. */
export function parseJsonBody(raw: string | Uint8Array): ParseResult<unknown> {
  const text = typeof raw === "string" ? raw : decodeUtf8(raw);
  if (text === null) {
    return { ok: false, reason: "invalid_body" };
  }
  if (Buffer.byteLength(text, "utf8") > JSON_BODY_LIMIT_BYTES) {
    return { ok: false, reason: "payload_too_large" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "invalid_body" };
  }
  if (!keysAreUnique(text)) {
    return { ok: false, reason: "invalid_body" };
  }
  const scanned = scanData(value);
  if (!scanned.ok) {
    return scanned;
  }
  return { ok: true, value };
}

/**
 * Канон: UTF-8, без пробелов, ключи по байтам UTF-8, порядок массива сохранён,
 * строки как у JSON.stringify. -0 пишется как 0.
 */
export function canonicalBody(value: unknown): ParseResult<{ text: string; sha256: Uint8Array }> {
  const scanned = scanData(value);
  if (!scanned.ok) {
    return scanned;
  }
  const text = canonicalize(value, 0);
  if (text === null) {
    return { ok: false, reason: "invalid_body" };
  }
  return { ok: true, value: { text, sha256: sha256Bytes(text) } };
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function sha256Bytes(text: string): Uint8Array {
  const digest = createHash("sha256").update(text, "utf8").digest();
  return Uint8Array.from(digest);
}

function canonicalize(value: unknown, depth: number): string | null {
  if (depth > MAX_SCAN_DEPTH) {
    return null;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const part = canonicalize(item, depth + 1);
      if (part === null) {
        return null;
      }
      parts.push(part);
    }
    return `[${parts.join(",")}]`;
  }
  if (!isPlainObject(value)) {
    return null;
  }
  const keys = enumerableNames(value).sort(compareUtf8);
  const parts: string[] = [];
  for (const key of keys) {
    const inner = canonicalize(readOwn(value, key), depth + 1);
    if (inner === null) {
      return null;
    }
    parts.push(`${JSON.stringify(key)}:${inner}`);
  }
  return `{${parts.join(",")}}`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function keysAreUnique(text: string): boolean {
  const cursor: Cursor = { index: 0 };
  if (!readValue(text, cursor, 0)) {
    return false;
  }
  skipWhitespace(text, cursor);
  return cursor.index === text.length;
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
  if (depth > MAX_SCAN_DEPTH) {
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
    text += String.fromCharCode(code);
    cursor.index += 1;
  }
  return null;
}

function readEscape(source: string, cursor: Cursor): string | null {
  const escaped = source.charCodeAt(cursor.index + 1);
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
  const hex = source.slice(cursor.index + 2, cursor.index + 6);
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
    return null;
  }
  cursor.index += 6;
  return String.fromCharCode(Number.parseInt(hex, 16));
}
