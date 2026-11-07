import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createRunQueue } from "../../src/queue/index.js";
import {
  SecretError,
  createSecretVault,
  encryptionKeyFrom,
  type SecretVault,
} from "../../src/secrets/index.js";
import { sql } from "../helpers/db.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_AGENT_ID = "00000000-0000-4000-8000-000000000002";
const FAKE_KEY = "test-secret-value";
const OTHER_KEY = "test-secret-other";
const PLAINTEXT = "fixture-connector-value";
const SECRET_NAME = "shop-token";

const queue = createRunQueue(sql);
const previousKey = process.env.CONNECTOR_SECRETS_KEY;
process.env.CONNECTOR_SECRETS_KEY = FAKE_KEY;

describe("SecretVault", () => {
  beforeEach(async () => {
    await sql`delete from connector_secrets`;
  });

  afterAll(() => {
    if (previousKey === undefined) {
      delete process.env.CONNECTOR_SECRETS_KEY;
      return;
    }
    process.env.CONNECTOR_SECRETS_KEY = previousKey;
  });

  it("должен записать в шаг маску и отдать секрет только внутрь коннектора", async () => {
    const vault = vaultFromEnv();
    const runId = await createRun("secrets-mask");
    await vault.put({ tenantId: "local", name: SECRET_NAME, plaintext: PLAINTEXT });
    const grant = await vault.grant({
      tenantId: "local",
      secretName: SECRET_NAME,
      agentId: AGENT_ID,
      department: null,
    });
    expect(grant.created).toBe(true);

    let seen: string | null = null;
    const outcome = await vault.deliver(request(runId, AGENT_ID, null), (secret) => {
      seen = secret;
      return Promise.resolve(`token=${secret}`);
    });

    expect(seen).toBe(PLAINTEXT);
    expect(outcome.received).toBe(true);
    expect(outcome.modelText).toBe("token=[redacted]");
    expect(outcome.modelText).not.toContain(PLAINTEXT);
    expect(outcome.modelText).not.toContain(FAKE_KEY);

    const steps = await stepsOf(runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe("tool_result");
    expect(steps[0]?.tool_name).toBe("shop_connector");
    expect(steps[0]?.response_excerpt).toBe("token=[redacted]");
    expect(stepBlob(steps)).not.toContain(PLAINTEXT);
    expect(stepBlob(steps)).not.toContain(FAKE_KEY);

    const stored = await sql<{ ciphertext: Buffer }[]>`
      select ciphertext from connector_secrets where name = ${SECRET_NAME}
    `;
    const ciphertext = stored[0]?.ciphertext;
    expect(Buffer.isBuffer(ciphertext)).toBe(true);
    if (!Buffer.isBuffer(ciphertext)) {
      throw new Error("ciphertext was not stored");
    }
    expect(ciphertext.equals(Buffer.from(PLAINTEXT, "utf8"))).toBe(false);
    expect(ciphertext.length).toBe(Buffer.byteLength(PLAINTEXT, "utf8") + 16);
  });

  it("должен отдать секрет по связи отдела", async () => {
    const vault = vaultFromEnv();
    const runId = await createRun("secrets-department");
    await vault.put({ tenantId: "local", name: SECRET_NAME, plaintext: PLAINTEXT });
    await vault.grant({
      tenantId: "local",
      secretName: SECRET_NAME,
      agentId: null,
      department: "floor",
    });

    let seen: string | null = null;
    const outcome = await vault.deliver(request(runId, AGENT_ID, "floor"), (secret) => {
      seen = secret;
      return Promise.resolve("opened");
    });

    expect(seen).toBe(PLAINTEXT);
    expect(outcome.received).toBe(true);
    expect(outcome.modelText).toBe("opened");
    expect(stepBlob(await stepsOf(runId))).not.toContain(PLAINTEXT);
  });

  it("должен вернуть ту же связь и не создавать вторую запись", async () => {
    const vault = vaultFromEnv();
    await vault.put({ tenantId: "local", name: SECRET_NAME, plaintext: PLAINTEXT });
    const agentGrant = {
      tenantId: "local",
      secretName: SECRET_NAME,
      agentId: AGENT_ID,
      department: null,
    };
    const first = await vault.grant(agentGrant);
    const second = await vault.grant(agentGrant);
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    expect(await countGrants()).toBe(1);

    const departmentGrant = {
      tenantId: "local",
      secretName: SECRET_NAME,
      agentId: null,
      department: "floor",
    };
    const department = await vault.grant(departmentGrant);
    const departmentAgain = await vault.grant(departmentGrant);
    expect(departmentAgain.id).toBe(department.id);
    expect(departmentAgain.created).toBe(false);
    expect(await countGrants()).toBe(2);
  });

  it("должен не отдавать секрет инструменту без связи", async () => {
    const vault = vaultFromEnv();
    const runId = await createRun("secrets-no-grant");
    await insertOtherAgent();
    await vault.put({ tenantId: "local", name: SECRET_NAME, plaintext: PLAINTEXT });
    await vault.grant({
      tenantId: "local",
      secretName: SECRET_NAME,
      agentId: OTHER_AGENT_ID,
      department: null,
    });

    let seen: string | null = null;
    const outcome = await vault.deliver(request(runId, AGENT_ID, null), (secret) => {
      seen = secret;
      return Promise.resolve(secret);
    });

    expect(seen).toBeNull();
    expect(outcome.received).toBe(false);
    expect(outcome.modelText).not.toContain(PLAINTEXT);
    const steps = await stepsOf(runId);
    expect(steps[0]?.kind).toBe("policy_deny");
    expect(steps[0]?.error).toBe("no_grant");
    expect(stepBlob(steps)).not.toContain(PLAINTEXT);
    expect(stepBlob(steps)).not.toContain(FAKE_KEY);
  });

  it("должен не отдавать секрет при чужом ключе шифрования", async () => {
    const vault = vaultFromEnv();
    const runId = await createRun("secrets-wrong-key");
    await vault.put({ tenantId: "local", name: SECRET_NAME, plaintext: PLAINTEXT });
    await vault.grant({
      tenantId: "local",
      secretName: SECRET_NAME,
      agentId: AGENT_ID,
      department: null,
    });

    const foreign = createSecretVault(sql, OTHER_KEY);
    let seen: string | null = null;
    const outcome = await foreign.deliver(request(runId, AGENT_ID, null), (secret) => {
      seen = secret;
      return Promise.resolve(secret);
    });

    expect(seen).toBeNull();
    expect(outcome.received).toBe(false);
    expect(outcome.modelText).not.toContain(PLAINTEXT);
    expect(stepBlob(await stepsOf(runId))).not.toContain(PLAINTEXT);
  });

  it("должен отказать выдаче связи без ровно одного субъекта", async () => {
    const vault = vaultFromEnv();
    await vault.put({ tenantId: "local", name: SECRET_NAME, plaintext: PLAINTEXT });

    await expect(
      vault.grant({
        tenantId: "local",
        secretName: SECRET_NAME,
        agentId: AGENT_ID,
        department: "floor",
      }),
    ).rejects.toMatchObject({ name: "SecretError", code: "invalid_grant" });

    await expect(
      vault.grant({
        tenantId: "local",
        secretName: SECRET_NAME,
        agentId: null,
        department: null,
      }),
    ).rejects.toBeInstanceOf(SecretError);

    expect(await countGrants()).toBe(0);
  });

  it("должен отказать второй записи секрета с тем же именем", async () => {
    const vault = vaultFromEnv();
    await vault.put({ tenantId: "local", name: SECRET_NAME, plaintext: PLAINTEXT });
    await expect(
      vault.put({ tenantId: "local", name: SECRET_NAME, plaintext: "fixture-connector-other" }),
    ).rejects.toMatchObject({ code: "secret_exists" });

    const rows = await sql<{ count: number }[]>`
      select count(*)::int as count from connector_secrets
    `;
    expect(rows[0]?.count).toBe(1);
  });

  it("должен отказать ключу шифрования, которого нет в окружении", () => {
    expect(() => encryptionKeyFrom({})).toThrow(expect.objectContaining({ code: "key_missing" }));
    expect(() => encryptionKeyFrom({ CONNECTOR_SECRETS_KEY: "short" })).toThrow(
      expect.objectContaining({ code: "key_invalid" }),
    );
    expect(encryptionKeyFrom(process.env)).toBe(FAKE_KEY);
  });
});

function vaultFromEnv(): SecretVault {
  return createSecretVault(sql, encryptionKeyFrom(process.env));
}

function request(
  runId: string,
  agentId: string,
  department: string | null,
): {
  tenantId: string;
  secretName: string;
  agentId: string;
  department: string | null;
  runId: string;
  toolName: string;
} {
  return {
    tenantId: "local",
    secretName: SECRET_NAME,
    agentId,
    department,
    runId,
    toolName: "shop_connector",
  };
}

async function createRun(idempotencyKey: string): Promise<string> {
  const result = await queue.enqueue({
    tenantId: "local",
    agentId: AGENT_ID,
    source: "api",
    idempotencyKey,
    message: "секрет коннектора",
    chatId: null,
  });
  return result.run.id;
}

async function insertOtherAgent(): Promise<void> {
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
      ${OTHER_AGENT_ID},
      'local',
      'other',
      'Другой',
      'prompt',
      'agent',
      'local',
      8,
      array['read_file', 'list_dir']::text[]
    )
  `;
}

interface StoredStep {
  kind: string;
  tool_name: string | null;
  request_excerpt: string | null;
  response_excerpt: string | null;
  error: string | null;
}

async function stepsOf(runId: string): Promise<StoredStep[]> {
  return sql<StoredStep[]>`
    select kind, tool_name, request_excerpt, response_excerpt, error
    from run_steps
    where run_id = ${runId}
    order by step_index asc
  `;
}

function stepBlob(steps: readonly StoredStep[]): string {
  return steps
    .map((step) =>
      [step.kind, step.tool_name, step.request_excerpt, step.response_excerpt, step.error].join(
        "\n",
      ),
    )
    .join("\n");
}

async function countGrants(): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    select count(*)::int as count from connector_secret_grants
  `;
  return rows[0]?.count ?? 0;
}
