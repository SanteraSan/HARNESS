import { Hono } from "hono";

import { logger } from "../config.js";
import type { RunQueue } from "../contracts/types.js";
import type { Sql } from "../db/client.js";
import { createRunQueue } from "../queue/index.js";
import { bearerMatches } from "./auth.js";
import { readCreateRunInput } from "./body.js";
import { ApiError, clientFailure } from "./errors.js";
import { findLocalAgentId, readRunWithSteps } from "./read-run.js";

interface ApiVariables {
  runId: string | undefined;
}

type ApiEnv = {
  Variables: ApiVariables;
};

export interface CreateApiOptions {
  sql: Sql;
  token: string;
  queue?: RunQueue;
}

/** HTTP M1. Модель отсюда не вызывается: постановка идёт в уже собранную очередь. */
export function createApi(options: CreateApiOptions): Hono<ApiEnv> {
  const queue = options.queue ?? createRunQueue(options.sql);
  const app = new Hono<ApiEnv>();

  app.use("*", async (c, next) => {
    c.set("runId", undefined);
    c.header("X-Content-Type-Options", "nosniff");
    if (!isPublicHealth(c.req.method, c.req.path)) {
      const header = c.req.raw.headers.get("authorization") ?? undefined;
      if (!bearerMatches(options.token, header)) {
        throw new ApiError("unauthorized");
      }
    }
    await next();
  });

  app.get("/health", (c) => {
    c.header("X-Content-Type-Options", "nosniff");
    return c.json({ ok: true });
  });

  app.post("/v1/runs", async (c) => {
    const input = await readCreateRunInput(c.req.raw);
    const agentId = await findLocalAgentId(options.sql, input.agentSlug);
    if (agentId === null) {
      throw new ApiError("unknown_agent");
    }

    const result = await queue.enqueue({
      tenantId: "local",
      agentId,
      source: "api",
      idempotencyKey: input.idempotencyKey,
      message: input.message,
      chatId: input.chatId,
    });
    c.set("runId", result.run.id);
    logger.info({ run_id: result.run.id, reason: result.reason }, "enqueue finished");

    const body = {
      id: result.run.id,
      reason: result.reason,
      status: result.run.status,
    };
    c.header("X-Content-Type-Options", "nosniff");
    if (result.reason === "created") {
      return c.json(body, 201);
    }
    if (result.reason === "replay") {
      return c.json(body, 200);
    }
    return c.json(body, 409);
  });

  app.get("/v1/runs/:id", async (c) => {
    const runId = parseRunId(c.req.param("id"));
    c.set("runId", runId);
    const view = await readRunWithSteps(options.sql, runId);
    if (view === null) {
      throw new ApiError("not_found");
    }
    c.header("X-Content-Type-Options", "nosniff");
    return c.json(view);
  });

  app.notFound((c) => {
    c.header("X-Content-Type-Options", "nosniff");
    return c.json({ reason: "not_found" }, 404);
  });

  app.onError((error, c) => {
    const failure = clientFailure(error);
    const runId = c.get("runId");
    if (failure.status >= 500) {
      logger.error(
        { err: error, reason: failure.reason, ...(runId === undefined ? {} : { run_id: runId }) },
        "api request failed",
      );
    }
    c.header("X-Content-Type-Options", "nosniff");
    return c.json({ reason: failure.reason }, failure.status);
  });

  return app;
}

function isPublicHealth(method: string, path: string): boolean {
  return method === "GET" && path === "/health";
}

/** Идентификатор запуска — uuid. Длину проверяем до посимвольного разбора. */
function parseRunId(value: string | undefined): string {
  if (value === undefined || !isUuid(value)) {
    throw new ApiError("invalid_id");
  }
  return value;
}

function isUuid(value: string): boolean {
  if (value.length !== 36) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const dash = index === 8 || index === 13 || index === 18 || index === 23;
    if (dash) {
      if (code !== 45) {
        return false;
      }
      continue;
    }
    const hex =
      (code >= 48 && code <= 57) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
    if (!hex) {
      return false;
    }
  }
  return true;
}
