import { describe, expect, it } from "vitest";

import type { NewRunStep } from "../../src/contracts/types.js";
import { loadConfig } from "../../src/config.js";
import { type Sql, createSql } from "../../src/db/client.js";
import { JournalError, createRunJournal } from "../../src/journal/index.js";
import { REDACTED } from "../../src/model/redact.js";
import { createRunQueue } from "../../src/queue/index.js";
import { TestDatabaseError, assertTestDatabase, sql } from "../helpers/db.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const listedSecret = "test-secret-value";

const queue = createRunQueue(sql);

interface StoredStep {
  step_index: number;
  kind: string;
  tool_name: string | null;
  request_excerpt: string | null;
  response_excerpt: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  error: string | null;
}

describe("RunJournal", () => {
  it("должен записать два шага с индексами 0 и 1 и сохранить токены", async () => {
    const journal = createRunJournal(sql, [listedSecret]);
    const runId = await createRun("journal-order");
    const requestExcerpt = "ответ'); drop table run_steps; --";

    await journal.appendStep({
      runId,
      kind: "model_request",
      toolName: null,
      requestExcerpt,
      responseExcerpt: null,
      promptTokens: 11,
      completionTokens: 22,
      error: null,
    });
    await journal.appendStep({
      runId,
      kind: "tool_result",
      toolName: "read_file",
      requestExcerpt: null,
      responseExcerpt: "файл",
      promptTokens: null,
      completionTokens: null,
      error: "нет файла",
    });

    const rows = await stepsOf(runId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      step_index: 0,
      kind: "model_request",
      tool_name: null,
      request_excerpt: requestExcerpt,
      response_excerpt: null,
      prompt_tokens: 11,
      completion_tokens: 22,
      error: null,
    });
    expect(rows[1]).toEqual({
      step_index: 1,
      kind: "tool_result",
      tool_name: "read_file",
      request_excerpt: null,
      response_excerpt: "файл",
      prompt_tokens: null,
      completion_tokens: null,
      error: "нет файла",
    });

    const otherId = await createRun("journal-other");
    await journal.appendStep(step(otherId, { requestExcerpt: "", responseExcerpt: "" }));
    const other = await stepsOf(otherId);
    expect(other.map((row) => row.step_index)).toEqual([0]);
    expect(other[0]?.request_excerpt).toBe("");
    expect(other[0]?.response_excerpt).toBe("");
  });

  it("должен убрать секрет из выдержек и обрезать их до 2000 символов Unicode", async () => {
    const journal = createRunJournal(sql, [listedSecret]);
    const runId = await createRun("journal-redact");
    const head = "а".repeat(1990);
    const requestExcerpt = `${head}${listedSecret}tail`;
    const responseExcerpt = `до ${listedSecret} после ${"б".repeat(1979)}🙂ХВОСТ`;

    await journal.appendStep({
      runId,
      kind: "model_request",
      toolName: null,
      requestExcerpt,
      responseExcerpt,
      promptTokens: 7,
      completionTokens: 9,
      error: null,
    });

    const row = await oneStep(runId);
    const expectedResponse = `до ${REDACTED} после ${"б".repeat(1979)}🙂`;
    expect(row.request_excerpt).toBe(`${head}${REDACTED}`);
    expect(row.response_excerpt).toBe(expectedResponse);
    expect(row.request_excerpt).not.toContain(listedSecret);
    expect(row.response_excerpt).not.toContain(listedSecret);
    expect(codePointLength(row.request_excerpt ?? "")).toBe(2000);
    expect(codePointLength(row.response_excerpt ?? "")).toBe(2000);
    expect(row.prompt_tokens).toBe(7);
    expect(row.completion_tokens).toBe(9);
  });

  it("должен назначить разные step_index двум параллельным вставкам", async () => {
    const runId = await createRun("journal-parallel");
    const left = openTestSql();
    const right = openTestSql();
    try {
      const leftJournal = createRunJournal(left, [listedSecret]);
      const rightJournal = createRunJournal(right, [listedSecret]);
      await Promise.all([
        leftJournal.appendStep(step(runId, { requestExcerpt: "from-left", promptTokens: 1 })),
        rightJournal.appendStep(step(runId, { requestExcerpt: "from-right", completionTokens: 2 })),
      ]);
    } finally {
      await left.end({ timeout: 5 });
      await right.end({ timeout: 5 });
    }

    const rows = await stepsOf(runId);
    expect(rows.map((row) => row.step_index)).toEqual([0, 1]);
    expect(rows.map((row) => row.request_excerpt).sort()).toEqual(["from-left", "from-right"]);
    const withPrompt = rows.find((row) => row.request_excerpt === "from-left");
    const withCompletion = rows.find((row) => row.request_excerpt === "from-right");
    expect(withPrompt?.prompt_tokens).toBe(1);
    expect(withPrompt?.completion_tokens).toBeNull();
    expect(withCompletion?.prompt_tokens).toBeNull();
    expect(withCompletion?.completion_tokens).toBe(2);
  });

  it("должен отказать, если запуска нет, и не записывать шаг", async () => {
    const journal = createRunJournal(sql, [listedSecret]);
    const missing = "00000000-0000-4000-8000-000000009999";
    const rejected = journal.appendStep(
      step(missing, {
        kind: "parse_error",
        requestExcerpt: listedSecret,
        responseExcerpt: listedSecret,
        error: "empty",
      }),
    );

    await expect(rejected).rejects.toBeInstanceOf(JournalError);
    await expect(rejected).rejects.toMatchObject({ code: "run_not_found" });

    const counts = await sql<{ count: number }[]>`
      select count(*)::int as count from run_steps
    `;
    expect(counts[0]?.count).toBe(0);
  });
});

function step(runId: string, patch: Partial<NewRunStep> = {}): NewRunStep {
  return {
    runId,
    kind: "final",
    toolName: null,
    requestExcerpt: null,
    responseExcerpt: null,
    promptTokens: null,
    completionTokens: null,
    error: null,
    ...patch,
  };
}

async function createRun(idempotencyKey: string): Promise<string> {
  const result = await queue.enqueue({
    tenantId: "local",
    agentId: AGENT_ID,
    source: "api",
    idempotencyKey,
    message: "запись шага",
    chatId: null,
  });
  return result.run.id;
}

async function stepsOf(runId: string): Promise<StoredStep[]> {
  return sql<StoredStep[]>`
    select
      step_index,
      kind,
      tool_name,
      request_excerpt,
      response_excerpt,
      prompt_tokens,
      completion_tokens,
      error
    from run_steps
    where run_id = ${runId}
    order by step_index asc
  `;
}

async function oneStep(runId: string): Promise<StoredStep> {
  const rows = await stepsOf(runId);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("step was not stored");
  }
  return row;
}

function openTestSql(): Sql {
  const databaseUrl = loadConfig().harnessTestDatabaseUrl;
  if (databaseUrl === null) {
    throw new TestDatabaseError("HARNESS_TEST_DATABASE_URL is required");
  }
  assertTestDatabase(databaseUrl);
  return createSql(databaseUrl);
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}
