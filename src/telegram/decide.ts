import type { RunStatus } from "../contracts/types.js";
import { canonicalUserId, decimalFromSafeInteger, parseDecimalChatId } from "./chat-id.js";
import { canonicalUpdateId, isUuid } from "./ids.js";

/** Тот же предел, что у payload.message. Длиннее очередь не примет. */
export const MESSAGE_LIMIT = 8000;

/** Опрос своего запуска. Срок — часы процесса, не аренда воркера. */
export const POLL_INTERVAL_MS = 2_000;
/** Дольше таймаута воркера, чтобы итог успел уйти в чат. */
export const POLL_LIMIT_MS = 11 * 60 * 1000;

const DENY_TEXT = "Нет доступа.";
const NEED_TEXT = "В этом срезе принимается только текст.";
export const INVALID_UPDATE_TEXT = "Сообщение не принято.";
const TOO_LONG_TEXT = "Сообщение длиннее 8000 символов.";
const LOCAL_COMMAND = "/local";
const CLOUD_COMMAND = "/cloud";
const LOCAL_MODEL_TEXT = "Этот чат спрашивает локальную модель.";
const CLOUD_MODEL_TEXT = "Этот чат спрашивает внешнюю модель.";

/** Алиас выбора чата. Это строка алиаса хода, не провайдер SDK. */
export type ChatModelAlias = "agent" | "coder-cloud";
const CANCELLED_TEXT = "Запуск отменён.";
const EMPTY_FINAL_TEXT = "Готово.";
const FAILED_PREFIX = "Запуск не выполнен. ";

export interface TelegramUpdateView {
  updateId: string;
  userId: string | null;
  chatId: string;
  content:
    { type: "none" } | { type: "empty" } | { type: "file" } | { type: "text"; message: string };
}

export type UpdateDecision =
  | { kind: "ignore" }
  | { kind: "deny"; text: string }
  | { kind: "need_text"; text: string }
  | {
      kind: "choose_model";
      modelAlias: ChatModelAlias;
      chatId: bigint;
      text: string;
    }
  | {
      kind: "enqueue";
      idempotencyKey: string;
      message: string;
      chatId: bigint;
    };

export interface IncomingParts {
  updateId: number;
  userId: number | null;
  chatId: number;
  /** undefined — поля text нет. Пустая строка — пустой текст. */
  text: string | undefined;
  hasFile: boolean;
}

/**
 * Числа grammY переводятся в десятичный текст.
 * Небезопасное целое не становится chat_id: младшие разряды уже потеряны.
 */
export function viewFromParts(parts: IncomingParts): TelegramUpdateView | null {
  const updateId = decimalFromSafeInteger(parts.updateId);
  const chatId = decimalFromSafeInteger(parts.chatId);
  if (updateId === null || chatId === null || canonicalUpdateId(updateId) === null) {
    return null;
  }
  const userId = parts.userId === null ? null : decimalFromSafeInteger(parts.userId);
  if (parts.userId !== null && userId === null) {
    return null;
  }
  return {
    updateId,
    userId,
    chatId,
    content: contentFrom(parts.text, parts.hasFile),
  };
}

/**
 * Решает, ставить ли запуск. Сеть и очередь здесь не вызываются.
 * Ключ идемпотентности: tg:{agentId}:{updateId}.
 * Отдельное сообщение /local или /cloud запуск не ставит: это выбор алиаса чата.
 */
export function decideUpdate(
  update: TelegramUpdateView,
  allowedUserIds: readonly string[],
  agentId: string,
): UpdateDecision {
  if (update.content.type === "none") {
    return { kind: "ignore" };
  }
  if (!isAllowed(update.userId, allowedUserIds)) {
    return { kind: "deny", text: DENY_TEXT };
  }

  const updateId = canonicalUpdateId(update.updateId);
  const chatId = parseDecimalChatId(update.chatId);
  if (updateId === null || chatId === null || !isUuid(agentId)) {
    return { kind: "deny", text: INVALID_UPDATE_TEXT };
  }
  if (update.content.type === "file" || update.content.type === "empty") {
    return { kind: "need_text", text: NEED_TEXT };
  }
  if (update.content.message.length > MESSAGE_LIMIT) {
    return { kind: "need_text", text: TOO_LONG_TEXT };
  }

  const choice = chatModelCommand(update.content.message);
  if (choice !== null) {
    return {
      kind: "choose_model",
      modelAlias: choice.modelAlias,
      chatId,
      text: choice.text,
    };
  }

  return {
    kind: "enqueue",
    idempotencyKey: `tg:${agentId}:${updateId}`,
    message: update.content.message,
    chatId,
  };
}

/** Точное сообщение команды. Текст с аргументом остаётся обычным запуском. */
function chatModelCommand(message: string): { modelAlias: ChatModelAlias; text: string } | null {
  if (message === LOCAL_COMMAND) {
    return { modelAlias: "agent", text: LOCAL_MODEL_TEXT };
  }
  if (message === CLOUD_COMMAND) {
    return { modelAlias: "coder-cloud", text: CLOUD_MODEL_TEXT };
  }
  return null;
}

export function replyForEnqueue(result: {
  runId: string;
  reason: "created" | "replay" | "dialog_busy";
}): string {
  if (result.reason === "created") {
    return `Запуск принят. ${result.runId}`;
  }
  if (result.reason === "replay") {
    return `Этот запуск уже есть. ${result.runId}`;
  }
  return `Новый запуск не создан. Живой запуск ${result.runId}.`;
}

/** Текст бота, когда сообщение легло в буфер за живым запуском. */
export function replyForBuffered(liveRunId: string): string {
  return `Сообщение сохранено. Поставлю его в очередь после запуска ${liveRunId}.`;
}

/** Буфер уже не пуст: новый текст встаёт в хвост и не обгоняет его. */
export const BUFFER_BEHIND_TEXT = "Сообщение сохранено. Оно встанет в очередь следом.";

export interface RunSnapshot {
  id: string;
  status: RunStatus;
  finalText: string | null;
  error: string | null;
}

export interface PollOutgoing {
  text: string | null;
  delivered: ReadonlySet<string>;
}

/**
 * Текст итога от записи запуска.
 * Повтор того же id в переданном множестве не даёт исходящего.
 * Эта функция базу не трогает: устойчивую отметку пишет prepareRunDelivery.
 */
export function pollOutgoing(run: RunSnapshot, delivered: ReadonlySet<string>): PollOutgoing {
  const text = outgoingText(run);
  if (text === null || delivered.has(run.id)) {
    return { text: null, delivered };
  }
  const next = new Set(delivered);
  next.add(run.id);
  return { text, delivered: next };
}

/** null, пока статус не конечный. Иначе текст, который ушёл бы в чат. */
export function outgoingText(run: RunSnapshot): string | null {
  if (!isTerminalStatus(run.status)) {
    return null;
  }
  return terminalText(run);
}

export interface PollStep {
  text: string | null;
  delivered: ReadonlySet<string>;
  keepWaiting: boolean;
}

/** Конечный статус или предел ожидания останавливают опрос. */
export function pollStep(
  run: RunSnapshot,
  delivered: ReadonlySet<string>,
  elapsedMs: number,
): PollStep {
  const outgoing = pollOutgoing(run, delivered);
  if (outgoing.text !== null) {
    return { text: outgoing.text, delivered: outgoing.delivered, keepWaiting: false };
  }
  if (isTerminalStatus(run.status) || elapsedMs >= POLL_LIMIT_MS) {
    return { text: null, delivered: outgoing.delivered, keepWaiting: false };
  }
  return { text: null, delivered, keepWaiting: true };
}

export interface LooseMessage {
  text?: string;
  from?: { id: number };
  chat: { id: number };
  document?: unknown;
  sticker?: unknown;
  photo?: unknown;
  video?: unknown;
  audio?: unknown;
  voice?: unknown;
  video_note?: unknown;
  animation?: unknown;
  contact?: unknown;
  location?: unknown;
  venue?: unknown;
  poll?: unknown;
  dice?: unknown;
}

/** Поле text есть только у текстового сообщения. Подпись к файлу текстом не считается. */
export function partsFromMessage(updateId: number, message: LooseMessage): IncomingParts {
  return {
    updateId,
    userId: message.from === undefined ? null : message.from.id,
    chatId: message.chat.id,
    text: message.text,
    hasFile: hasAttachment(message),
  };
}

function hasAttachment(message: LooseMessage): boolean {
  return (
    message.document !== undefined ||
    message.sticker !== undefined ||
    message.photo !== undefined ||
    message.video !== undefined ||
    message.audio !== undefined ||
    message.voice !== undefined ||
    message.video_note !== undefined ||
    message.animation !== undefined ||
    message.contact !== undefined ||
    message.location !== undefined ||
    message.venue !== undefined ||
    message.poll !== undefined ||
    message.dice !== undefined
  );
}

function contentFrom(text: string | undefined, hasFile: boolean): TelegramUpdateView["content"] {
  if (hasFile) {
    return { type: "file" };
  }
  if (text === undefined) {
    return { type: "none" };
  }
  const message = text.trim();
  if (message.length === 0) {
    return { type: "empty" };
  }
  return { type: "text", message };
}

function isAllowed(userId: string | null, allowedUserIds: readonly string[]): boolean {
  if (userId === null) {
    return false;
  }
  const canonical = canonicalUserId(userId);
  if (canonical === null) {
    return false;
  }
  for (const entry of allowedUserIds) {
    if (canonicalUserId(entry) === canonical) {
      return true;
    }
  }
  return false;
}

export function isTerminalStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function terminalText(run: RunSnapshot): string {
  if (run.status === "succeeded") {
    if (run.finalText === null || run.finalText.length === 0) {
      return EMPTY_FINAL_TEXT;
    }
    return run.finalText;
  }
  if (run.status === "failed") {
    return FAILED_PREFIX + shortError(run.error);
  }
  return CANCELLED_TEXT;
}

/** В чат уходит первая строка error. Кадр стека со второй строки не копируется. */
function shortError(error: string | null): string {
  if (error === null) {
    return "unknown";
  }
  const lineBreak = indexOfLineBreak(error);
  const line = (lineBreak === -1 ? error : error.slice(0, lineBreak)).trim();
  if (line.length === 0 || line.startsWith("at ")) {
    return "unknown";
  }
  const limit = 200;
  return line.length > limit ? line.slice(0, limit) : line;
}

function indexOfLineBreak(value: string): number {
  const newline = value.indexOf("\n");
  const carriage = value.indexOf("\r");
  if (newline === -1) {
    return carriage;
  }
  if (carriage === -1) {
    return newline;
  }
  return newline < carriage ? newline : carriage;
}
