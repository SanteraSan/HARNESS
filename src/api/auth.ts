import { createHash, timingSafeEqual } from "node:crypto";

const BEARER_PREFIX = "Bearer ";

/**
 * Сравниваются SHA-256 обоих значений, оба по 32 байта.
 * Длина секрета не читается по времени: timingSafeEqual вызывается только на этих дайджестах.
 * Пустой ожидаемый токен отвергается до хеша: иначе пустой секрет открыл бы API.
 */
export function bearerMatches(expected: string, headerValue: string | undefined): boolean {
  if (headerValue === undefined || expected.length === 0) {
    return false;
  }
  if (headerValue.length < BEARER_PREFIX.length || !headerValue.startsWith(BEARER_PREFIX)) {
    return false;
  }

  const presented = headerValue.slice(BEARER_PREFIX.length);
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  const presentedHash = createHash("sha256").update(presented, "utf8").digest();
  return timingSafeEqual(expectedHash, presentedHash);
}
