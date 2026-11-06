/** Маркер вместо секрета. Сам по себе не должен снова попадать под шаблон. */
export const REDACTED = "[redacted]";

/**
 * Короче этого порога значение из списка не вырезается:
 * иначе короткий кусок окружения сотрёт обычный текст.
 */
const MIN_SECRET_LENGTH = 8;

/** Перед регулярным выражением текст режется до этого окна. */
const PATTERN_WINDOW = 2_000;

/**
 * Не короче самого длинного шаблона (цифры, двоеточие и до 200 символов токена),
 * чтобы ключ на границе окна не остался необрезанным хвостом.
 */
const PATTERN_OVERLAP = 230;

export interface RedactSecretsSource {
  databaseUrl: string;
  harnessTestDatabaseUrl?: string | null;
  litellmApiKey: string;
  harnessApiToken: string;
  telegramBotToken: string;
}

interface TextRange {
  start: number;
  end: number;
}

/**
 * Значения окружения для маскирования. process.env здесь не читается:
 * список собирает вызывающий из уже проверенной конфигурации.
 */
export function collectSecrets(source: RedactSecretsSource): readonly string[] {
  return normalizeSecrets([
    source.databaseUrl,
    source.harnessTestDatabaseUrl ?? "",
    source.litellmApiKey,
    source.harnessApiToken,
    source.telegramBotToken,
  ]);
}

/** Есть ли в тексте значение из списка секретов, а не только шаблон ключа. */
export function containsListedSecret(text: string, secrets: readonly string[]): boolean {
  for (const secret of normalizeSecrets(secrets)) {
    if (text.includes(secret)) {
      return true;
    }
  }
  return false;
}

/**
 * Маскирует секреты до журнала и до следующего хода модели.
 * Сначала буквальные значения списка, затем шаблоны Bearer, sk- и токена Telegram.
 */
export function redact(text: string, secrets: readonly string[]): string {
  return redactPatterns(replaceSecrets(text, secrets));
}

function replaceSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of normalizeSecrets(secrets)) {
    if (!result.includes(secret)) {
      continue;
    }
    result = result.split(secret).join(REDACTED);
  }
  return result;
}

function normalizeSecrets(secrets: readonly string[]): readonly string[] {
  const unique = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH || REDACTED.includes(secret)) {
      continue;
    }
    unique.add(secret);
  }
  return [...unique].sort((left, right) => right.length - left.length);
}

function redactPatterns(text: string): string {
  if (text.length === 0) {
    return text;
  }

  const ranges: TextRange[] = [];
  let offset = 0;
  while (offset < text.length) {
    const end = Math.min(text.length, offset + PATTERN_WINDOW);
    collectPatternRanges(text.slice(offset, end), offset, ranges);
    if (end === text.length) {
      break;
    }
    const next = end - PATTERN_OVERLAP;
    if (next <= offset) {
      break;
    }
    offset = next;
  }
  return applyRanges(text, ranges);
}

function collectPatternRanges(slice: string, offset: number, ranges: TextRange[]): void {
  for (const pattern of patternSources()) {
    for (const match of slice.matchAll(pattern)) {
      const local = match.index;
      if (local === undefined || match[0].length === 0) {
        continue;
      }
      ranges.push({
        start: offset + local,
        end: offset + local + match[0].length,
      });
    }
  }
}

/** Шаблоны литеральные, квантификатор на тексте не шире {1,200} и не голый. */
function patternSources(): readonly RegExp[] {
  return [/Bearer [!-~]{1,200}/g, /sk-[A-Za-z0-9_-]{1,200}/g, /\d{1,20}:[A-Za-z0-9_-]{30,200}/g];
}

function applyRanges(text: string, ranges: readonly TextRange[]): string {
  if (ranges.length === 0) {
    return text;
  }

  let cursor = 0;
  let result = "";
  for (const range of mergeRanges(ranges)) {
    if (range.end <= cursor) {
      continue;
    }
    const start = Math.max(range.start, cursor);
    result += text.slice(cursor, start);
    result += REDACTED;
    cursor = Math.min(range.end, text.length);
  }
  result += text.slice(cursor);
  return result;
}

function mergeRanges(ranges: readonly TextRange[]): TextRange[] {
  const sorted = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      if (range.end > last.end) {
        last.end = range.end;
      }
      continue;
    }
    merged.push({ start: range.start, end: range.end });
  }
  return merged;
}
