import type { Sql } from "../db/client.js";
import type { NewRunStep } from "../contracts/types.js";
import { redact } from "../model/redact.js";

/** Выдержка в журнале — не длиннее 2000 символов Unicode (кодпоинтов). */
const EXCERPT_LIMIT = 2000;

export class JournalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JournalError";
    this.code = code;
  }
}

/** Тот же вызов, что у раннера: шаг без индекса, индекс назначает журнал. */
export interface RunJournal {
  appendStep(step: NewRunStep): Promise<void>;
}

export function createRunJournal(sql: Sql, secrets: readonly string[]): RunJournal {
  const listedSecrets = [...secrets];
  return {
    appendStep(step: NewRunStep): Promise<void> {
      return insertStep(sql, listedSecrets, step);
    },
  };
}

/**
 * Следующий step_index — max + 1 в одной транзакции.
 * FOR UPDATE нельзя совместить с агрегатом, поэтому строки run_steps этого
 * run_id блокируются отдельным запросом. Пустой набор не блокируется, и два
 * соединения взяли бы индекс 0. Сначала блокируется строка runs этого run_id.
 */
async function insertStep(sql: Sql, secrets: readonly string[], step: NewRunStep): Promise<void> {
  const requestExcerpt = excerptForStore(step.requestExcerpt, secrets);
  const responseExcerpt = excerptForStore(step.responseExcerpt, secrets);

  await sql.begin(async (tx) => {
    const runs = await tx<{ id: string }[]>`
      select id
      from runs
      where id = ${step.runId}
      for update
    `;
    if (runs.length === 0) {
      throw new JournalError("run_not_found", "run does not exist");
    }

    await tx`
      select step_index
      from run_steps
      where run_id = ${step.runId}
      for update
    `;

    const indexes = await tx<{ step_index: number }[]>`
      select coalesce(max(step_index), -1) + 1 as step_index
      from run_steps
      where run_id = ${step.runId}
    `;
    const stepIndex = requireStepIndex(indexes[0]);

    await tx`
      insert into run_steps (
        run_id,
        step_index,
        kind,
        tool_name,
        request_excerpt,
        response_excerpt,
        prompt_tokens,
        completion_tokens,
        error
      ) values (
        ${step.runId},
        ${stepIndex},
        ${step.kind},
        ${step.toolName},
        ${requestExcerpt},
        ${responseExcerpt},
        ${step.promptTokens},
        ${step.completionTokens},
        ${step.error}
      )
    `;
  });
}

/**
 * Сначала redact, потом обрезка до 2000 кодпоинтов.
 * Иначе секрет на границе окна остаётся в журнале префиксом.
 */
function excerptForStore(value: string | null, secrets: readonly string[]): string | null {
  if (value === null) {
    return null;
  }
  return truncateUnicode(redact(value, secrets), EXCERPT_LIMIT);
}

function truncateUnicode(text: string, limit: number): string {
  let count = 0;
  let units = 0;
  for (const character of text) {
    if (count === limit) {
      return text.slice(0, units);
    }
    count += 1;
    units += character.length;
  }
  return text;
}

function requireStepIndex(row: { step_index: number } | undefined): number {
  const value = row?.step_index;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new JournalError("step_index_invalid", "step index was not assigned");
  }
  return value;
}
