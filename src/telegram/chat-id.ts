/** Границы Postgres int8. Number() для chat_id не используется. */
const INT8_MIN = -9223372036854775808n;
const INT8_MAX = 9223372036854775807n;

/**
 * Десятичная строка → bigint.
 * JSON-число сюда не приходит: оно уже потеряло бы младшие разряды в Number.
 * null — строка не канонический int8.
 */
export function parseDecimalChatId(value: string): bigint | null {
  if (!isCanonicalInt8(value)) {
    return null;
  }
  const parsed = BigInt(value);
  if (parsed < INT8_MIN || parsed > INT8_MAX) {
    return null;
  }
  return parsed;
}

/**
 * grammY отдаёт id уже как number после JSON.parse.
 * Небезопасное целое восстановить нельзя, поэтому такой id не ставит запуск.
 * Number() здесь не вызывается.
 */
export function decimalFromSafeInteger(value: number): string | null {
  if (!Number.isSafeInteger(value)) {
    return null;
  }
  return value.toString();
}

export function canonicalUserId(value: string): string | null {
  const parsed = parseDecimalChatId(value);
  if (parsed === null || parsed <= 0n) {
    return null;
  }
  return parsed.toString();
}

function isCanonicalInt8(value: string): boolean {
  if (value.length < 1 || value.length > 20) {
    return false;
  }
  const digitsStart = value.charCodeAt(0) === 45 ? 1 : 0;
  if (digitsStart === value.length) {
    return false;
  }
  for (let index = digitsStart; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) {
      return false;
    }
  }
  return BigInt(value).toString() === value;
}
