import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { parseServicesManifest, type ServiceEntry, type ServiceTool } from "../../contract/manifest.js";
import type { ClaimedRun, FinishOutcome, ModelOutput, RunnerContext, Tool } from "../../src/contracts/types.js";
import { REDACTED } from "../../src/model/redact.js";
import { OpenAICompatRunner, type RunnerAgent } from "../../src/runner/openai-compat.js";
import { executeServiceCall } from "../../src/services/call.js";
import { sql } from "../helpers/db.js";

const SECRET = "test-secret-value";
const WORKER_ID = "worker-service-test";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";

let service: ServiceEntry;
let readTool: ServiceTool;
let noteTool: ServiceTool;

describe("service call", () => {
  let closeServer: () => Promise<void> = () => Promise.resolve();
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> = (_req, res) => {
    res.statusCode = 500;
    res.end();
    return Promise.resolve();
  };

  beforeAll(async () => {
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}/`;
    closeServer = () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    const parsed = parseServicesManifest({
      contract: "harness.services.v1",
      services: [
        {
          id: "files",
          base_url: baseUrl,
          auth: { type: "bearer", env: "FILE_SERVICE_TOKEN" },
          tools: [
            {
              name: "read_file",
              version: "1",
              effect: "read",
              description: "Читает файл.",
              accepts_blobs: false,
              parameters: {
                type: "object",
                additionalProperties: false,
                required: ["path"],
                properties: { path: { type: "string", minLength: 1, maxLength: 4096 } },
              },
            },
            {
              name: "record_note",
              version: "1",
              effect: "write",
              description: "Пишет заметку.",
              accepts_blobs: false,
              parameters: {
                type: "object",
                additionalProperties: false,
                required: ["path", "text"],
                properties: {
                  path: { type: "string", minLength: 1, maxLength: 4096 },
                  text: { type: "string", minLength: 1, maxLength: 12085 },
                },
              },
            },
          ],
        },
      ],
    });
    if (!parsed.ok) {
      throw new Error("manifest");
    }
    const entry = parsed.value.services[0];
    if (entry === undefined) {
      throw new Error("service");
    }
    service = entry;
    const read = entry.tools.find((tool) => tool.name === "read_file");
    const note = entry.tools.find((tool) => tool.name === "record_note");
    if (read === undefined || note === undefined) {
      throw new Error("tools");
    }
    readTool = read;
    noteTool = note;
  });

  afterAll(async () => {
    await closeServer();
  });

  it("должен принять сервис без модели и записать has_model: false", async () => {
    const runId = await insertRun();
    handler = async (req, res) => {
      const raw = await readRequest(req);
      json(res, 200, reply(raw, { report: { has_model: false } }));
    };
    const outcome = await call(runId, readTool, { path: "a.txt" });
    expect(outcome.lockLost).toBe(false);
    expect(outcome.text).toBe("готово");
    const row = await sql<{ report_status: string; has_model: boolean }[]>`
      select result.report_status, (result.report->>'has_model')::boolean as has_model
      from service_results as result
      join service_invocations as invocation on invocation.id = result.invocation_id
      where invocation.run_id = ${runId}
    `;
    expect(row[0]).toEqual({ report_status: "valid", has_model: false });
    const steps = await sql<{ count: string }[]>`
      select count(*)::text as count
      from service_model_steps as step
      join service_invocations as invocation on invocation.id = step.invocation_id
      where invocation.run_id = ${runId}
    `;
    expect(steps[0]?.count).toBe("0");
  });

  it("должен принять сервис со следом и записать шаги", async () => {
    const runId = await insertRun();
    handler = async (req, res) => {
      const raw = await readRequest(req);
      json(res, 200, reply(raw, {
        report: {
          has_model: true,
          claimed_prompt_tokens: 12,
          steps: [{ step_index: 0, excerpt: "ход", tool_calls: [{ id: "inner_1", name: "lookup" }] }],
        },
      }));
    };
    await call(runId, readTool, { path: "a.txt" });
    const steps = await sql<{ excerpt: string; name: string }[]>`
      select step.excerpt, step.tool_calls->0->>'name' as name
      from service_model_steps as step
      join service_invocations as invocation on invocation.id = step.invocation_id
      where invocation.run_id = ${runId}
    `;
    expect(steps).toEqual([{ excerpt: "ход", name: "lookup" }]);
  });

  it("должен оставить колонки заявлений отчёта пустыми, когда ключа report нет, и записать claimed_duration_ms из конверта", async () => {
    const runId = await insertRun();
    handler = async (req, res) => {
      json(res, 200, reply(await readRequest(req), { duration_ms: 9 }));
    };
    await call(runId, readTool, { path: "a.txt" });
    const row = await sql<{
      report_status: string;
      claimed_duration_ms: number;
      claimed_prompt_tokens: number | null;
    }[]>`
      select report_status, claimed_duration_ms, claimed_prompt_tokens
      from service_results as result
      join service_invocations as invocation on invocation.id = result.invocation_id
      where invocation.run_id = ${runId}
    `;
    expect(row[0]).toEqual({
      report_status: "absent",
      claimed_duration_ms: 9,
      claimed_prompt_tokens: null,
    });
  });

  it("должен отдать годный text в модель при битом report и не заклинить идемпотентность", async () => {
    const runId = await insertRun();
    handler = async (req, res) => {
      json(res, 200, reply(await readRequest(req), { text: "годный", report: { has_model: false, extra: true } }));
    };
    const outcome = await call(runId, readTool, { path: "a.txt" });
    expect(outcome.text).toBe("годный");
    const row = await sql<{ status: string; report_status: string }[]>`
      select invocation.status, result.report_status
      from service_invocations as invocation
      join service_results as result on result.invocation_id = invocation.id
      where invocation.run_id = ${runId}
    `;
    expect(row[0]).toEqual({ status: "completed", report_status: "invalid" });
  });

  it("должен отвергнуть чужой nonce и не привязать тело ни к какому запуску", async () => {
    const runId = await insertRun();
    handler = async (req, res) => {
      const body = reply(await readRequest(req), { text: "чужое тело" }) as { nonce: string };
      body.nonce = "00000000-0000-4000-8000-0000000000bb";
      json(res, 200, body);
    };
    const outcome = await call(runId, readTool, { path: "a.txt" });
    expect(outcome.text).toBe("echo_mismatch");
    expect(outcome.text).not.toContain("чужое");
    const results = await sql<{ count: string }[]>`
      select count(*)::text as count
      from service_results as result
      join service_invocations as invocation on invocation.id = result.invocation_id
      where invocation.run_id = ${runId}
    `;
    expect(results[0]?.count).toBe("0");
  });

  it("должен отвергнуть лишнее поле верхнего уровня целиком", async () => {
    const runId = await insertRun();
    handler = async (req, res) => {
      const body = reply(await readRequest(req), { text: "лишнее" }) as { extra?: boolean };
      body.extra = true;
      json(res, 200, body);
    };
    const outcome = await call(runId, readTool, { path: "a.txt" });
    expect(outcome.text).toBe("unknown_field");
    const results = await sql<{ count: string }[]>`
      select count(*)::text as count from service_results as result
      join service_invocations as invocation on invocation.id = result.invocation_id
      where invocation.run_id = ${runId}
    `;
    expect(results[0]?.count).toBe("0");
  });

  it("должен создать строку pending до ответа и перевести её в timeout", async () => {
    const runId = await insertRun();
    let sawPending = false;
    handler = async (_req, res) => {
      const rows = await sql<{ status: string }[]>`
        select status from service_invocations where run_id = ${runId}
      `;
      sawPending = rows[0]?.status === "pending";
      await new Promise((resolve) => {
        setTimeout(resolve, 400);
      });
      if (!res.writableEnded) {
        res.end();
      }
    };
    const outcome = await call(runId, readTool, { path: "a.txt" }, { timeoutMs: 80 });
    expect(sawPending).toBe(true);
    expect(outcome.text).toBe("timeout");
    const rows = await sql<{ status: string; transport_code: string }[]>`
      select status, transport_code from service_invocations where run_id = ${runId}
    `;
    expect(rows[0]).toEqual({ status: "timeout", transport_code: "timeout" });
  });

  it("должен на повтор того же ключа и хеша не подменить заявления", async () => {
    const runId = await insertRun();
    const bodies: string[] = [];
    handler = async (req, res) => {
      const raw = await readRequest(req);
      bodies.push(raw);
      if (bodies.length === 1) {
        json(res, 409, { reason: "idempotency_in_progress" });
        return;
      }
      json(res, 200, reply(raw, { report: { has_model: false, claimed_prompt_tokens: 5 } }));
    };
    await call(runId, noteTool, { path: "out/a.txt", text: "hello", idempotency_key: "model-key" }, { retryDelayMs: 0 });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[0]).not.toContain("idempotency_key");
    const row = await sql<{ claimed_prompt_tokens: number; count: string }[]>`
      select result.claimed_prompt_tokens, count(*)::text as count
      from service_results as result
      join service_invocations as invocation on invocation.id = result.invocation_id
      where invocation.run_id = ${runId}
      group by result.claimed_prompt_tokens
    `;
    expect(row).toEqual([{ claimed_prompt_tokens: 5, count: "1" }]);
  });

  it("должен не менять runs.prompt_tokens заявленными токенами", async () => {
    const runId = await insertRun();
    handler = async (req, res) => {
      json(res, 200, reply(await readRequest(req), { report: { has_model: false, claimed_prompt_tokens: 99 } }));
    };
    await call(runId, readTool, { path: "a.txt" });
    const rows = await sql<{ prompt_tokens: number }[]>`
      select prompt_tokens from runs where id = ${runId}
    `;
    expect(rows[0]?.prompt_tokens).toBe(7);
  });

  it("должен не класть report в следующее сообщение модели", async () => {
    const runId = await insertRun();
    handler = async (req, res) => {
      json(res, 200, reply(await readRequest(req), {
        text: "видимый",
        report: { has_model: false, finish_reason: "stop" },
      }));
    };
    const outcome = await call(runId, readTool, { path: "a.txt" });
    expect(outcome.text).toBe("видимый");
    expect(outcome.text).not.toContain("has_model");
    expect(outcome.text).not.toContain("finish_reason");
  });

  it("должен скрыть секрет в выдержке через redact", async () => {
    const runId = await insertRun();
    handler = async (req, res) => {
      json(res, 200, reply(await readRequest(req), { text: `до ${SECRET} после` }));
    };
    const outcome = await call(runId, readTool, { path: "a.txt" }, { secrets: [SECRET] });
    expect(outcome.text).toContain(REDACTED);
    expect(outcome.text).not.toContain(SECRET);
    const rows = await sql<{ excerpt: string }[]>`
      select excerpt from service_results as result
      join service_invocations as invocation on invocation.id = result.invocation_id
      where invocation.run_id = ${runId}
    `;
    expect(rows[0]?.excerpt).not.toContain(SECRET);
    expect(rows[0]?.excerpt).toContain(REDACTED);
  });

  it("должен отвергнуть URL внутри report", async () => {
    const runId = await insertRun();
    handler = async (req, res) => {
      json(res, 200, reply(await readRequest(req), {
        text: "готово",
        report: { has_model: true, steps: [{ step_index: 0, excerpt: "смотри https://evil.example/a" }] },
      }));
    };
    const outcome = await call(runId, readTool, { path: "a.txt" });
    expect(outcome.text).toBe("готово");
    const rows = await sql<{ report_status: string; report: unknown }[]>`
      select report_status, report from service_results as result
      join service_invocations as invocation on invocation.id = result.invocation_id
      where invocation.run_id = ${runId}
    `;
    expect(rows[0]?.report_status).toBe("invalid");
    expect(rows[0]?.report).toBeNull();
  });

  it("должен не импортировать клиент сервиса из src/queue", async () => {
    const directory = path.resolve(import.meta.dirname, "../../src/queue");
    const names = await readdir(directory);
    for (const name of names) {
      const source = await readFile(path.join(directory, name), "utf8");
      expect(source).not.toContain("src/services");
      expect(source).not.toContain("services/");
    }
  });

  it("должен при нуле строк обновления не ставить succeeded и не вызывать finish", async () => {
    const runId = await insertRun();
    handler = async (req, res) => {
      await sql`update runs set locked_by = 'other' where id = ${runId}`;
      json(res, 200, reply(await readRequest(req), { text: "поздно" }));
    };
    const outcome = await call(runId, readTool, { path: "a.txt" });
    expect(outcome.lockLost).toBe(true);
    expect(outcome.text).not.toContain("поздно");
    const runs = await sql<{ status: string }[]>`select status from runs where id = ${runId}`;
    expect(runs[0]?.status).toBe("running");
    const results = await sql<{ count: string }[]>`
      select count(*)::text as count from service_results as result
      join service_invocations as invocation on invocation.id = result.invocation_id
      where invocation.run_id = ${runId}
    `;
    expect(results[0]?.count).toBe("0");

    const finishes: FinishOutcome[] = [];
    const runner = new OpenAICompatRunner({
      loadAgent(): Promise<RunnerAgent> {
        return Promise.resolve(agent());
      },
      fileRoot: "/tmp/harness-service-test",
      secrets: [],
      services: {
        has(): boolean {
          return true;
        },
        modelTools(): { name: string; description: string; parameters: Record<string, unknown> }[] {
          return [{ name: "read_file", description: "Читает файл.", parameters: { type: "object" } }];
        },
        execute(): Promise<{ lockLost: boolean; text: string; error: string | null; requestExcerpt: string }> {
          return Promise.resolve({ lockLost: true, text: "", error: null, requestExcerpt: "read_file" });
        },
      },
    });
    await runner.run(claim(runId), context(finishes));
    expect(finishes).toEqual([]);
  });
});

async function insertRun(): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into runs (
      id, tenant_id, agent_id, source, status, payload, idempotency_key,
      locked_by, locked_until, prompt_tokens
    ) values (
      ${id},
      'local',
      ${AGENT_ID},
      'api',
      'running',
      ${sql.json({ message: "ход" })},
      ${id},
      ${WORKER_ID},
      now() + interval '5 minutes',
      7
    )
  `;
  return id;
}

function call(
  runId: string,
  tool: ServiceTool,
  args: Record<string, unknown>,
  options: { timeoutMs?: number; retryDelayMs?: number; secrets?: readonly string[] } = {},
): ReturnType<typeof executeServiceCall> {
  return executeServiceCall({
    sql,
    workerId: WORKER_ID,
    runId,
    tenantId: "local",
    agentId: AGENT_ID,
    toolCallId: "call_1",
    service,
    tool,
    args,
    secret: SECRET,
    secrets: options.secrets ?? [],
    timeoutMs: options.timeoutMs,
    retryDelayMs: options.retryDelayMs,
  });
}

function reply(raw: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const request = JSON.parse(raw) as { nonce: string; run_id: string; tool_call_id: string };
  return {
    contract: "harness.tool.v2",
    ok: true,
    text: "готово",
    truncated: false,
    duration_ms: 4,
    blobs: [],
    nonce: request.nonce,
    run_id: request.run_id,
    tool_call_id: request.tool_call_id,
    ...extra,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readRequest(req: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk), "utf8"));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function agent(): RunnerAgent {
  return {
    id: AGENT_ID,
    systemPrompt: "Отвечай по результатам инструментов.",
    modelAlias: "agent",
    provider: "local",
    maxSteps: 2,
    toolAllowlist: ["read_file"],
    maxCompletionTokens: 128,
  };
}

function claim(runId: string): ClaimedRun {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: runId,
    tenantId: "local",
    agentId: AGENT_ID,
    parentRunId: null,
    source: "api",
    status: "running",
    priority: 100,
    deadlineAt: null,
    notBefore: null,
    chatId: null,
    payload: { message: "ход" },
    idempotencyKey: runId,
    attempt: 1,
    maxAttempts: 3,
    lockedBy: WORKER_ID,
    lockedUntil: now,
    modelAlias: null,
    provider: null,
    promptTokens: 7,
    completionTokens: null,
    error: null,
    finalText: null,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
  };
}

function context(finishes: FinishOutcome[]): RunnerContext {
  const output: ModelOutput = {
    content: null,
    toolCalls: [{ id: "call_1", name: "read_file", arguments: "{\"path\":\"a.txt\"}" }],
    promptTokens: 1,
    completionTokens: 1,
    model: "fake",
  };
  return {
    workerId: WORKER_ID,
    leaseSeconds: 120,
    tools: [localTool()],
    model: {
      complete(): Promise<ModelOutput> {
        return Promise.resolve(output);
      },
    },
    heartbeat(): Promise<boolean> {
      return Promise.resolve(true);
    },
    finish(_runId: string, _workerId: string, outcome: FinishOutcome): Promise<boolean> {
      finishes.push(outcome);
      return Promise.resolve(true);
    },
    appendStep(): Promise<void> {
      return Promise.resolve();
    },
  };
}

function localTool(): Tool {
  return {
    name: "read_file",
    description: "локальный",
    effect: "read",
    parameters: z.object({ path: z.string() }),
    execute(): Promise<{ ok: false; error: string }> {
      return Promise.reject(new Error("local execute"));
    },
  };
}
