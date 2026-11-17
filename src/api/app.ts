import { Hono } from "hono";

import { logger } from "../config.js";
import type { RunQueue } from "../contracts/types.js";
import type { Sql } from "../db/client.js";
import { createRunQueue } from "../queue/index.js";
import {
  listAdminAgents,
  listAdminCrons,
  listAdminRuns,
  listAdminSteps,
  readWebAsset,
} from "./admin.js";
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
  /** Пустая строка не открывает JSON. Старые вызовы могут поле не передавать. */
  adminToken?: string;
  queue?: RunQueue;
}

/** HTTP M1. Модель отсюда не вызывается: постановка идёт в уже собранную очередь. */
export function createApi(options: CreateApiOptions): Hono<ApiEnv> {
  const queue = options.queue ?? createRunQueue(options.sql);
  const adminToken = options.adminToken ?? "";
  const app = new Hono<ApiEnv>();

  app.use("*", async (c, next) => {
    c.set("runId", undefined);
    c.header("X-Content-Type-Options", "nosniff");
    if (!isPublicRoute(c.req.method, c.req.path)) {
      const header = c.req.raw.headers.get("authorization") ?? undefined;
      // JSON админки сравнивает свой токен. Токен API эти пути не открывает.
      const expected = isAdminApi(c.req.path) ? adminToken : options.token;
      if (!bearerMatches(expected, header)) {
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

  app.get("/admin", () => serveAdminAsset("index.html"));
  app.get("/admin/*", (c) => serveAdminAsset(adminRelativePath(c.req.path)));

  app.get("/v1/admin/runs", async (c) => {
    const runs = await listAdminRuns(options.sql);
    c.header("X-Content-Type-Options", "nosniff");
    return c.json({ runs });
  });

  app.get("/v1/admin/runs/:id/steps", async (c) => {
    const runId = parseRunId(c.req.param("id"));
    const steps = await listAdminSteps(options.sql, runId);
    if (steps === null) {
      throw new ApiError("not_found");
    }
    c.header("X-Content-Type-Options", "nosniff");
    return c.json({ steps });
  });

  app.get("/v1/admin/agents", async (c) => {
    const agents = await listAdminAgents(options.sql);
    c.header("X-Content-Type-Options", "nosniff");
    return c.json({ agents });
  });

  app.get("/v1/admin/crons", async (c) => {
    const crons = await listAdminCrons(options.sql);
    c.header("X-Content-Type-Options", "nosniff");
    return c.json({ crons });
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

function isPublicRoute(method: string, requestPath: string): boolean {
  if (method !== "GET") {
    return false;
  }
  return requestPath === "/health" || isAdminPage(requestPath);
}

function isAdminPage(requestPath: string): boolean {
  return requestPath === "/admin" || requestPath.startsWith("/admin/");
}

function isAdminApi(requestPath: string): boolean {
  return requestPath === "/v1/admin" || requestPath.startsWith("/v1/admin/");
}

function adminRelativePath(requestPath: string): string {
  const prefix = "/admin/";
  if (!requestPath.startsWith(prefix)) {
    return "";
  }
  const relative = requestPath.slice(prefix.length);
  return relative.length === 0 ? "index.html" : relative;
}

async function serveAdminAsset(userPath: string): Promise<Response> {
  const asset = await readWebAsset(userPath);
  if (asset === null) {
    throw new ApiError("not_found");
  }
  return new Response(asset.body, {
    status: 200,
    headers: {
      "content-type": asset.mediaType,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
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
