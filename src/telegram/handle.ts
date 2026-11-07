import { logger } from "../config.js";
import type { EnqueueInput } from "../contracts/types.js";
import type { DialogMessage } from "./buffer.js";
import {
  BUFFER_BEHIND_TEXT,
  decideUpdate,
  replyForBuffered,
  replyForEnqueue,
  type ChatModelAlias,
  type TelegramUpdateView,
} from "./decide.js";

/** M1 знает один арендатор. Постановка Telegram всегда source = telegram. */
const LOCAL_TENANT = "local";

export interface TelegramEnqueueResult {
  runId: string;
  reason: "created" | "replay" | "dialog_busy";
}

export type TelegramEnqueue = (input: EnqueueInput) => Promise<TelegramEnqueueResult>;

export interface HandleResult {
  text: string | null;
  followRunId: string | null;
  chatId: string | null;
  /**
   * Буфер уже держал хвост, а чат мог освободиться.
   * Процесс ставит самое старое сообщение, не текущее.
   */
  wakeBuffer: boolean;
}

/**
 * Ветка решает отказ, просьбу прислать текст, выбор модели или параметры enqueue.
 * Очередь вызывается в ветке enqueue. Модель отсюда не вызывается.
 * /local и /cloud отвечают текстом процесса и запуск не создают.
 * rememberBusy есть только у бота. Без него фраза прежняя: живой запуск и то, что новый не создан.
 * HTTP в этот модуль не заходит и по-прежнему получает 409 dialog_busy.
 */
export async function handleTelegramUpdate(
  update: TelegramUpdateView,
  options: {
    allowedUserIds: readonly string[];
    agentId: string;
    enqueue: TelegramEnqueue;
    rememberBusy?: (message: DialogMessage) => Promise<void>;
    hasPendingBuffer?: (agentId: string, chatId: bigint) => Promise<boolean>;
    findExistingRun?: (agentId: string, idempotencyKey: string) => Promise<string | null>;
    saveChatModel?: (chatId: bigint, modelAlias: ChatModelAlias) => Promise<void>;
  },
): Promise<HandleResult> {
  const decision = decideUpdate(update, options.allowedUserIds, options.agentId);
  if (decision.kind === "ignore") {
    return { text: null, followRunId: null, chatId: null, wakeBuffer: false };
  }
  if (decision.kind === "deny" || decision.kind === "need_text") {
    return { text: decision.text, followRunId: null, chatId: null, wakeBuffer: false };
  }
  if (decision.kind === "choose_model") {
    const save = options.saveChatModel;
    if (save !== undefined) {
      await save(decision.chatId, decision.modelAlias);
    }
    return { text: decision.text, followRunId: null, chatId: null, wakeBuffer: false };
  }

  const remembered = options.rememberBusy;
  const pending = options.hasPendingBuffer;
  const existingRun = options.findExistingRun;
  if (remembered !== undefined && pending !== undefined && existingRun !== undefined) {
    const existingId = await existingRun(options.agentId, decision.idempotencyKey);
    if (existingId !== null) {
      return {
        text: replyForEnqueue({ runId: existingId, reason: "replay" }),
        followRunId: existingId,
        chatId: update.chatId,
        wakeBuffer: false,
      };
    }
    if (await pending(options.agentId, decision.chatId)) {
      await remembered(busyMessage(decision, options.agentId));
      return {
        text: BUFFER_BEHIND_TEXT,
        followRunId: null,
        chatId: update.chatId,
        wakeBuffer: true,
      };
    }
  }

  const queued = await options.enqueue({
    tenantId: LOCAL_TENANT,
    agentId: options.agentId,
    source: "telegram",
    idempotencyKey: decision.idempotencyKey,
    message: decision.message,
    chatId: decision.chatId,
  });
  if (queued.reason === "dialog_busy" && remembered !== undefined) {
    await remembered(busyMessage(decision, options.agentId));
    logger.info({ run_id: queued.runId }, "telegram message buffered");
    return {
      text: replyForBuffered(queued.runId),
      followRunId: queued.runId,
      chatId: update.chatId,
      wakeBuffer: false,
    };
  }
  return {
    text: replyForEnqueue(queued),
    followRunId: queued.runId,
    chatId: update.chatId,
    wakeBuffer: false,
  };
}

function busyMessage(
  decision: { idempotencyKey: string; message: string; chatId: bigint },
  agentId: string,
): DialogMessage {
  return {
    tenantId: LOCAL_TENANT,
    agentId,
    chatId: decision.chatId,
    idempotencyKey: decision.idempotencyKey,
    message: decision.message,
  };
}
