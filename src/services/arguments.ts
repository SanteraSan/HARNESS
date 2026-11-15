import { codePointLength, isPlainObject, readOwn } from "../../contract/data.js";

const SCHEMA_DEPTH = 8;

/**
 * Проверка аргументов по закрытому подмножеству схемы манифеста.
 * pattern, $ref и прочие ключи манифест уже отверг: здесь их нет и регулярных выражений нет.
 * Известные read_file, list_dir и record_note остаются на своём zod.
 */
export function parseServiceArguments(
  schema: Record<string, unknown>,
  args: unknown,
): Record<string, unknown> | null {
  if (!valueMatches(schema, args, 0) || !isPlainObject(args)) {
    return null;
  }
  return args;
}

function valueMatches(schema: unknown, value: unknown, depth: number): boolean {
  if (depth > SCHEMA_DEPTH || !isPlainObject(schema)) {
    return false;
  }
  const type = readOwn(schema, "type");
  if (typeof type !== "string") {
    return false;
  }
  if (!enumMatches(schema, value)) {
    return false;
  }
  if (type === "object") {
    return objectMatches(schema, value, depth);
  }
  if (type === "string") {
    return stringMatches(schema, value);
  }
  if (type === "integer") {
    return typeof value === "number" && Number.isSafeInteger(value);
  }
  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (type === "boolean") {
    return typeof value === "boolean";
  }
  return false;
}

function objectMatches(schema: Record<string, unknown>, value: unknown, depth: number): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  const properties = readOwn(schema, "properties");
  if (properties !== undefined && !isPlainObject(properties)) {
    return false;
  }
  const required = readOwn(schema, "required");
  if (!requiredPresent(required, value)) {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return false;
    }
    const propertySchema = properties === undefined ? undefined : readOwn(properties, key);
    if (!isPlainObject(propertySchema)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!valueMatches(propertySchema, descriptor?.value, depth + 1)) {
      return false;
    }
  }
  return true;
}

function requiredPresent(required: unknown, value: Record<string, unknown>): boolean {
  if (required === undefined) {
    return true;
  }
  if (!Array.isArray(required)) {
    return false;
  }
  for (const name of required) {
    if (typeof name !== "string" || !Object.hasOwn(value, name)) {
      return false;
    }
  }
  return true;
}

function stringMatches(schema: Record<string, unknown>, value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const length = codePointLength(value);
  const minLength = readOwn(schema, "minLength");
  const maxLength = readOwn(schema, "maxLength");
  if (minLength !== undefined && (!isWhole(minLength) || length < minLength)) {
    return false;
  }
  if (maxLength !== undefined && (!isWhole(maxLength) || length > maxLength)) {
    return false;
  }
  return true;
}

function enumMatches(schema: Record<string, unknown>, value: unknown): boolean {
  if (!Object.hasOwn(schema, "enum")) {
    return true;
  }
  const options = readOwn(schema, "enum");
  if (!Array.isArray(options)) {
    return false;
  }
  for (const option of options) {
    if (Object.is(option, value)) {
      return true;
    }
  }
  return false;
}

function isWhole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
