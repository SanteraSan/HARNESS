import type { EnqueueInput } from "../contracts/types.js";
import { decideUpdate, replyForEnqueue, type TelegramUpdateView } from "./decide.js";

export interface TelegramEnqueueResult {
  runId: string;
  reason: "created" | "replay" | "dialog_busy";
}

export type TelegramEnqueue = (input: EnqueueInput) => Promise<TelegramEnqueueResult>;

export interface HandleResult {
  text: string | null;
  followRunId: string | null;
  chatId: string | null;
}

/** M1 знает один арендатор. Постановка Telegram всегда source = telegram. */
const LOCAL_TENANT = "local";

/**
 * Чистая ветка решает отказ, просьбу прислать текст или параметры enqueue.
 * Очередь вызывается только в ветке enqueue. Модель отсюда не вызывается.
 */
export async function handleTelegramUpdate(
  update: TelegramUpdateView,
  options: {
    allowedUserIds: readonly string[];
    agentId: string;
    enqueue: TelegramEnqueue;
  },
): Promise<HandleResult> {
  const decision = decideUpdate(update, options.allowedUserIds, options.agentId);
  if (decision.kind === "ignore") {
    return { text: null, followRunId: null, chatId: null };
  }
  if (decision.kind === "deny" || decision.kind === "need_text") {
    return { text: decision.text, followRunId: null, chatId: null };
  }

  const queued = await options.enqueue({
    tenantId: LOCAL_TENANT,
    agentId: options.agentId,
    source: "telegram",
    idempotencyKey: decision.idempotencyKey,
    message: decision.message,
    chatId: decision.chatId,
  });
  return {
    text: replyForEnqueue(queued),
    followRunId: queued.runId,
    chatId: update.chatId,
  };
}
