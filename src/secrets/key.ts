import { SecretError } from "./errors.js";

/** Короткий или огромный пароль не принимаем: тестовое значение длиннее порога. */
const KEY_MIN = 16;
const KEY_MAX = 256;

/**
 * Ключ шифрования коннектора из окружения вызывающего.
 * Модуль сам process.env не читает: значение собирает конфигурация процесса.
 * В репозиторий ключ не пишется.
 */
export function encryptionKeyFrom(env: { CONNECTOR_SECRETS_KEY?: string }): string {
  const raw = env.CONNECTOR_SECRETS_KEY;
  if (raw === undefined || raw.trim().length === 0) {
    throw new SecretError("key_missing", "connector encryption key is missing");
  }
  return assertEncryptionKey(raw.trim());
}

export function assertEncryptionKey(key: string): string {
  if (key.length < KEY_MIN || key.length > KEY_MAX) {
    throw new SecretError("key_invalid", "connector encryption key is invalid");
  }
  return key;
}
