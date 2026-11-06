import type { Server } from "node:http";

import { errorCode, isMainModule, loadConfig, logger } from "../config.js";
import { type Sql, createSql } from "../db/client.js";
import { createApi } from "./app.js";
import { ApiConfigError } from "./errors.js";
import { API_LISTEN_HOST, API_LISTEN_PORT, startHttpServer } from "./server.js";

/**
 * Процесс API. SIGTERM дослушивает принятые запросы и закрывает пул.
 * Успешный статус запуска отсюда не ставится: просроченную аренду вернёт reaper.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.harnessApiToken.length === 0) {
    throw new ApiConfigError("api token is empty");
  }

  const sql = createSql(config.databaseUrl);
  const app = createApi({ sql, token: config.harnessApiToken });
  const server = startHttpServer(app, API_LISTEN_PORT);
  server.on("error", (error) => {
    logger.error({ err: error }, "http server error");
    process.exit(1);
  });

  let closing = false;
  const shutdown = (signal: "SIGINT" | "SIGTERM"): void => {
    if (closing) {
      return;
    }
    closing = true;
    logger.info({ signal }, "api shutting down");
    const force = setTimeout(() => {
      logger.error({ code: "shutdown_timeout" }, "api shutdown timed out");
      process.exit(1);
    }, 10_000);
    server.close((closeError) => {
      void finishShutdown(sql, closeError, force);
    });
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

  await waitListening(server);
  logger.info({ host: API_LISTEN_HOST, port: API_LISTEN_PORT }, "api listening");
}

async function finishShutdown(
  sql: Sql,
  closeError: Error | undefined,
  force: ReturnType<typeof setTimeout>,
): Promise<void> {
  clearTimeout(force);
  try {
    await sql.end({ timeout: 5 });
  } catch (endError) {
    logger.error({ err: endError }, "api database close failed");
    process.exit(1);
  }
  if (closeError) {
    logger.error({ err: closeError }, "api close failed");
    process.exit(1);
  }
  process.exit(0);
}

function waitListening(server: Server): Promise<void> {
  if (server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    server.once("listening", () => {
      resolve();
    });
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    logger.error({ code: errorCode(error) }, "api failed");
    process.exit(1);
  });
}
