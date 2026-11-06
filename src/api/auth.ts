import { timingSafeEqual } from "node:crypto";

const BEARER_PREFIX = "Bearer ";

/**
 * Секрет сравнивается через timingSafeEqual и только при равной длине буферов.
 * Пустой токен не подходит ни к какому заголовку: иначе пустой секрет открыл бы API.
 */
export function bearerMatches(expected: string, headerValue: string | undefined): boolean {
  if (headerValue === undefined || expected.length === 0) {
    return false;
  }
  if (headerValue.length < BEARER_PREFIX.length || !headerValue.startsWith(BEARER_PREFIX)) {
    return false;
  }

  const presented = headerValue.slice(BEARER_PREFIX.length);
  const expectedBytes = Buffer.from(expected, "utf8");
  const presentedBytes = Buffer.from(presented, "utf8");
  if (expectedBytes.length !== presentedBytes.length) {
    return false;
  }
  return timingSafeEqual(expectedBytes, presentedBytes);
}
