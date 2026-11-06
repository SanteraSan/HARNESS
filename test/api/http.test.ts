import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { createApi } from "../../src/api/app.js";
import { ApiConfigError } from "../../src/api/errors.js";
import { API_LISTEN_HOST, startHttpServer } from "../../src/api/server.js";
import { loadConfig } from "../../src/config.js";
import type { RunQueue } from "../../src/contracts/types.js";
import { sql } from "../helpers/db.js";

const TOKEN = "test-secret-value";
const BODY_LIMIT_BYTES = 32 * 1024;

const config = loadConfig();
const secretMarkers = [config.databaseUrl, TOKEN];
if (config.harnessTestDatabaseUrl !== null && config.harnessTestDatabaseUrl.length > 0) {
  secretMarkers.push(config.harnessTestDatabaseUrl);
}

const app = createApi({ sql, token: TOKEN });

interface HttpApp {
  request(input: string, init?: RequestInit): Promise<Response> | Response;
}

describe("createApi", () => {
  it("должен без токена отвергнуть POST и открыть GET /health", async () => {
    const denied = await send(app, "/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_slug: "clerk",
        idempotency_key: "no-token",
        message: "привет",
      }),
    });
    expect(denied.status).toBe(401);
    expect(await readObject(denied)).toEqual({ reason: "unauthorized" });
    expect(await countRuns()).toBe(0);

    const health = await send(app, "/health");
    expect(health.status).toBe(200);
    expect(await readObject(health)).toEqual({ ok: true });

    const healthWithBadToken = await send(app, "/health", {
      headers: { authorization: "Bearer test-secret-valuX" },
    });
    expect(healthWithBadToken.status).toBe(200);
    expect(await readObject(healthWithBadToken)).toEqual({ ok: true });
  });

  it("должен отвергнуть неверный токен", async () => {
    const sameLength = await send(app, "/v1/runs", postInit("Bearer test-secret-valuX", "{}"));
    expect(sameLength.status).toBe(401);
    expect(await readObject(sameLength)).toEqual({ reason: "unauthorized" });

    const shorter = await send(app, "/v1/runs", postInit("Bearer no", "{}"));
    expect(shorter.status).toBe(401);

    const missingScheme = await send(app, "/v1/runs", postInit(TOKEN, "{}"));
    expect(missingScheme.status).toBe(401);

    const wrongScheme = await send(app, "/v1/runs", postInit(`bearer ${TOKEN}`, "{}"));
    expect(wrongScheme.status).toBe(401);
    expect(await countRuns()).toBe(0);
  });

  it("должен не авторизовать пустой токен", async () => {
    const open = createApi({ sql, token: "" });
    const health = await send(open, "/health");
    expect(health.status).toBe(200);
    expect(await readObject(health)).toEqual({ ok: true });

    const denied = await send(
      open,
      "/v1/runs",
      postInit("Bearer ", JSON.stringify(runBody("empty-token", "x"))),
    );
    expect(denied.status).toBe(401);
    expect(await readObject(denied)).toEqual({ reason: "unauthorized" });
    expect(await countRuns()).toBe(0);
  });

  it("должен поставить запуск в статус queued", async () => {
    const key = "key'); delete from runs; --";
    const message = "первый'; drop table runs; --";
    const response = await postRuns({
      agent_slug: "clerk",
      idempotency_key: key,
      message,
    });
    expect(response.status).toBe(201);
    const payload = await readObject(response);
    expect(payload.reason).toBe("created");
    expect(payload.status).toBe("queued");
    const id = requiredString(payload.id);

    const stored = await sql<{ status: string; idempotency_key: string; payload: unknown }[]>`
      select status, idempotency_key, payload
      from runs
      where id = ${id}
    `;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe("queued");
    expect(stored[0]?.idempotency_key).toBe(key);
    expect(stored[0]?.payload).toEqual({ message });
    expect(await countRuns()).toBe(1);
  });

  it("должен при повторе ключа вернуть 200 и тот же id", async () => {
    const first = await postRuns(runBody("same-key", "первый"));
    expect(first.status).toBe(201);
    const created = await readObject(first);
    const id = requiredString(created.id);

    const second = await postRuns(runBody("same-key", "второй"));
    expect(second.status).toBe(200);
    expect(await readObject(second)).toEqual({
      id,
      reason: "replay",
      status: "queued",
    });
    expect(await countRuns()).toBe(1);

    const stored = await sql<{ payload: unknown }[]>`
      select payload from runs where id = ${id}
    `;
    expect(stored[0]?.payload).toEqual({ message: "первый" });
  });

  it("должен при живом диалоге вернуть 409 и id живого запуска", async () => {
    const chatId = "4242";
    const first = await postRuns({
      agent_slug: "clerk",
      idempotency_key: "dialog-1",
      message: "один",
      chat_id: chatId,
    });
    expect(first.status).toBe(201);
    const liveId = requiredString((await readObject(first)).id);

    const second = await postRuns({
      agent_slug: "clerk",
      idempotency_key: "dialog-2",
      message: "два",
      chat_id: chatId,
    });
    expect(second.status).toBe(409);
    expect(await readObject(second)).toEqual({
      id: liveId,
      reason: "dialog_busy",
      status: "queued",
    });
    expect(await countRuns()).toBe(1);
  });

  it("должен ответить 404 на неизвестный slug", async () => {
    const missing = await postRuns({
      agent_slug: "no-such-agent",
      idempotency_key: "missing-agent",
      message: "привет",
    });
    expect(missing.status).toBe(404);
    expect(await readObject(missing)).toEqual({ reason: "unknown_agent" });

    const injected = await postRuns({
      agent_slug: "clerk' OR '1'='1",
      idempotency_key: "inject-slug",
      message: "x",
    });
    expect(injected.status).toBe(404);
    expect(await countRuns()).toBe(0);
  });

  it("должен вернуть шаги по возрастанию step_index", async () => {
    const created = await postRuns(runBody("steps-1", "вопрос клиенту"));
    expect(created.status).toBe(201);
    const runId = requiredString((await readObject(created)).id);

    const other = await postRuns(runBody("steps-other", "другой"));
    const otherId = requiredString((await readObject(other)).id);

    await sql`
      insert into run_steps (
        run_id, step_index, kind, tool_name, request_excerpt, response_excerpt, error
      ) values (
        ${runId}, 2, 'final', null, null, 'конец', null
      )
    `;
    await sql`
      insert into run_steps (
        run_id, step_index, kind, tool_name, request_excerpt, response_excerpt, error
      ) values (
        ${runId}, 0, 'model_request', null, 'вопрос', null, null
      )
    `;
    await sql`
      insert into run_steps (
        run_id, step_index, kind, tool_name, request_excerpt, response_excerpt, error
      ) values (
        ${runId}, 1, 'tool_call', 'list_dir', null, null, null
      )
    `;
    await sql`
      insert into run_steps (run_id, step_index, kind)
      values (${otherId}, 0, 'parse_error')
    `;

    const response = await send(app, `/v1/runs/${runId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const payload = await readObject(response);
    const run = requiredRecord(payload.run);
    expect(run.id).toBe(runId);
    expect(run.status).toBe("queued");
    expect(run.tenant_id).toBe("local");
    expect(run.payload).toEqual({ message: "вопрос клиенту" });
    expect(typeof run.created_at).toBe("string");

    const steps = requiredSteps(payload.steps);
    expect(steps.map((step) => step.step_index)).toEqual([0, 1, 2]);
    expect(steps.map((step) => step.kind)).toEqual(["model_request", "tool_call", "final"]);
    expect(steps[0]?.request_excerpt).toBe("вопрос");
    expect(steps[1]?.tool_name).toBe("list_dir");
    expect(steps[2]?.response_excerpt).toBe("конец");
    expect(steps.map((step) => step.run_id)).toEqual([runId, runId, runId]);
  });

  it("должен отбросить неизвестные поля и сохранить chat_id строкой", async () => {
    const raw =
      '{"__proto__":{"harnessPolluted":true},"constructor":{"polluted":true},"agent_slug":"clerk","idempotency_key":"strip-1","message":"ok","chat_id":"1234567890123456789","note":"drop","priority":1}';
    const response = await postRaw(raw);
    expect(response.status).toBe(201);
    const id = requiredString((await readObject(response)).id);

    const probe: { harnessPolluted?: boolean } = {};
    expect(probe.harnessPolluted).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, "harnessPolluted")).toBe(false);

    const stored = await sql<{ chat_id: string | null; priority: number; payload: unknown }[]>`
      select chat_id, priority, payload
      from runs
      where id = ${id}
    `;
    expect(stored[0]?.chat_id).toBe("1234567890123456789");
    expect(typeof stored[0]?.chat_id).toBe("string");
    expect(stored[0]?.priority).toBe(100);
    expect(stored[0]?.payload).toEqual({ message: "ok" });

    const loaded = await send(app, `/v1/runs/${id}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(loaded.status).toBe(200);
    const run = requiredRecord((await readObject(loaded)).run);
    expect(run.chat_id).toBe("1234567890123456789");
    expect(typeof run.chat_id).toBe("string");
    expect(run).not.toHaveProperty("note");
    expect(JSON.stringify(run).includes("DATABASE_URL")).toBe(false);
  });

  it("должен отвергнуть chat_id не в виде десятичного int8", async () => {
    for (const chatId of ["0123", "9223372036854775808", "1.5"]) {
      const response = await postRuns({
        agent_slug: "clerk",
        idempotency_key: `bad-${chatId}`,
        message: "нет",
        chat_id: chatId,
      });
      expect(response.status).toBe(400);
      expect(await readObject(response)).toEqual({ reason: "invalid_body" });
    }

    const numeric = await postRaw(
      '{"agent_slug":"clerk","idempotency_key":"numeric-chat","message":"нет","chat_id":1234567890123456789}',
    );
    expect(numeric.status).toBe(400);
    expect(await countRuns()).toBe(0);
  });

  it("должен скрыть секрет и стек в теле ответа", async () => {
    const broken = createApi({ sql, token: TOKEN, queue: queueThatThrows() });
    const response = await send(broken, "/v1/runs", authedJson(runBody("boom", "секрет не сюда")));
    expect(response.status).toBe(500);
    const text = await response.text();
    assertNoSecrets(text);
    expect(text.includes("STACK_MARKER_SHOULD_NOT_LEAK")).toBe(false);
    expect(JSON.parse(text) as unknown).toEqual({ reason: "internal_error" });
    expect(await countRuns()).toBe(0);
  });

  it("должен не отдавать запуск чужого tenant_id", async () => {
    const otherAgentId = "00000000-0000-4000-8000-0000000000aa";
    await sql`
      insert into agents (
        id,
        tenant_id,
        slug,
        display_name,
        system_prompt,
        model_alias,
        provider,
        max_steps,
        tool_allowlist
      ) values (
        ${otherAgentId},
        'other',
        'foreign',
        'Чужой',
        'prompt',
        'agent',
        'local',
        8,
        array['read_file', 'list_dir']::text[]
      )
    `;
    const inserted = await sql<{ id: string }[]>`
      insert into runs (
        tenant_id,
        agent_id,
        source,
        status,
        payload,
        idempotency_key
      ) values (
        'other',
        ${otherAgentId},
        'api',
        'queued',
        ${sql.json({ message: "чужой" })},
        'other-key'
      )
      returning id
    `;
    const foreignId = inserted[0]?.id;
    if (foreignId === undefined) {
      throw new Error("foreign run id missing");
    }

    const hidden = await send(app, `/v1/runs/${foreignId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(hidden.status).toBe(404);
    expect(await readObject(hidden)).toEqual({ reason: "not_found" });

    const missing = await send(app, "/v1/runs/00000000-0000-4000-8000-000000000099", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.status).toBe(404);

    const invalid = await send(app, "/v1/runs/not-a-uuid", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(invalid.status).toBe(400);
    expect(await readObject(invalid)).toEqual({ reason: "invalid_id" });
  });

  it("должен принять message из 8000 символов и отвергнуть 8001", async () => {
    const accepted = await postRuns(runBody("long-ok", "я".repeat(8000)));
    expect(accepted.status).toBe(201);

    const rejected = await postRuns(runBody("long-bad", "я".repeat(8001)));
    expect(rejected.status).toBe(400);
    expect(await readObject(rejected)).toEqual({ reason: "invalid_body" });
    expect(await countRuns()).toBe(1);
  });

  it("должен отвергнуть не-JSON и тело больше 32 КиБ", async () => {
    const broken = await postRaw("{");
    expect(broken.status).toBe(400);
    expect(await readObject(broken)).toEqual({ reason: "invalid_body" });

    const exact = await postRaw(jsonOfByteSize(BODY_LIMIT_BYTES));
    expect(exact.status).toBe(400);

    const over = await postRaw(jsonOfByteSize(BODY_LIMIT_BYTES + 1));
    expect(over.status).toBe(413);
    expect(await readObject(over)).toEqual({ reason: "payload_too_large" });
    expect(await countRuns()).toBe(0);
  });

  it("должен слушать 127.0.0.1", async () => {
    const server = startHttpServer(app, 0);
    try {
      await waitListening(server);
      const address = listenAddress(server);
      expect(address.address).toBe("127.0.0.1");
      expect(API_LISTEN_HOST).toBe("127.0.0.1");

      const health = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(health.status).toBe(200);
      expect(health.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await readObject(health)).toEqual({ ok: true });

      const created = await fetch(`http://127.0.0.1:${address.port}/v1/runs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(runBody("socket-1", "через сокет")),
      });
      expect(created.status).toBe(201);
      expect(created.headers.get("x-content-type-options")).toBe("nosniff");
      const payload = await readObject(created);
      expect(payload.reason).toBe("created");
      expect(payload.status).toBe("queued");

      const oversized = await fetch(`http://127.0.0.1:${address.port}/v1/runs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: "x".repeat(BODY_LIMIT_BYTES + 1),
      });
      expect(oversized.status).toBe(413);
      expect(oversized.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await readObject(oversized)).toEqual({ reason: "payload_too_large" });
    } finally {
      await closeServer(server);
    }
  });

  it("должен отказать startHttpServer на неверном порту и на занятом", async () => {
    expect(() => startHttpServer(app, 65536)).toThrow(ApiConfigError);
    expect(() => startHttpServer(app, -1)).toThrow(ApiConfigError);

    const first = startHttpServer(app, 0);
    let second: Server | undefined;
    try {
      await waitListening(first);
      const address = listenAddress(first);
      second = startHttpServer(app, address.port);
      const failure = await waitError(second);
      expect(errorCodeOf(failure)).toBe("EADDRINUSE");
    } finally {
      await closeServer(first);
      if (second !== undefined) {
        await closeQuietly(second);
      }
    }
  });
});

function runBody(idempotencyKey: string, message: string): Record<string, string> {
  return {
    agent_slug: "clerk",
    idempotency_key: idempotencyKey,
    message,
  };
}

function postInit(authorization: string, body: string): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body,
  };
}

function authedJson(body: unknown): RequestInit {
  return postInit(`Bearer ${TOKEN}`, JSON.stringify(body));
}

function postRuns(body: unknown): Promise<Response> {
  return send(app, "/v1/runs", authedJson(body));
}

function postRaw(body: string): Promise<Response> {
  return send(app, "/v1/runs", postInit(`Bearer ${TOKEN}`, body));
}

async function send(target: HttpApp, input: string, init?: RequestInit): Promise<Response> {
  const response = await target.request(input, init);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  return response;
}

async function readObject(response: Response): Promise<Record<string, unknown>> {
  const value = await readUnknown(response);
  return requiredRecord(value);
}

async function readUnknown(response: Response): Promise<unknown> {
  const text = await response.text();
  assertNoSecrets(text);
  return JSON.parse(text) as unknown;
}

function assertNoSecrets(text: string): void {
  for (const secret of secretMarkers) {
    if (secret.length > 0 && text.includes(secret)) {
      throw new Error("response contains a secret");
    }
  }
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("expected object");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("expected string");
  }
  return value;
}

function requiredSteps(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error("steps missing");
  }
  const rows: Record<string, unknown>[] = [];
  for (const step of value) {
    rows.push(requiredRecord(step));
  }
  return rows;
}

async function countRuns(): Promise<number> {
  const rows = await sql<{ count: number }[]>`select count(*)::int as count from runs`;
  const count = rows[0]?.count;
  if (typeof count !== "number") {
    throw new Error("count missing");
  }
  return count;
}

function jsonOfByteSize(size: number): string {
  const prefix = '{"agent_slug":"clerk","idempotency_key":"size-limit","message":"';
  const suffix = '"}';
  const filler = size - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  if (filler < 1) {
    throw new Error("size too small");
  }
  return prefix + "a".repeat(filler) + suffix;
}

function queueThatThrows(): RunQueue {
  const fail = (): Promise<never> => Promise.reject(new Error("STACK_MARKER_SHOULD_NOT_LEAK"));
  return {
    enqueue: fail,
    claimNext: fail,
    heartbeat: fail,
    reapExpired: fail,
    finish: fail,
  };
}

function waitListening(server: Server): Promise<void> {
  if (server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function waitError(server: Server): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("listen error timeout"));
    }, 2_000);
    server.once("error", (error: Error) => {
      clearTimeout(timer);
      resolve(error);
    });
  });
}

function listenAddress(server: Server): AddressInfo {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected tcp address");
  }
  return address;
}

function errorCodeOf(value: unknown): string | null {
  if (typeof value === "object" && value !== null && "code" in value) {
    const code = value.code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function closeQuietly(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}
