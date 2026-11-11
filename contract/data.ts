export type DataScan = { ok: true } | { ok: false; reason: "unknown_field" | "invalid_body" };

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export const MAX_DATA_DEPTH = 32;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function readOwn(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.enumerable !== true) {
    return undefined;
  }
  return descriptor.value as unknown;
}

export function enumerableNames(value: object): string[] {
  const names: string[] = [];
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable === true) {
      names.push(key);
    }
  }
  return names;
}

export function scanData(value: unknown, depth = 0): DataScan {
  if (depth > MAX_DATA_DEPTH) {
    return { ok: false, reason: "invalid_body" };
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = scanData(item, depth + 1);
      if (!nested.ok) {
        return nested;
      }
    }
    return { ok: true };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { ok: false, reason: "invalid_body" };
    }
    return { ok: true };
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { ok: true };
  }
  if (!isPlainObject(value)) {
    return { ok: false, reason: "invalid_body" };
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return { ok: false, reason: "unknown_field" };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      continue;
    }
    const nested = scanData(descriptor.value, depth + 1);
    if (!nested.ok) {
      return nested;
    }
  }
  return { ok: true };
}

export function codePointLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length;) {
    const code = value.codePointAt(index);
    count += 1;
    index += code !== undefined && code > 0xffff ? 2 : 1;
  }
  return count;
}

/** Потолок JSON Schema maxLength: кодпоинты, не String.length. */
export function isCodePointBounded(value: string, min: number, max: number): boolean {
  const length = codePointLength(value);
  return length >= min && length <= max;
}

/** Управляющие символы, включая перевод строки: в error стек не помещается. */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length;) {
    const code = value.codePointAt(index);
    if (code === undefined) {
      return true;
    }
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
    index += code > 0xffff ? 2 : 1;
  }
  return false;
}
