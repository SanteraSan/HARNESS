/** Тело вызова. Раннер уже режет аргументы на этом же пределе. */
export const JSON_BODY_LIMIT_BYTES = 32 * 1024;

/** Текст, который хаб отдаёт модели после ответа сервиса. Считается в кодпоинтах. */
export const MODEL_TOOL_TEXT_CHARS = 8000;

export const DESCRIPTION_MAX = 500;

export const TOOL_PATH_MAX = 4096;

/**
 * Жёстче потолка `text` в src/tools/record-note.ts (65536).
 * Вместе с JSON вызов обязан уложиться в 32 КиБ.
 */
export const RECORD_NOTE_TEXT_MAX = 32768;

export const RESPONSE_TEXT_MAX_CODE_POINTS = 65536;

export const ERROR_TEXT_MAX_CODE_POINTS = 200;

export const DURATION_MS_MAX = 600_000;

export const BLOBS_MAX = 8;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const TOOL_CALL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Имя инструмента: без слэша, точки и двоеточия. Регистр нужен запрету `Bash`. */
export const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const SERVICE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/** Режет хвост по кодпоинтам, не посреди суррогатной пары. */
export function clipModelText(text: string): { text: string; clipped: boolean } {
  let count = 0;
  let index = 0;
  while (index < text.length && count < MODEL_TOOL_TEXT_CHARS) {
    const code = text.codePointAt(index);
    index += code !== undefined && code > 0xffff ? 2 : 1;
    count += 1;
  }
  if (index >= text.length) {
    return { text, clipped: false };
  }
  return { text: text.slice(0, index), clipped: true };
}
