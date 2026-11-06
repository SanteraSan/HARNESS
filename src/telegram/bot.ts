import { Bot, type Context } from "grammy";

import { logger } from "../config.js";
import { decimalFromSafeInteger } from "./chat-id.js";
import {
  INVALID_UPDATE_TEXT,
  partsFromMessage,
  viewFromParts,
  type RunSnapshot,
} from "./decide.js";
import { followRun, type DeliveryMemory } from "./follow.js";
import { handleTelegramUpdate, type HandleResult, type TelegramEnqueue } from "./handle.js";

/** Лимит одного сообщения Bot API. Длинный итог уходит несколькими частями. */
const TELEGRAM_MESSAGE_LIMIT = 4096;

const ENQUEUE_FAILED_TEXT = "Не удалось принять сообщение.";

export interface TelegramBotOptions {
  token: string;
  allowedUserIds: readonly string[];
  agentId: string;
  enqueue: TelegramEnqueue;
  readRun: (runId: string) => Promise<RunSnapshot | null>;
  delivery: DeliveryMemory;
  isStopped: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  track: (task: Promise<void>) => void;
  fetch?: typeof fetch;
}

/** grammY только переводит апдейт в чистую функцию и отправляет уже готовый текст. */
export function createTelegramBot(options: TelegramBotOptions): Bot {
  const bot = new Bot(
    options.token,
    options.fetch === undefined ? undefined : { client: { fetch: options.fetch } },
  );
  bot.catch((botError) => {
    logger.error({ err: botError.error }, "telegram update failed");
  });
  bot.on("message", async (ctx) => {
    await onMessage(ctx, options);
  });
  return bot;
}

async function onMessage(ctx: Context, options: TelegramBotOptions): Promise<void> {
  const message = ctx.message;
  if (message === undefined) {
    return;
  }
  // Небезопасный chat id уже искажён JSON-числом. В такой чат не отвечаем и не ставим запуск.
  const chatId = decimalFromSafeInteger(message.chat.id);
  if (chatId === null) {
    return;
  }
  const view = viewFromParts(partsFromMessage(ctx.update.update_id, message));
  if (view === null) {
    await sendPlainText(ctx.api, chatId, INVALID_UPDATE_TEXT);
    return;
  }

  let result: HandleResult;
  try {
    result = await handleTelegramUpdate(view, options);
  } catch (error) {
    logger.error({ err: error }, "telegram enqueue failed");
    await sendPlainText(ctx.api, chatId, ENQUEUE_FAILED_TEXT);
    return;
  }

  if (result.followRunId !== null && result.chatId !== null && !options.isStopped()) {
    const runId = result.followRunId;
    const chatId = result.chatId;
    const api = ctx.api;
    const task = followRun(runId, chatId, {
      readRun: options.readRun,
      send: async (target, text) => {
        await sendPlainText(api, target, text);
      },
      sleep: options.sleep,
      now: options.now,
      isStopped: options.isStopped,
      delivery: options.delivery,
    }).catch((error: unknown) => {
      logger.error({ err: error, run_id: runId }, "telegram poll failed");
    });
    options.track(task);
  }

  if (result.followRunId !== null) {
    logger.info({ run_id: result.followRunId }, "telegram update handled");
  }
  if (result.text !== null) {
    await sendPlainText(ctx.api, view.chatId, result.text);
  }
}

/** parse_mode не задаётся: текст запуска не разбирается как разметка. */
async function sendPlainText(api: Context["api"], chatId: string, text: string): Promise<void> {
  if (text.length === 0) {
    return;
  }
  let offset = 0;
  while (offset < text.length) {
    const part = text.slice(offset, offset + TELEGRAM_MESSAGE_LIMIT);
    await api.sendMessage(chatId, part);
    offset += TELEGRAM_MESSAGE_LIMIT;
  }
}
