import { logger } from "../config.js";
import { POLL_INTERVAL_MS, POLL_LIMIT_MS, pollStep, type RunSnapshot } from "./decide.js";
import { TelegramError } from "./errors.js";

export interface DeliveryMemory {
  sent: ReadonlySet<string>;
}

export interface FollowDeps {
  readRun: (runId: string) => Promise<RunSnapshot | null>;
  send: (chatId: string, text: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  isStopped: () => boolean;
  delivery: DeliveryMemory;
}

/**
 * Читает один запуск короткими запросами и отпускает соединение на время сна.
 * Модель этот процесс не вызывает.
 * Id итога записывается до send: повторный опрос того же запуска исходящего не даёт.
 * Отметка доставки в базу не пишется.
 */
export async function followRun(runId: string, chatId: string, deps: FollowDeps): Promise<void> {
  const started = deps.now();
  while (!deps.isStopped()) {
    let run: RunSnapshot | null;
    try {
      run = await deps.readRun(runId);
    } catch (error) {
      logger.error({ err: error, run_id: runId }, "telegram poll read failed");
      if (
        error instanceof TelegramError ||
        deps.isStopped() ||
        deps.now() - started >= POLL_LIMIT_MS
      ) {
        return;
      }
      await deps.sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (deps.isStopped()) {
      return;
    }
    if (run === null) {
      logger.info({ run_id: runId }, "telegram run missing");
      return;
    }

    const step = pollStep(run, deps.delivery.sent, deps.now() - started);
    if (step.text !== null) {
      deps.delivery.sent = step.delivered;
      try {
        await deps.send(chatId, step.text);
      } catch (error) {
        logger.error({ err: error, run_id: runId }, "telegram send failed");
      }
      return;
    }

    deps.delivery.sent = step.delivered;
    if (!step.keepWaiting || deps.isStopped()) {
      return;
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
}
