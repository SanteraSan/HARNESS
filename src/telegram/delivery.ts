import type { Sql } from "../db/client.js";
import { isTerminalStatus, outgoingText, type RunSnapshot } from "./decide.js";
import { TelegramError } from "./errors.js";
import { isUuid } from "./ids.js";

export interface DeliveryPreparation {
  /** true — запуск ещё не конечный, отметку не пишем. */
  pending: boolean;
  text: string | null;
}

/**
 * Вставка строки и есть подготовка итога.
 * Конфликт по run_id — этот итог уже готовили, в том числе до рестарта процесса.
 * Текст собирается только если вставка прошла: повтор не готовит его второй раз.
 * Отметка пишется до отправки.
 */
export async function prepareRunDelivery(
  sql: Sql,
  run: RunSnapshot,
): Promise<DeliveryPreparation> {
  if (!isTerminalStatus(run.status)) {
    return { pending: true, text: null };
  }
  if (!isUuid(run.id)) {
    throw new TelegramError("invalid_run_row", "run id is invalid");
  }
  const inserted = await sql<{ run_id: string }[]>`
    insert into run_deliveries (run_id)
    values (${run.id})
    on conflict (run_id) do nothing
    returning run_id
  `;
  if (inserted.length === 0) {
    return { pending: false, text: null };
  }
  const text = outgoingText(run);
  if (text === null) {
    return { pending: false, text: null };
  }
  return { pending: false, text };
}
