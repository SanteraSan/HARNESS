import {
  codePointLength,
  enumerableNames,
  isPlainObject,
  readOwn,
  scanData,
} from "../../contract/data.js";
import type { ServiceTool } from "../../contract/manifest.js";
import type { ParseResult } from "../../contract/result.js";
import { parseToolArguments } from "../../contract/tools.js";

const SCHEMA_DEPTH_MAX = 8;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Три локальных имени остаются на parseToolArguments.
 * Остальные сверяются со схемой манифеста: pattern, format и items не компилируются.
 * Длина строки — кодпоинты. Лишнее поле и запрещённый ключ — отказ до fetch.
 */
export function parseServiceToolArguments(
  tool: ServiceTool,
  args: unknown,
): ParseResult<Record<string, unknown>> {
  if (tool.name === "read_file" || tool.name === "list_dir" || tool.name === "record_note") {
    return parseToolArguments(tool.name, args);
  }
  const scanned = scanData(args);
  if (!scanned.ok) {
    return scanned;
  }
  const value = materialize(tool.parameters, args, 0);
  if (!isPlainObject(value)) {
    return { ok: false, reason: "invalid_body" };
  }
  return { ok: true, value };
}

function materialize(schema: object, value: unknown, depth: number): unknown {
  if (depth > SCHEMA_DEPTH_MAX || !isPlainObject(schema)) {
    return undefined;
  }
  const type = readOwn(schema, "type");
  if (type === "object") {
    return materializeObject(schema, value, depth);
  }
  if (type === "string") {
    return materializeString(schema, value);
  }
  if (type === "integer") {
    return materializeInteger(schema, value);
  }
  if (type === "number") {
    return materializeNumber(schema, value);
  }
  if (type === "boolean") {
    return materializeBoolean(schema, value);
  }
  return undefined;
}

function materializeObject(
  schema: object,
  value: unknown,
  depth: number,
): Record<string, unknown> | undefined {
  if (!isPlainObject(value) || readOwn(schema, "additionalProperties") !== false) {
    return undefined;
  }
  const properties = readOwn(schema, "properties");
  if (properties !== undefined && !isPlainObject(properties)) {
    return undefined;
  }
  const propertyMap = isPlainObject(properties) ? properties : undefined;
  const names = enumerableNames(value);
  for (const name of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.has(name) || !names.includes(name)) {
      return undefined;
    }
    if (propertyMap === undefined || !Object.hasOwn(propertyMap, name)) {
      return undefined;
    }
  }
  const required = readOwn(schema, "required");
  if (required !== undefined) {
    if (!Array.isArray(required)) {
      return undefined;
    }
    const present = new Set(names);
    for (const item of required) {
      if (typeof item !== "string" || !present.has(item)) {
        return undefined;
      }
    }
  }
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    const childSchema = propertyMap === undefined ? undefined : readOwn(propertyMap, name);
    if (!isPlainObject(childSchema)) {
      return undefined;
    }
    const child = materialize(childSchema, readOwn(value, name), depth + 1);
    if (child === undefined) {
      return undefined;
    }
    Object.defineProperty(copy, name, {
      configurable: true,
      enumerable: true,
      value: child,
      writable: true,
    });
  }
  if (!enumMatches(schema, copy)) {
    return undefined;
  }
  return copy;
}

function materializeString(schema: object, value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const length = codePointLength(value);
  const min = lengthBound(schema, "minLength");
  const max = lengthBound(schema, "maxLength");
  if (min === null || max === null) {
    return undefined;
  }
  if (min !== undefined && length < min) {
    return undefined;
  }
  if (max !== undefined && length > max) {
    return undefined;
  }
  if (!enumMatches(schema, value)) {
    return undefined;
  }
  return value;
}

function materializeInteger(schema: object, value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }
  if (!enumMatches(schema, value)) {
    return undefined;
  }
  return value;
}

function materializeNumber(schema: object, value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (!enumMatches(schema, value)) {
    return undefined;
  }
  return value;
}

function materializeBoolean(schema: object, value: unknown): boolean | undefined {
  if (typeof value !== "boolean") {
    return undefined;
  }
  if (!enumMatches(schema, value)) {
    return undefined;
  }
  return value;
}

function lengthBound(schema: object, key: "minLength" | "maxLength"): number | null | undefined {
  if (!Object.hasOwn(schema, key)) {
    return undefined;
  }
  const value = readOwn(schema, key);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function enumMatches(schema: object, value: unknown): boolean {
  if (!Object.hasOwn(schema, "enum")) {
    return true;
  }
  const listed = readOwn(schema, "enum");
  if (!Array.isArray(listed)) {
    return false;
  }
  for (const item of listed) {
    if (Object.is(item, value)) {
      return true;
    }
  }
  return false;
}
