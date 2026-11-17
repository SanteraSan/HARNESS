import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { isPlainObject, readOwn } from "../../contract/data.js";
import { parseServicesManifest, type ServicesManifest } from "../../contract/manifest.js";
import { parseToolArguments } from "../../contract/tools.js";
import { ConfigError, loadConfig, readServiceManifest, type Config } from "../../src/config.js";
import type {
  ClaimedRun,
  ModelOutput,
  NewRunStep,
  RunnerContext,
  Tool,
  ToolOutcome,
} from "../../src/contracts/types.js";
import { OpenAICompatRunner, type RunnerAgent } from "../../src/runner/openai-compat.js";
import { createSecretVault, type SecretVault } from "../../src/secrets/index.js";
import { createServiceCatalog } from "../../src/services/catalog.js";
import { executeServiceCall } from "../../src/services/call.js";
import { toolRegistry } from "../../src/tools/index.js";
import { sql } from "../helpers/db.js";

const SECRET = "test-secret-value";
const WORKER_ID = "worker-service-arguments";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const SECRET_NAME = "JIRA_SERVICE_BEARER";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const JIRA_PATH = path.resolve(HERE, "../../config/jira.services.json");
const SRC_PATH = path.resolve(HERE, "../../src");

const JIRA_NAMES = [
  "create_backlog_issue",
  "transition_issue",
  "get_issue",
  "find_issues",
  "move_issue_to_sprint",
  "assign_issue",
  "add_issue_comment",
  "set_issue_description",
  "update_issue_labels",
  "add_remote_link",
] as const;

const SHAPES: Record<
  (typeof JIRA_NAMES)[number],
  {
    effect: "read" | "write";
    required: readonly string[] | null;
    fields: Record<string, readonly [number, number]>;
  }
> = {
  create_backlog_issue: {
    effect: "write",
    required: ["project_key", "summary"],
    fields: { project_key: [1, 10], summary: [1, 255], text: [0, 4000] },
  },
  transition_issue: {
    effect: "write",
    required: ["issue_key", "transition_name"],
    fields: { issue_key: [1, 32], transition_name: [1, 80] },
  },
  get_issue: {
    effect: "read",
    required: ["issue_key"],
    fields: { issue_key: [1, 32] },
  },
  find_issues: {
    effect: "read",
    required: null,
    fields: { project_key: [1, 10], text: [1, 200], status: [1, 64] },
  },
  move_issue_to_sprint: {
    effect: "write",
    required: ["issue_key"],
    fields: { issue_key: [1, 32], sprint_id: [1, 18], sprint_name: [1, 80] },
  },
  assign_issue: {
    effect: "write",
    required: ["issue_key", "assignee"],
    fields: { issue_key: [1, 32], assignee: [0, 200] },
  },
  add_issue_comment: {
    effect: "write",
    required: ["issue_key", "text"],
    fields: { issue_key: [1, 32], text: [1, 4000] },
  },
  set_issue_description: {
    effect: "write",
    required: ["issue_key", "description"],
    fields: { issue_key: [1, 32], description: [0, 4000] },
  },
  update_issue_labels: {
    effect: "write",
    required: ["issue_key"],
    fields: { issue_key: [1, 32] },
  },
  add_remote_link: {
    effect: "write",
    required: ["issue_key", "url", "title"],
    fields: { issue_key: [1, 32], url: [1, 2000], title: [1, 255] },
  },
};

let baseUrl = "http://127.0.0.1:9/";
const hits: Hit[] = [];

describe("service arguments", () => {
  let closeServer: () => Promise<void> = () => Promise.resolve();
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> = async (req, res) => {
    await recordAndReply(req, res);
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
    baseUrl = `http://127.0.0.1:${port}/`;
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
  });

  beforeEach(async () => {
    hits.length = 0;
    handler = async (req, res) => {
      await recordAndReply(req, res);
    };
    await sql`delete from connector_secrets`;
  });

  afterAll(async () => {
    await closeServer();
  });

  it("должен отправить имя из манифеста, которого нет в трёх локальных, на POST /v1/tools/{name} с конвертом harness.tool.v2", async () => {
    const manifest = desk({ type: "none" }, [findIssuesTool()]);
    const { steps } = await runCall({
      manifest,
      allowlist: ["find_issues"],
      name: "find_issues",
      args: {},
      vault: closedVault(),
    });
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit?.method).toBe("POST");
    expect(hit?.url).toBe("/v1/tools/find_issues");
    expect(hit?.contractHeader).toBe("harness.tool.v2");
    expect(hit?.authorization).toBeUndefined();
    expect(hit?.idempotencyKey).toBeUndefined();
    const body = envelope(hit?.body ?? "");
    expect(body.contract).toBe("harness.tool.v2");
    expect(body.name).toBe("find_issues");
    expect(body.arguments).toEqual({});
    expect(steps.some((step) => step.kind === "tool_result" && step.responseExcerpt === "готово")).toBe(
      true,
    );
  });

  it("должен для write поставить Idempotency-Key \"<run_id>:<tool_call_id>\" и не заводить второй клиент", async () => {
    const manifest = desk({ type: "none" }, [createBacklogTool()]);
    const { runId } = await runCall({
      manifest,
      allowlist: ["create_backlog_issue"],
      name: "create_backlog_issue",
      args: { project_key: "AB", summary: "Задача" },
      vault: closedVault(),
    });
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit?.url).toBe("/v1/tools/create_backlog_issue");
    expect(hit?.idempotencyKey).toBe(`"${runId}:call_1"`);
    expect(hit?.contractHeader).toBe("harness.tool.v2");
    const body = envelope(hit?.body ?? "");
    expect(body.arguments).toEqual({ project_key: "AB", summary: "Задача" });
    expect(Object.hasOwn(body.arguments, "idempotency_key")).toBe(false);
    expect(await fetchCount(path.join(SRC_PATH, "services"))).toBe(1);
  });

  it("должен отвергнуть лишнее поле аргумента до HTTP", async () => {
    const manifest = desk({ type: "none" }, [getIssueTool()]);
    const runId = await insertRun();
    const service = manifest.services[0];
    const tool = service?.tools[0];
    if (service === undefined || tool === undefined) {
      throw new Error("tool");
    }
    const extra = JSON.parse('{"issue_key":"AB-1","extra":"x"}') as unknown;
    const poisoned = JSON.parse('{"issue_key":"AB-1","__proto__":{"admin":true}}') as unknown;
    const constructed = JSON.parse('{"issue_key":"AB-1","constructor":"x"}') as unknown;
    for (const args of [extra, poisoned, constructed]) {
      const outcome = await executeServiceCall({
        sql,
        workerId: WORKER_ID,
        runId,
        tenantId: "local",
        agentId: AGENT_ID,
        toolCallId: "call_1",
        service,
        tool,
        args,
        secret: null,
        secrets: [],
      });
      expect(outcome.text).toBe("invalid arguments");
      expect(outcome.text).not.toContain("unknown_tool");
      expect(outcome.error).not.toContain("unknown_tool");
    }
    expect(hits).toHaveLength(0);
    expect(await invocationCount(runId)).toBe("0");
  });

  it("должен оставить read_file на прежнем разборе и не вызывать сеть локальным инструментом", async () => {
    const manifest = desk({ type: "none" }, [looseReadTool()]);
    const service = manifest.services[0];
    const tool = service?.tools[0];
    if (service === undefined || tool === undefined) {
      throw new Error("tool");
    }
    const runId = await insertRun();
    const outcome = await executeServiceCall({
      sql,
      workerId: WORKER_ID,
      runId,
      tenantId: "local",
      agentId: AGENT_ID,
      toolCallId: "call_1",
      service,
      tool,
      args: { path: "" },
      secret: null,
      secrets: [],
    });
    expect(outcome.text).toBe("invalid arguments");
    expect(hits).toHaveLength(0);
    expect(await invocationCount(runId)).toBe("0");

    let localCalls = 0;
    const localManifest = desk({ type: "none" }, [findIssuesTool()]);
    await runCall({
      manifest: localManifest,
      allowlist: ["read_file"],
      name: "read_file",
      args: { path: "a.txt" },
      vault: closedVault(),
      tools: [localRead(() => {
        localCalls += 1;
      })],
    });
    expect(localCalls).toBe(1);
    expect(hits).toHaveLength(0);
  });

  it("должен взять bearer через deliver по agent_id и не записать значение в шаги", async () => {
    const runId = await insertRun();
    const vault = createSecretVault(sql, SECRET);
    await vault.put({ tenantId: "local", name: SECRET_NAME, plaintext: SECRET });
    await vault.grant({
      tenantId: "local",
      secretName: SECRET_NAME,
      agentId: AGENT_ID,
      department: null,
    });
    handler = async (req, res) => {
      const body = await readRequest(req);
      hits.push(hitFrom(req, body));
      json(res, 200, reply(body, { text: SECRET }));
    };
    const manifest = desk({ type: "bearer", env: SECRET_NAME }, [getIssueTool()]);
    const outcome = await createServiceCatalog({
      sql,
      manifest,
      vault,
      redactSecrets: [],
    }).execute({
      runId,
      tenantId: "local",
      agentId: AGENT_ID,
      workerId: WORKER_ID,
      toolCallId: "call_1",
      name: "get_issue",
      args: { issue_key: "AB-1" },
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.authorization).toBe(`Bearer ${SECRET}`);
    expect(outcome.text).toBe("[redacted]");
    expect(outcome.text).not.toContain(SECRET);
    const steps = await stepText(runId);
    expect(steps).toContain("delivered");
    expect(steps).not.toContain(SECRET);
    const stored = await sql<{ excerpt: string }[]>`
      select result.excerpt
      from service_results as result
      join service_invocations as invocation on invocation.id = result.invocation_id
      where invocation.run_id = ${runId}
    `;
    expect(stored[0]?.excerpt).toBe("[redacted]");
    expect(stored[0]?.excerpt).not.toContain(SECRET);
  });

  it("должен без связи агента не открывать HTTP", async () => {
    const runId = await insertRun();
    const vault = createSecretVault(sql, SECRET);
    await vault.put({ tenantId: "local", name: SECRET_NAME, plaintext: SECRET });
    const manifest = desk({ type: "bearer", env: SECRET_NAME }, [getIssueTool()]);
    const outcome = await createServiceCatalog({
      sql,
      manifest,
      vault,
      redactSecrets: [],
    }).execute({
      runId,
      tenantId: "local",
      agentId: AGENT_ID,
      workerId: WORKER_ID,
      toolCallId: "call_1",
      name: "get_issue",
      args: { issue_key: "AB-1" },
    });
    expect(hits).toHaveLength(0);
    expect(await invocationCount(runId)).toBe("0");
    expect(outcome.text).toBe("secret is not available");
    expect(await stepText(runId)).not.toContain(SECRET);
  });

  it("должен не подставить секрет по имени отдела", async () => {
    const runId = await insertRun();
    const inner = createSecretVault(sql, SECRET);
    await inner.put({ tenantId: "local", name: SECRET_NAME, plaintext: SECRET });
    await inner.grant({
      tenantId: "local",
      secretName: SECRET_NAME,
      agentId: null,
      department: "floor",
    });
    let department: string | null = "unset";
    let agentId = "";
    let secretName = "";
    const vault: SecretVault = {
      put: (input) => inner.put(input),
      grant: (input) => inner.grant(input),
      deliver: (request, tool) => {
        department = request.department;
        agentId = request.agentId;
        secretName = request.secretName;
        return inner.deliver(request, tool);
      },
    };
    const saved = process.env.JIRA_SERVICE_BEARER;
    process.env.JIRA_SERVICE_BEARER = SECRET;
    try {
      const manifest = desk({ type: "bearer", env: SECRET_NAME }, [getIssueTool()]);
      await createServiceCatalog({
        sql,
        manifest,
        vault,
        redactSecrets: [],
      }).execute({
        runId,
        tenantId: "local",
        agentId: AGENT_ID,
        workerId: WORKER_ID,
        toolCallId: "call_1",
        name: "get_issue",
        args: { issue_key: "AB-1" },
      });
      expect(department).toBeNull();
      expect(agentId).toBe(AGENT_ID);
      expect(secretName).toBe(SECRET_NAME);
      expect(hits).toHaveLength(0);
      expect(await invocationCount(runId)).toBe("0");
      expect(await stepText(runId)).not.toContain(SECRET);
    } finally {
      if (saved === undefined) {
        delete process.env.JIRA_SERVICE_BEARER;
      } else {
        process.env.JIRA_SERVICE_BEARER = saved;
      }
    }
  });

  it("должен не вызвать HTTP для запрещённого имени из манифеста", async () => {
    const manifest = desk({ type: "none" }, [bashTool(), getIssueTool()]);
    const { runId, steps } = await runCall({
      manifest,
      allowlist: ["Bash", "get_issue"],
      name: "Bash",
      args: {},
      vault: closedVault(),
    });
    expect(hits).toHaveLength(0);
    expect(await invocationCount(runId)).toBe("0");
    expect(steps.some((step) => step.kind === "policy_deny" && step.toolName === "Bash")).toBe(true);
  });

  it("должен загрузить config/jira.services.json через parseServicesManifest и увидеть десять имён без секрета в файле", async () => {
    const raw = await readFile(JIRA_PATH, "utf8");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("Bearer ");
    expect(raw).not.toContain("sk-");
    expect(raw).not.toContain('"pattern"');
    expect(raw).not.toContain('"items"');
    expect(raw).not.toContain('"format"');
    expect(raw).not.toContain("harness.tool.v2");
    expect(raw).not.toContain("/rest/api");
    expect(raw).not.toContain("/v1/actions");
    const parsed = parseServicesManifest(JSON.parse(raw) as unknown);
    if (!parsed.ok) {
      throw new Error(parsed.message ?? parsed.reason);
    }
    const service = parsed.value.services[0];
    if (service === undefined) {
      throw new Error("service");
    }
    expect(parsed.value.contract).toBe("harness.services.v1");
    expect(parsed.value.services).toHaveLength(1);
    expect(service.id).toBe("jira");
    expect(service.base_url).toBe("http://127.0.0.1:8791");
    expect(service.auth).toEqual({ type: "bearer", env: SECRET_NAME });
    expect(service.tools.map((tool) => tool.name)).toEqual([...JIRA_NAMES]);
    for (const tool of service.tools) {
      const shape = SHAPES[tool.name as (typeof JIRA_NAMES)[number]];
      expect(tool.version).toBe("1");
      expect(tool.accepts_blobs).toBe(false);
      expect(tool.effect).toBe(shape.effect);
      expect(tool.parameters).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      if (shape.required === null) {
        expect(Object.hasOwn(tool.parameters, "required")).toBe(false);
      } else {
        expect(readOwn(tool.parameters, "required")).toEqual([...shape.required]);
      }
      const properties = readOwn(tool.parameters, "properties");
      if (!isPlainObject(properties)) {
        throw new Error("properties");
      }
      expect(Object.keys(properties).sort()).toEqual(Object.keys(shape.fields).sort());
      for (const [field, bounds] of Object.entries(shape.fields)) {
        const property = readOwn(properties, field);
        expect(property).toEqual({
          type: "string",
          minLength: bounds[0],
          maxLength: bounds[1],
        });
      }
    }
    for (const name of JIRA_NAMES) {
      expect(parseToolArguments(name, {}).ok).toBe(false);
    }
    const files = await listTs(SRC_PATH);
    expect(files.map((file) => path.basename(file).toLowerCase()).filter((name) => name.includes("jira"))).toEqual(
      [],
    );
    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text).not.toContain("/rest/api");
      expect(text).not.toContain("atlassian");
    }
  });

  it("должен принять один кодпоинт во вложенной схеме и отвергнуть лишнюю длину до HTTP", async () => {
    const manifest = desk({ type: "none" }, [nestedTool()]);
    const service = manifest.services[0];
    const tool = service?.tools[0];
    if (service === undefined || tool === undefined) {
      throw new Error("tool");
    }
    const runId = await insertRun();
    const accepted = await executeServiceCall({
      sql,
      workerId: WORKER_ID,
      runId,
      tenantId: "local",
      agentId: AGENT_ID,
      toolCallId: "call_1",
      service,
      tool,
      args: { title: "👍", meta: { flag: true } },
      secret: null,
      secrets: [],
    });
    expect(accepted.text).toBe("готово");
    expect(hits).toHaveLength(1);
    expect(envelope(hits[0]?.body ?? "").arguments).toEqual({
      title: "👍",
      meta: { flag: true },
    });

    hits.length = 0;
    const rejected = await insertRun();
    const tooLong = await executeServiceCall({
      sql,
      workerId: WORKER_ID,
      runId: rejected,
      tenantId: "local",
      agentId: AGENT_ID,
      toolCallId: "call_2",
      service,
      tool,
      args: { title: "👍👍", meta: { flag: true } },
      secret: null,
      secrets: [],
    });
    expect(tooLong.text).toBe("invalid arguments");
    expect(hits).toHaveLength(0);
    expect(await invocationCount(rejected)).toBe("0");

    const nestedExtra = await executeServiceCall({
      sql,
      workerId: WORKER_ID,
      runId: rejected,
      tenantId: "local",
      agentId: AGENT_ID,
      toolCallId: "call_3",
      service,
      tool,
      args: { title: "👍", meta: { flag: true, extra: true } },
      secret: null,
      secrets: [],
    });
    expect(nestedExtra.text).toBe("invalid arguments");
    expect(hits).toHaveLength(0);
  });

  it("должен не читать auth.env и отказать короткому ключу сейфа", async () => {
    const raw = await readFile(JIRA_PATH, "utf8");
    const sha = createHash("sha256").update(raw, "utf8").digest("hex");
    const saved = process.env.JIRA_SERVICE_BEARER;
    delete process.env.JIRA_SERVICE_BEARER;
    try {
      await expect(
        readServiceManifest(configFor(JIRA_PATH, sha, "short")),
      ).rejects.toMatchObject({
        name: "ConfigError",
        message: "invalid config: CONNECTOR_SECRETS_KEY",
      });
      await expect(readServiceManifest(configFor(JIRA_PATH, sha, ""))).rejects.toBeInstanceOf(
        ConfigError,
      );
      await expect(
        readServiceManifest(configFor(JIRA_PATH, sha, "a".repeat(257))),
      ).rejects.toMatchObject({ message: "invalid config: CONNECTOR_SECRETS_KEY" });

      const loaded = await readServiceManifest(configFor(JIRA_PATH, sha, SECRET));
      expect(Object.keys(loaded ?? {})).toEqual(["manifest"]);
      expect(JSON.stringify(loaded)).not.toContain(SECRET);
      expect(loaded?.manifest.services[0]?.auth).toEqual({ type: "bearer", env: SECRET_NAME });

      const dir = await mkdtemp(path.join(tmpdir(), "harness-m5-"));
      try {
        const file = path.join(dir, "services.json");
        const body = JSON.stringify({
          contract: "harness.services.v1",
          services: [
            {
              id: "files",
              base_url: "http://127.0.0.1:9/",
              auth: { type: "none" },
              tools: [findIssuesTool()],
            },
          ],
        });
        await writeFile(file, body, "utf8");
        const digest = createHash("sha256").update(body, "utf8").digest("hex");
        const none = await readServiceManifest(configFor(file, digest, ""));
        expect(none?.manifest.services[0]?.auth).toEqual({ type: "none" });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      if (saved === undefined) {
        delete process.env.JIRA_SERVICE_BEARER;
      } else {
        process.env.JIRA_SERVICE_BEARER = saved;
      }
    }
  });
});

interface Hit {
  method: string;
  url: string;
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  contractHeader: string | undefined;
  body: string;
}

function desk(
  auth: { type: "none" } | { type: "bearer"; env: string },
  tools: readonly unknown[],
): ServicesManifest {
  const parsed = parseServicesManifest({
    contract: "harness.services.v1",
    services: [
      {
        id: "desk",
        base_url: baseUrl,
        auth,
        tools,
      },
    ],
  });
  if (!parsed.ok) {
    throw new Error(parsed.message ?? parsed.reason);
  }
  return parsed.value;
}

function findIssuesTool(): Record<string, unknown> {
  return {
    name: "find_issues",
    version: "1",
    effect: "read",
    description: "Ищет задачи.",
    accepts_blobs: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        project_key: { type: "string", minLength: 1, maxLength: 10 },
        text: { type: "string", minLength: 1, maxLength: 200 },
        status: { type: "string", minLength: 1, maxLength: 64 },
      },
    },
  };
}

function createBacklogTool(): Record<string, unknown> {
  return {
    name: "create_backlog_issue",
    version: "1",
    effect: "write",
    description: "Создаёт задачу.",
    accepts_blobs: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["project_key", "summary"],
      properties: {
        project_key: { type: "string", minLength: 1, maxLength: 10 },
        summary: { type: "string", minLength: 1, maxLength: 255 },
        text: { type: "string", minLength: 0, maxLength: 4000 },
      },
    },
  };
}

function getIssueTool(): Record<string, unknown> {
  return {
    name: "get_issue",
    version: "1",
    effect: "read",
    description: "Читает задачу.",
    accepts_blobs: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["issue_key"],
      properties: {
        issue_key: { type: "string", minLength: 1, maxLength: 32 },
      },
    },
  };
}

function looseReadTool(): Record<string, unknown> {
  return {
    name: "read_file",
    version: "1",
    effect: "read",
    description: "Схема пускает пустой путь, локальный разбор — нет.",
    accepts_blobs: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", minLength: 0, maxLength: 4096 },
      },
    },
  };
}

function bashTool(): Record<string, unknown> {
  return {
    name: "Bash",
    version: "1",
    effect: "read",
    description: "Запрещённое имя.",
    accepts_blobs: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  };
}

function nestedTool(): Record<string, unknown> {
  return {
    name: "wrap_note",
    version: "1",
    effect: "read",
    description: "Вложенная заметка.",
    accepts_blobs: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["title", "meta"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 1 },
        meta: {
          type: "object",
          additionalProperties: false,
          required: ["flag"],
          properties: {
            flag: { type: "boolean" },
          },
        },
      },
    },
  };
}

function closedVault(): SecretVault {
  const fail = (): Promise<never> => Promise.reject(new Error("vault unused"));
  return { put: fail, grant: fail, deliver: fail };
}

async function runCall(input: {
  manifest: ServicesManifest;
  allowlist: readonly string[];
  name: string;
  args: Record<string, unknown>;
  vault: SecretVault | null;
  tools?: readonly Tool[];
}): Promise<{ runId: string; steps: NewRunStep[] }> {
  const runId = await insertRun();
  const steps: NewRunStep[] = [];
  const runner = new OpenAICompatRunner({
    loadAgent(): Promise<RunnerAgent> {
      return Promise.resolve(agent(input.allowlist));
    },
    fileRoot: "/tmp/harness-service-arguments",
    secrets: [],
    services: createServiceCatalog({
      sql,
      manifest: input.manifest,
      vault: input.vault,
      redactSecrets: [],
    }),
  });
  const output: ModelOutput = {
    content: null,
    toolCalls: [{ id: "call_1", name: input.name, arguments: JSON.stringify(input.args) }],
    promptTokens: 1,
    completionTokens: 1,
    model: "fake",
  };
  const context: RunnerContext = {
    workerId: WORKER_ID,
    leaseSeconds: 120,
    tools: input.tools === undefined ? [...toolRegistry] : [...input.tools],
    model: {
      complete(): Promise<ModelOutput> {
        return Promise.resolve(output);
      },
    },
    heartbeat(): Promise<boolean> {
      return Promise.resolve(true);
    },
    finish(): Promise<boolean> {
      return Promise.resolve(true);
    },
    appendStep(step): Promise<void> {
      steps.push(step);
      return Promise.resolve();
    },
  };
  await runner.run(claim(runId), context);
  return { runId, steps };
}

function agent(allowlist: readonly string[]): RunnerAgent {
  return {
    id: AGENT_ID,
    systemPrompt: "Отвечай по результатам инструментов.",
    modelAlias: "agent",
    provider: "local",
    maxSteps: 1,
    toolAllowlist: allowlist,
    maxCompletionTokens: 128,
  };
}

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

function configFor(file: string, sha: string, key: string): Config {
  return {
    ...loadConfig(),
    servicesManifestPath: file,
    servicesManifestSha256: sha,
    connectorSecretsKey: key,
  };
}

async function recordAndReply(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readRequest(req);
  hits.push(hitFrom(req, body));
  json(res, 200, reply(body));
}

function hitFrom(req: IncomingMessage, body: string): Hit {
  return {
    method: req.method ?? "",
    url: req.url ?? "",
    authorization: oneHeader(req.headers.authorization),
    idempotencyKey: oneHeader(req.headers["idempotency-key"]),
    contractHeader: oneHeader(req.headers["x-contract-version"]),
    body,
  };
}

function oneHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function envelope(raw: string): { contract: string; name: string; arguments: Record<string, unknown> } {
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error("body");
  }
  const contract = readOwn(parsed, "contract");
  const name = readOwn(parsed, "name");
  const args = readOwn(parsed, "arguments");
  if (typeof contract !== "string" || typeof name !== "string" || !isPlainObject(args)) {
    throw new Error("body");
  }
  return { contract, name, arguments: args };
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
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readRequest(req: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk), "utf8"));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function localRead(onCall: () => void): Tool {
  return {
    name: "read_file",
    description: "локальный",
    effect: "read",
    parameters: z.object({ path: z.string() }),
    execute(): Promise<ToolOutcome> {
      onCall();
      return Promise.resolve({ ok: true, text: "локально", truncated: false, entries: null });
    },
  };
}

async function invocationCount(runId: string): Promise<string> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count
    from service_invocations
    where run_id = ${runId}
  `;
  return rows[0]?.count ?? "0";
}

async function stepText(runId: string): Promise<string> {
  const rows = await sql<
    { kind: string; request_excerpt: string | null; response_excerpt: string | null; error: string | null }[]
  >`
    select kind, request_excerpt, response_excerpt, error
    from run_steps
    where run_id = ${runId}
  `;
  return rows
    .map((row) => [row.kind, row.request_excerpt, row.response_excerpt, row.error].join("\n"))
    .join("\n");
}

async function listTs(dir: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listTs(full)));
      continue;
    }
    if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

async function fetchCount(dir: string): Promise<number> {
  let count = 0;
  for (const file of await listTs(dir)) {
    const text = await readFile(file, "utf8");
    count += text.split("fetch(").length - 1;
  }
  return count;
}
