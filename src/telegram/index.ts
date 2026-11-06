import { errorCode, isMainModule, loadConfig, logger } from "../config.js";
import { createSql, type Sql } from "../db/client.js";
import { createRunQueue } from "../queue/index.js";
import { createTelegramBot } from "./bot.js";
import { TelegramError } from "./errors.js";
import type { DeliveryMemory } from "./follow.js";
import { findLocalAgentId, readRunSnapshot } from "./read-run.js";

/**
 * Процесс Telegram только ставит запуск и потом читает статус.
 * Модель вызывает воркер. Успешный статус отсюда не пишется:
 * на SIGTERM опрос обрывается, аренду снимет reaper.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.telegramBotToken.length === 0) {
    throw new TelegramError("config_invalid", "telegram bot token is empty");
  }

  const sql = createSql(config.databaseUrl);
  let poolEnded: Promise<void> | null = null;
  const endPool = (): Promise<void> => {
    if (poolEnded === null) {
      poolEnded = sql.end({ timeout: 5 }).then(() => undefined);
    }
    return poolEnded;
  };

  try {
    await serve(
      sql,
      config.telegramBotToken,
      config.telegramAllowedUserIds,
      config.agentSlug,
      endPool,
    );
  } catch (error) {
    await endPool();
    throw error;
  }
}

async function serve(
  sql: Sql,
  token: string,
  allowedUserIds: readonly string[],
  agentSlug: string,
  endPool: () => Promise<void>,
): Promise<void> {
  const agentId = await findLocalAgentId(sql, agentSlug);
  const queue = createRunQueue(sql);
  const delivery: DeliveryMemory = { sent: new Set() };
  const abort = new AbortController();
  const follows = new Set<Promise<void>>();
  let stopping = false;

  const bot = createTelegramBot({
    token,
    allowedUserIds,
    agentId,
    enqueue: async (input) => {
      const result = await queue.enqueue(input);
      return { runId: result.run.id, reason: result.reason };
    },
    readRun: (runId) => readRunSnapshot(sql, runId),
    delivery,
    isStopped: () => abort.signal.aborted,
    sleep: (ms) => sleepFor(ms, abort.signal),
    now: () => Date.now(),
    track: (task) => {
      follows.add(task);
      void task.finally(() => {
        follows.delete(task);
      });
    },
  });

  const shutdown = (signal: "SIGINT" | "SIGTERM"): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    abort.abort();
    logger.info({ signal }, "telegram shutting down");
    const force = setTimeout(() => {
      logger.error({ code: "shutdown_timeout" }, "telegram shutdown timed out");
      process.exit(1);
    }, 10_000);
    void closeTelegram(force);
  };

  const closeTelegram = async (force: ReturnType<typeof setTimeout>): Promise<void> => {
    try {
      if (bot.isRunning()) {
        await bot.stop();
      }
      while (follows.size > 0) {
        await Promise.all([...follows]);
      }
      await endPool();
      clearTimeout(force);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "telegram shutdown failed");
      process.exit(1);
    }
  };

  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("uncaughtException", (error) => {
    logger.error({ err: error }, "uncaught exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error({ err: reason }, "unhandled rejection");
    process.exit(1);
  });

  try {
    await bot.start({
      allowed_updates: ["message"],
      onStart(info) {
        logger.info({ username: info.username }, "telegram polling started");
      },
    });
  } finally {
    if (!stopping) {
      await endPool();
    }
  }
}

/** Срок опроса, не идентификатор. Abort обрывает сон на SIGTERM, не помечая запуск succeeded. */
function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      finish();
    };
    let settled = false;
    function finish(): void {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    logger.error({ code: errorCode(error) }, "telegram failed");
    process.exit(1);
  });
}
