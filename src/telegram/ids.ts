/** Идентификатор запуска и агента — uuid. Длину проверяем до посимвольного разбора. */
export function isUuid(value: string): boolean {
  if (value.length !== 36) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const dash = index === 8 || index === 13 || index === 18 || index === 23;
    if (dash) {
      if (code !== 45) {
        return false;
      }
      continue;
    }
    const hex =
      (code >= 48 && code <= 57) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
    if (!hex) {
      return false;
    }
  }
  return true;
}

/** update_id Telegram — положительное десятичное число без ведущих нулей. */
export function canonicalUpdateId(value: string): string | null {
  if (value.length < 1 || value.length > 20) {
    return null;
  }
  if (value.charCodeAt(0) === 48) {
    return null;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) {
      return null;
    }
  }
  return value;
}
