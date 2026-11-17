import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readWebAsset } from "../../src/api/admin.js";
import { createApi } from "../../src/api/app.js";
import { API_LISTEN_HOST, startHttpServer } from "../../src/api/server.js";
import { loadConfig } from "../../src/config.js";
import { sql } from "../helpers/db.js";

const ADMIN_TOKEN = "test-secret-value";
const API_TOKEN = "test-api-token-value";
const PLAINTEXT = "test-secret-value";
const SECRET_MASK = "••••";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const FOREIGN_AGENT_ID = "00000000-0000-4000-8000-0000000000aa";
const CHAT_TEXT = "1234567890123456789";
const CIPHER_MARKER = "cipher-marker-";
const NONCE_MARKER = "nonce-marker";
const SALT_MARKER = "salt-marker-1234";

const ADMIN_PATHS = [
  "/v1/admin/runs",
  "/v1/admin/agents",
  "/v1/admin/crons",
  "/v1/admin/runs/not-a-uuid/steps",
];

const config = loadConfig();
const secretMarkers = [ADMIN_TOKEN, API_TOKEN, PLAINTEXT, CIPHER_MARKER, NONCE_MARKER, SALT_MARKER];
if (config.databaseUrl.length > 0) {
  secretMarkers.push(config.databaseUrl);
}
if (config.harnessTestDatabaseUrl !== null && config.harnessTestDatabaseUrl.length > 0) {
  secretMarkers.push(config.harnessTestDatabaseUrl);
}

const app = createApi({ sql, token: API_TOKEN, adminToken: ADMIN_TOKEN });

interface HttpApp {
  request(input: string, init?: RequestInit): Promise<Response> | Response;
}

describe("admin", () => {
  beforeEach(async () => {
    await sql`delete from connector_secrets`;
  });

  afterEach(async () => {
    await sql`delete from connector_secrets`;
  });

  it("должен без bearer отвергнуть JSON админки", async () => {
    for (const route of ADMIN_PATHS) {
      const denied = await send(app, route);
      expect(denied.status).toBe(401);
      expect(await readObject(denied)).toEqual({ reason: "unauthorized" });
    }
  });

  it("должен отвергнуть чужой bearer и токен API", async () => {
    const headers = [`Bearer ${API_TOKEN}`, "Bearer test-secret-valuX", "Bearer no", ADMIN_TOKEN];
    for (const route of ADMIN_PATHS) {
      for (const authorization of headers) {
        const denied = await send(app, route, { headers: { authorization } });
        expect(denied.status).toBe(401);
        expect(await readObject(denied)).toEqual({ reason: "unauthorized" });
      }
    }
  });

  it("должен не открыть JSON пустым токеном админки", async () => {
    const omitted = createApi({ sql, token: API_TOKEN });
    const explicit = createApi({ sql, token: API_TOKEN, adminToken: "" });
    for (const target of [omitted, explicit]) {
      const denied = await send(target, "/v1/admin/runs", {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(denied.status).toBe(401);
      expect(await readObject(denied)).toEqual({ reason: "unauthorized" });
    }
  });

  it("должен скрыть арендатора не local и шаги чужого запуска", async () => {
    await insertAgent(FOREIGN_AGENT_ID, "other", "foreign");
    const localId = await insertRun("local", AGENT_ID, "local-visible", "свой");
    const foreignId = await insertRun("other", FOREIGN_AGENT_ID, "foreign-hidden", "чужой");
    await insertStep(localId, "local-step-marker");
    await insertStep(foreignId, "foreign-step-marker");
    await insertCron("local", AGENT_ID, ["echo", "local-cron"]);
    await insertCron("other", FOREIGN_AGENT_ID, ["echo", "foreign-cron"]);

    const runs = await send(app, "/v1/admin/runs", adminAuth());
    expect(runs.status).toBe(200);
    const runsText = await runs.clone().text();
    assertNoSecrets(runsText);
    expect(runsText).toContain("local-visible");
    expect(runsText).not.toContain("foreign-hidden");
    const runRows = requiredRows((await readObject(runs)).runs);
    expect(runRows.some((row) => row.idempotency_key === "local-visible")).toBe(true);

    const agents = await send(app, "/v1/admin/agents", adminAuth());
    expect(agents.status).toBe(200);
    const agentsText = await agents.text();
    assertNoSecrets(agentsText);
    expect(agentsText).toContain("clerk");
    expect(agentsText).not.toContain("foreign");

    const crons = await send(app, "/v1/admin/crons", adminAuth());
    expect(crons.status).toBe(200);
    const cronsText = await crons.text();
    assertNoSecrets(cronsText);
    expect(cronsText).toContain("local-cron");
    expect(cronsText).toContain(CHAT_TEXT);
    expect(cronsText).not.toContain("foreign-cron");
    const rounded = String(Number(CHAT_TEXT));
    expect(rounded).not.toBe(CHAT_TEXT);
    expect(cronsText).not.toContain(rounded);

    const steps = await send(app, `/v1/admin/runs/${localId}/steps`, adminAuth());
    expect(steps.status).toBe(200);
    const stepsText = await steps.text();
    assertNoSecrets(stepsText);
    expect(stepsText).toContain("local-step-marker");

    const hidden = await send(app, `/v1/admin/runs/${foreignId}/steps`, adminAuth());
    expect(hidden.status).toBe(404);
    const hiddenText = await hidden.text();
    expect(hiddenText).not.toContain("foreign-step-marker");
    expect(JSON.parse(hiddenText) as unknown).toEqual({ reason: "not_found" });

    const missing = await send(
      app,
      "/v1/admin/runs/00000000-0000-4000-8000-000000000099/steps",
      adminAuth(),
    );
    expect(missing.status).toBe(404);

    const invalid = await send(app, "/v1/admin/runs/not-a-uuid/steps", adminAuth());
    expect(invalid.status).toBe(400);
    expect(await readObject(invalid)).toEqual({ reason: "invalid_id" });
  });

  it("должен отдать маску секрета коннектора без шифртекста", async () => {
    const sealed = secretBytes();
    await insertAgent(FOREIGN_AGENT_ID, "other", "foreign");
    await insertSecret("local", "shop-token", sealed, AGENT_ID, null);
    await insertSecret("local", "floor-only", secretBytes(), null, "floor");
    await insertSecret("other", "foreign-secret", secretBytes(), AGENT_ID, null);

    const response = await send(app, "/v1/admin/agents", adminAuth());
    expect(response.status).toBe(200);
    const text = await response.text();
    assertNoSecrets(text);
    expect(text).not.toContain(CIPHER_MARKER);
    expect(text).not.toContain(NONCE_MARKER);
    expect(text).not.toContain(SALT_MARKER);
    expect(text).not.toContain(PLAINTEXT);
    expect(text).not.toContain(sealed.ciphertext.toString("base64"));
    expect(text).not.toContain(sealed.ciphertext.toString("hex"));
    expect(text).not.toContain(sealed.nonce.toString("hex"));
    expect(text).not.toContain(sealed.salt.toString("hex"));
    expect(text).not.toContain("floor-only");
    expect(text).not.toContain("foreign-secret");
    expect(text).not.toContain('"slug":"foreign"');
    expect(text).not.toContain('"ciphertext"');
    expect(text).not.toContain('"nonce"');
    expect(text).not.toContain('"salt"');

    const body = requiredRecord(JSON.parse(text) as unknown);
    const clerk = findAgent(body, "clerk");
    expect(clerk.secrets).toEqual([{ name: "shop-token", secret: SECRET_MASK }]);
  });

  it("должен показать секрет агента, который не попал в первые сто связей", async () => {
    const secondId = "00000000-0000-4000-8000-0000000000bb";
    await insertAgent(secondId, "local", "zeta");
    const sealed = secretBytes();
    await sql`
      insert into connector_secrets (tenant_id, name, ciphertext, nonce, salt)
      select
        'local',
        'a-' || lpad(g::text, 3, '0'),
        ${sealed.ciphertext},
        ${sealed.nonce},
        ${sealed.salt}
      from generate_series(1, 100) as g
    `;
    await sql`
      insert into connector_secret_grants (secret_id, agent_id)
      select id, ${AGENT_ID}::uuid
      from connector_secrets
      where tenant_id = 'local'
        and name like 'a-%'
    `;
    await insertSecret("local", "z-visible", sealed, secondId, null);

    const response = await send(app, "/v1/admin/agents", adminAuth());
    expect(response.status).toBe(200);
    const body = requiredRecord(JSON.parse(await response.text()) as unknown);
    const clerk = findAgent(body, "clerk");
    const zeta = findAgent(body, "zeta");
    expect(clerk.secrets).toHaveLength(100);
    expect(zeta.secrets).toEqual([{ name: "z-visible", secret: SECRET_MASK }]);
    await sql`delete from agents where id = ${secondId}`;
  });

  it("должен отдать пустые final_text и response_excerpt, не роняя список", async () => {
    const runId = await insertRun("local", AGENT_ID, "empty-text", "пусто");
    await sql`update runs set final_text = '' where id = ${runId}`;
    await insertStep(runId, "");

    const runs = await send(app, "/v1/admin/runs", adminAuth());
    expect(runs.status).toBe(200);
    const runBody = requiredRecord(JSON.parse(await runs.text()) as unknown);
    const rows = runBody.runs;
    if (!Array.isArray(rows)) {
      throw new Error("runs missing");
    }
    const match = rows.find((row) => {
      return typeof row === "object" && row !== null && "id" in row && row.id === runId;
    });
    if (typeof match !== "object" || match === null || !("final_text" in match)) {
      throw new Error("run missing");
    }
    expect(match.final_text).toBe("");

    const steps = await send(app, `/v1/admin/runs/${runId}/steps`, adminAuth());
    expect(steps.status).toBe(200);
    const stepBody = requiredRecord(JSON.parse(await steps.text()) as unknown);
    const stepRows = stepBody.steps;
    if (!Array.isArray(stepRows) || stepRows.length !== 1) {
      throw new Error("step missing");
    }
    const step = stepRows[0];
    if (typeof step !== "object" || step === null || !("response_excerpt" in step)) {
      throw new Error("excerpt missing");
    }
    expect(step.response_excerpt).toBe("");
  });

  it("должен вернуть не больше 100 запусков и не показать более новый чужой", async () => {
    await insertAgent(FOREIGN_AGENT_ID, "other", "foreign");
    await sql`
      insert into runs (
        tenant_id,
        agent_id,
        source,
        status,
        payload,
        idempotency_key
      )
      select
        'local',
        cast(${AGENT_ID} as uuid),
        'api',
        'queued',
        ${sql.json({ message: "batch" })},
        'batch-' || cast(g as text)
      from generate_series(1, 101) as g
    `;
    await sql`
      insert into runs (
        tenant_id,
        agent_id,
        source,
        status,
        payload,
        idempotency_key,
        created_at
      ) values (
        'other',
        ${FOREIGN_AGENT_ID},
        'api',
        'queued',
        ${sql.json({ message: "newer" })},
        'foreign-newer',
        now() + interval '1 day'
      )
    `;

    const response = await send(app, "/v1/admin/runs", adminAuth());
    expect(response.status).toBe(200);
    const body = await readObject(response);
    const rows = requiredRows(body.runs);
    expect(await countRuns()).toBe(102);
    expect(rows).toHaveLength(100);
    const keys = rows.map((row) => requiredString(row.idempotency_key));
    expect(keys).not.toContain("foreign-newer");
    for (const key of keys) {
      expect(key.startsWith("batch-")).toBe(true);
    }
  });

  it("должен слушать 127.0.0.1", async () => {
    expect(API_LISTEN_HOST).toBe("127.0.0.1");
    const server = startHttpServer(app, 0);
    try {
      await waitListening(server);
      const address = listenAddress(server);
      expect(address.address).toBe("127.0.0.1");
    } finally {
      await closeServer(server);
    }
  });

  it("должен не читать путь ../ и симлинк из web", async () => {
    expect(await readWebAsset("../package.json")).toBeNull();
    expect(await readWebAsset("../web/index.html")).toBeNull();
    expect(await readWebAsset("%2e%2e%2fpackage.json")).toBeNull();
    expect(await readWebAsset("/etc/passwd")).toBeNull();

    const page = await readWebAsset("index.html");
    expect(page).not.toBeNull();
    if (page === null) {
      throw new Error("index is missing");
    }
    expect(page.mediaType).toContain("text/html");
    expect(new TextDecoder().decode(page.body)).toContain("Запуски");

    const directory = await mkdtemp(path.join(tmpdir(), "harness-admin-"));
    const outside = path.join(directory, "outside.html");
    const link = path.resolve("web/escape-link");
    try {
      // Маркер лежит вне web. Путь собирается в тесте, литерала нет.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- файл вне каталога web
      await writeFile(outside, "<!doctype html><p>OUTSIDE_MARKER_ADMIN</p>", "utf8");
      await rm(link, { force: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- симлинк из web наружу
      await symlink(outside, link);
      expect(await readWebAsset("escape-link")).toBeNull();
      const escaped = await send(app, "/admin/escape-link");
      expect(escaped.status).toBe(404);
      expect(await escaped.text()).not.toContain("OUTSIDE_MARKER_ADMIN");

      const encoded = await send(app, "/admin/%2e%2e%2fpackage.json");
      expect(encoded.status).not.toBe(200);
      const encodedText = await encoded.text();
      expect(encodedText).not.toContain('"name": "harness"');
      expect(encodedText).not.toContain("OUTSIDE_MARKER_ADMIN");
    } finally {
      await rm(link, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("должен отдать страницу без bearer и не записать токен в файл", async () => {
    const disk = await readFile(path.resolve("web/index.html"), "utf8");
    expect(disk).not.toContain(ADMIN_TOKEN);
    expect(disk).not.toContain(PLAINTEXT);
    expect(disk.toLowerCase()).not.toContain("<form");
    expect(disk).not.toContain("POST");
    expect(disk).toContain('id="token"');
    expect(disk).toContain('id="runs"');
    expect(disk).toContain('id="steps"');
    expect(disk).toContain('id="agents"');
    expect(disk).toContain('id="crons"');
    expect(disk).toContain("Запуски");
    expect(disk).toContain("Шаги");
    expect(disk).toContain("Агенты");
    expect(disk).toContain("Кроны");

    const page = await send(app, "/admin");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toBe(disk);

    const withWrongBearer = await send(app, "/admin", {
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(withWrongBearer.status).toBe(200);
    expect(await withWrongBearer.text()).toBe(disk);
  });

  it("должен оставить постановку запуска на токене API и не открыть запись", async () => {
    const created = await send(app, "/v1/runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agent_slug: "clerk",
        idempotency_key: "api-still-works",
        message: "привет",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await readObject(created);
    const id = requiredString(createdBody.id);

    const blocked = await send(app, "/v1/runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agent_slug: "clerk",
        idempotency_key: "admin-must-not-enqueue",
        message: "нет",
      }),
    });
    expect(blocked.status).toBe(401);
    expect(await countRuns()).toBe(1);

    const visible = await send(app, `/v1/runs/${id}`, {
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(visible.status).toBe(200);

    const hiddenFromAdmin = await send(app, `/v1/runs/${id}`, adminAuth());
    expect(hiddenFromAdmin.status).toBe(401);

    const writeCron = await send(app, "/v1/admin/crons", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(writeCron.status).toBe(404);
    expect(await readObject(writeCron)).toEqual({ reason: "not_found" });

    const writeAllow = await send(app, "/v1/admin/agents/allowlist", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(writeAllow.status).toBe(404);
  });
});

function adminAuth(): RequestInit {
  return { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } };
}

function secretBytes(): { ciphertext: Buffer; nonce: Buffer; salt: Buffer } {
  return {
    ciphertext: Buffer.concat([Buffer.from(CIPHER_MARKER, "utf8"), Buffer.from(PLAINTEXT, "utf8")]),
    nonce: Buffer.from(NONCE_MARKER, "utf8"),
    salt: Buffer.from(SALT_MARKER, "utf8"),
  };
}

async function insertAgent(id: string, tenantId: string, slug: string): Promise<void> {
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
      ${id},
      ${tenantId},
      ${slug},
      'Чужой',
      'prompt',
      'agent',
      'local',
      8,
      array['read_file', 'list_dir']::text[]
    )
  `;
}

async function insertRun(
  tenantId: string,
  agentId: string,
  key: string,
  message: string,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into runs (
      tenant_id,
      agent_id,
      source,
      status,
      payload,
      idempotency_key
    ) values (
      ${tenantId},
      ${agentId},
      'api',
      'queued',
      ${sql.json({ message })},
      ${key}
    )
    returning id
  `;
  const id = rows[0]?.id;
  if (id === undefined || rows.length !== 1) {
    throw new Error("run insert failed");
  }
  return id;
}

async function insertStep(runId: string, excerpt: string): Promise<void> {
  await sql`
    insert into run_steps (
      run_id,
      step_index,
      kind,
      response_excerpt
    ) values (
      ${runId},
      0,
      'final',
      ${excerpt}
    )
  `;
}

async function insertCron(
  tenantId: string,
  agentId: string,
  command: readonly string[],
): Promise<void> {
  await sql`
    insert into cron_jobs (
      tenant_id,
      agent_id,
      kind,
      schedule,
      pause_chat_id,
      command
    ) values (
      ${tenantId},
      ${agentId},
      'script',
      '* * * * *',
      ${sql.types.chat_id(CHAT_TEXT)},
      ${sql.array([...command])}
    )
  `;
}

async function insertSecret(
  tenantId: string,
  name: string,
  sealed: { ciphertext: Buffer; nonce: Buffer; salt: Buffer },
  agentId: string | null,
  department: string | null,
): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    insert into connector_secrets (
      tenant_id,
      name,
      ciphertext,
      nonce,
      salt
    ) values (
      ${tenantId},
      ${name},
      ${sealed.ciphertext},
      ${sealed.nonce},
      ${sealed.salt}
    )
    returning id
  `;
  const id = rows[0]?.id;
  if (id === undefined || rows.length !== 1) {
    throw new Error("secret insert failed");
  }
  if (agentId !== null) {
    await sql`
      insert into connector_secret_grants (secret_id, agent_id)
      values (${id}, ${agentId})
    `;
    return;
  }
  if (department === null) {
    throw new Error("grant subject missing");
  }
  await sql`
    insert into connector_secret_grants (secret_id, department)
    values (${id}, ${department})
  `;
}

async function countRuns(): Promise<number> {
  const rows = await sql<{ count: number }[]>`select count(*)::int as count from runs`;
  const count = rows[0]?.count;
  if (typeof count !== "number") {
    throw new Error("count missing");
  }
  return count;
}

async function send(target: HttpApp, input: string, init?: RequestInit): Promise<Response> {
  const response = await target.request(input, init);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  return response;
}

async function readObject(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  assertNoSecrets(text);
  return requiredRecord(JSON.parse(text) as unknown);
}

function assertNoSecrets(text: string): void {
  for (const secret of secretMarkers) {
    if (secret.length > 0 && text.includes(secret)) {
      throw new Error("response contains a secret");
    }
  }
}

function findAgent(body: Record<string, unknown>, slug: string): Record<string, unknown> {
  const agents = body.agents;
  if (!Array.isArray(agents)) {
    throw new Error("agents missing");
  }
  for (const agent of agents) {
    if (isRecord(agent) && agent.slug === slug) {
      return agent;
    }
  }
  throw new Error("agent missing");
}

function requiredRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error("rows missing");
  }
  const rows: Record<string, unknown>[] = [];
  for (const row of value) {
    rows.push(requiredRecord(row));
  }
  return rows;
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

function listenAddress(server: Server): AddressInfo {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected tcp address");
  }
  return address;
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
