import { logger } from "../config.js";
import { POLL_INTERVAL_MS, POLL_LIMIT_MS, pollStep, type RunSnapshot } from "./decide.js";
import type { DeliveryPreparation } from "./delivery.js";
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
  /**
   * Устойчивая отметка. Нет функции — остаётся множество в памяти процесса,
   * его хватает только до рестарта.
   */
  prepareDelivery?: (run: RunSnapshot) => Promise<DeliveryPreparation>;
  /** После конечного статуса: поставить одно сообщение из буфера этого чата. */
  onSettled?: (run: RunSnapshot) => Promise<void>;
}

/**
 * Читает один запуск короткими запросами и отпускает соединение на время сна.
 * Модель этот процесс не вызывает.
 * prepareDelivery пишет отметку до send. Повтор того же итога текст не готовит.
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

    if (deps.prepareDelivery !== undefined) {
      if (deps.delivery.sent.has(run.id)) {
        return;
      }
      const prepared = await deps.prepareDelivery(run);
      if (!prepared.pending) {
        const next = new Set(deps.delivery.sent);
        next.add(run.id);
        deps.delivery.sent = next;
        if (prepared.text !== null) {
          try {
            await deps.send(chatId, prepared.text);
          } catch (error) {
            logger.error({ err: error, run_id: runId }, "telegram send failed");
          }
        }
        await settle(run, deps);
        return;
      }
    }

    const step = pollStep(run, deps.delivery.sent, deps.now() - started);
    if (step.text !== null) {
      deps.delivery.sent = step.delivered;
      try {
        await deps.send(chatId, step.text);
      } catch (error) {
        logger.error({ err: error, run_id: runId }, "telegram send failed");
      }
      await settle(run, deps);
      return;
    }

    deps.delivery.sent = step.delivered;
    if (!step.keepWaiting || deps.isStopped()) {
      return;
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

async function settle(run: RunSnapshot, deps: FollowDeps): Promise<void> {
  if (deps.onSettled === undefined) {
    return;
  }
  try {
    await deps.onSettled(run);
  } catch (error) {
    logger.error({ err: error, run_id: run.id }, "telegram buffer release failed");
  }
}
