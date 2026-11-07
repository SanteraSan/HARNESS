import type { Sql } from "../db/client.js";
import { parseDecimalChatId } from "./chat-id.js";
import type { ChatModelAlias } from "./decide.js";
import { TelegramError } from "./errors.js";

/** M1 знает один арендатор. Строка выбора и запуск Telegram пишут одно и то же значение. */
const LOCAL_TENANT = "local";

/**
 * Выбор модели чата. Повтор команды обновляет ту же строку (tenant_id, chat_id).
 * Команда не создаёт запуск. chat_id остаётся bigint: Number() не вызывается.
 */
export async function saveChatModelChoice(
  sql: Sql,
  chatId: bigint,
  modelAlias: ChatModelAlias,
): Promise<void> {
  const chat = chatText(chatId);
  await sql`
    insert into chat_model_choices (
      tenant_id,
      chat_id,
      model_alias,
      updated_at
    ) values (
      ${LOCAL_TENANT},
      ${sql.types.chat_id(chat)},
      ${modelAlias},
      now()
    )
    on conflict (tenant_id, chat_id) do update
    set model_alias = excluded.model_alias,
        updated_at = now()
  `;
}

function chatText(chatId: bigint): string {
  if (typeof chatId !== "bigint") {
    throw new TelegramError("invalid_chat", "chat id is invalid");
  }
  const text = chatId.toString();
  if (parseDecimalChatId(text) !== chatId) {
    throw new TelegramError("invalid_chat", "chat id is invalid");
  }
  return text;
}
