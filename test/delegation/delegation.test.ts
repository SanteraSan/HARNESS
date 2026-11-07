import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as config from "../../src/config.js";
import type { ToolContext, ToolOutcome } from "../../src/contracts/types.js";
import { createDelegationTools, type DelegationTools } from "../../src/delegation/index.js";
import { LiteLLMChatModel } from "../../src/model/litellm.js";
import { QueueError, createRunQueue } from "../../src/queue/index.js";
import { sql } from "../helpers/db.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const BIG_CHAT_ID = 1234567890123456789n;
const TOKEN = "test-secret-value";

const queue = createRunQueue(sql);
const tools = createDelegationTools({ sql, queue });

describe("delegation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("должен записать дочернему запуску parent_run_id и source = delegation", async () => {
    const parentId = await enqueueParent("parent-child");
    const outcome = await tools.createSubtask.execute(
      { message: "сделай", idempotency_key: "child-1" },
      toolContext(parentId),
    );

    const childId = queuedRunId(outcome);
    const rows = await sql<
      {
        id: string;
        parent_run_id: string | null;
        source: string;
        status: string;
        attempt: number;
        locked_by: string | null;
        chat_id: string | null;
        payload: { message: string };
      }[]
    >`
      select id, parent_run_id, source, status, attempt, locked_by, chat_id, payload
      from runs
      where id = ${childId}
    `;
    const child = rows[0];
    expect(child?.parent_run_id).toBe(parentId);
    expect(child?.source).toBe("delegation");
    expect(child?.status).toBe("queued");
    expect(child?.attempt).toBe(0);
    expect(child?.locked_by).toBeNull();
    expect(child?.chat_id).toBeNull();
    expect(child?.payload).toEqual({ message: "сделай" });
    expect(outcome).toEqual({
      ok: true,
      text: `queued ${childId}`,
      truncated: false,
      entries: null,
    });
    expect(await countRuns()).toBe(2);
    expect(await countTasks()).toBe(1);
    expect((await taskRow(parentId)).status).toBe("open");
  });

  it("должен не создавать вторую строку при повторе того же ключа", async () => {
    const parentId = await enqueueParent("parent-replay");
    const key = "child'); delete from runs; --";
    const message = "сделай'); drop table tasks; --";
    const first = await tools.createSubtask.execute(
      { message, idempotency_key: key },
      toolContext(parentId),
    );
    const second = await tools.createSubtask.execute(
      { message: "другой текст", idempotency_key: key },
      toolContext(parentId),
    );

    expect(second).toEqual(first);
    const childId = queuedRunId(first);
    const rows = await sql<
      { id: string; parent_run_id: string; source: string; payload: { message: string } }[]
    >`
      select id, parent_run_id, source, payload
      from runs
      where parent_run_id = ${parentId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(childId);
    expect(rows[0]?.source).toBe("delegation");
    expect(rows[0]?.parent_run_id).toBe(parentId);
    expect(rows[0]?.payload).toEqual({ message });
    expect(await countRuns()).toBe(2);
    expect(await countTasks()).toBe(1);
    expect(await countAgents()).toBe(1);
  });

  it("должен перевести родительскую задачу и не вызывать модель и не читать токен бота", async () => {
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("model called"));
    const complete = vi
      .spyOn(LiteLLMChatModel.prototype, "complete")
      .mockRejectedValue(new Error("model called"));
    const loadConfig = vi.spyOn(config, "loadConfig");

    try {
      const parentId = await enqueueParent("parent-approve", `задача ${TOKEN}`);
      const created = await tools.createSubtask.execute(
        { message: TOKEN, idempotency_key: "sub-approve" },
        toolContext(parentId),
      );
      expect(created.ok).toBe(true);
      if (created.ok) {
        expect(created.text.includes(TOKEN)).toBe(false);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(loadConfig).not.toHaveBeenCalled();

      const runsBefore = await countRuns();
      const parentStatus = await runStatus(parentId);
      fetchSpy.mockClear();
      complete.mockClear();
      loadConfig.mockClear();

      const outcome = await tools.approve.execute({}, toolContext(parentId));
      expect(outcome).toEqual({
        ok: true,
        text: "approved",
        truncated: false,
        entries: null,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(loadConfig).not.toHaveBeenCalled();
      expect(JSON.stringify(outcome).includes(TOKEN)).toBe(false);

      const task = await taskRow(parentId);
      expect(task.status).toBe("approved");
      expect(task.approved_at).toBeInstanceOf(Date);
      expect(await runStatus(parentId)).toBe(parentStatus);
      expect(await countRuns()).toBe(runsBefore);
      expect((await childStatus(parentId)).status).toBe("queued");

      const again = await tools.approve.execute({}, toolContext(parentId));
      expect(again).toEqual(outcome);
      const repeated = await taskRow(parentId);
      expect(repeated.approved_at?.getTime()).toBe(task.approved_at?.getTime());
      expect(await countTasks()).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(loadConfig).not.toHaveBeenCalled();
    } finally {
      restoreToken(previousToken);
    }
  });

  it("должен отказать approve без задачи и не вызывать модель", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("model called"));
    const complete = vi
      .spyOn(LiteLLMChatModel.prototype, "complete")
      .mockRejectedValue(new Error("model called"));
    const parentId = await enqueueParent("parent-no-task");

    const outcome = await tools.approve.execute({}, toolContext(parentId));

    expect(outcome).toEqual({ ok: false, error: "task is missing" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(await countTasks()).toBe(0);
    expect(await countRuns()).toBe(1);
    expect(await runStatus(parentId)).toBe("queued");
  });

  it("должен отказать create_subtask без родительского запуска", async () => {
    const missing = "00000000-0000-4000-8000-000000000099";
    const outcome = await tools.createSubtask.execute(
      { message: "нет родителя", idempotency_key: "orphan" },
      toolContext(missing),
    );

    expect(outcome).toEqual({ ok: false, error: "not allowed" });
    expect(await countRuns()).toBe(0);
    expect(await countTasks()).toBe(0);
  });

  it("должен отказать ключу родителя и не создать вторую строку", async () => {
    const parentId = await enqueueParent("parent-key");
    const outcome = await tools.createSubtask.execute(
      { message: "тот же ключ", idempotency_key: "parent-key" },
      toolContext(parentId),
    );

    expect(outcome).toEqual({ ok: false, error: "not allowed" });
    expect(await countRuns()).toBe(1);
    expect(await countTasks()).toBe(0);
  });

  it("должен не ставить дочерний запуск после approve", async () => {
    const parentId = await enqueueParent("parent-closed");
    const opened = await tools.createSubtask.execute(
      { message: "первый", idempotency_key: "before-approve" },
      toolContext(parentId),
    );
    expect(opened.ok).toBe(true);
    expect(await tools.approve.execute({}, toolContext(parentId))).toEqual({
      ok: true,
      text: "approved",
      truncated: false,
      entries: null,
    });

    const denied = await tools.createSubtask.execute(
      { message: "опоздал", idempotency_key: "after-approve" },
      toolContext(parentId),
    );
    expect(denied).toEqual({ ok: false, error: "task is approved" });
    expect(await countRuns()).toBe(2);
    expect((await taskRow(parentId)).status).toBe("approved");
  });

  it("должен отбросить лишний аргумент с токеном и не создавать запуск", async () => {
    const parentId = await enqueueParent("parent-token-arg");
    const outcome = await tools.createSubtask.execute(
      {
        message: "работа",
        idempotency_key: "with-token",
        bot_token: TOKEN,
      },
      toolContext(parentId),
    );

    expect(outcome).toEqual({ ok: false, error: "invalid arguments" });
    expect(JSON.stringify(outcome).includes(TOKEN)).toBe(false);
    expect(await countRuns()).toBe(1);
    expect(await countTasks()).toBe(0);
  });

  it("должен записать source = delegation вместе с большим chat_id", async () => {
    const parent = await queue.enqueue({
      tenantId: "local",
      agentId: AGENT_ID,
      source: "api",
      idempotencyKey: "queue-parent",
      message: "родитель",
      chatId: null,
    });
    const child = await queue.enqueue({
      tenantId: "local",
      agentId: AGENT_ID,
      source: "delegation",
      idempotencyKey: "queue-child",
      message: "дочерний",
      chatId: BIG_CHAT_ID,
      parentRunId: parent.run.id,
    });

    expect(child.created).toBe(true);
    expect(child.reason).toBe("created");
    expect(child.run.source).toBe("delegation");
    expect(child.run.parentRunId).toBe(parent.run.id);
    expect(child.run.chatId).toBe(BIG_CHAT_ID);
    expect(typeof child.run.chatId).toBe("bigint");

    const stored = await sql<{ parent_run_id: string; source: string; chat_id: string }[]>`
      select parent_run_id, source, chat_id
      from runs
      where id = ${child.run.id}
    `;
    expect(stored[0]?.parent_run_id).toBe(parent.run.id);
    expect(stored[0]?.source).toBe("delegation");
    expect(stored[0]?.chat_id).toBe(BIG_CHAT_ID.toString());
    expect(typeof stored[0]?.chat_id).toBe("string");

    const replay = await queue.enqueue({
      tenantId: "local",
      agentId: AGENT_ID,
      source: "delegation",
      idempotencyKey: "queue-child",
      message: "ещё раз",
      chatId: 1n,
      parentRunId: parent.run.id,
    });
    expect(replay.created).toBe(false);
    expect(replay.reason).toBe("replay");
    expect(replay.run.id).toBe(child.run.id);
    expect(replay.run.chatId).toBe(BIG_CHAT_ID);
    expect(await countRuns()).toBe(2);
  });

  it("должен записать source = cron и оставить parent_run_id пустым", async () => {
    const created = await queue.enqueue({
      tenantId: "local",
      agentId: AGENT_ID,
      source: "cron",
      idempotencyKey: "cron-tick",
      message: "tick",
      chatId: BIG_CHAT_ID,
    });

    expect(created.created).toBe(true);
    expect(created.run.source).toBe("cron");
    expect(created.run.parentRunId).toBeNull();
    expect(created.run.chatId).toBe(BIG_CHAT_ID);
    expect(typeof created.run.chatId).toBe("bigint");

    const stored = await sql<{ source: string; parent_run_id: string | null; chat_id: string }[]>`
      select source, parent_run_id, chat_id
      from runs
      where id = ${created.run.id}
    `;
    expect(stored[0]?.source).toBe("cron");
    expect(stored[0]?.parent_run_id).toBeNull();
    expect(stored[0]?.chat_id).toBe(BIG_CHAT_ID.toString());
  });

  it("должен отказать поддельному parent_run_id и не создать строку", async () => {
    await expect(
      queue.enqueue({
        tenantId: "local",
        agentId: AGENT_ID,
        source: "delegation",
        idempotencyKey: "bad-parent",
        message: "нет",
        chatId: null,
        parentRunId: "not-a-uuid",
      }),
    ).rejects.toBeInstanceOf(QueueError);
    await expect(
      queue.enqueue({
        tenantId: "local",
        agentId: AGENT_ID,
        source: "delegation",
        idempotencyKey: "bad-parent",
        message: "нет",
        chatId: null,
        parentRunId: "not-a-uuid",
      }),
    ).rejects.toMatchObject({ code: "invalid_parent_run" });

    const missingParent = "00000000-0000-4000-8000-000000000099";
    await expect(
      queue.enqueue({
        tenantId: "local",
        agentId: AGENT_ID,
        source: "delegation",
        idempotencyKey: "missing-parent",
        message: "нет",
        chatId: null,
        parentRunId: missingParent,
      }),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await countRuns()).toBe(0);
  });

  it("должен не импортировать клиент модели и не читать токен бота", async () => {
    const delegation = await sourceText("src/delegation/manager.ts");
    const barrel = await sourceText("src/delegation/index.ts");
    const queueSource = await sourceText("src/queue/run-queue.ts");
    const combined = `${delegation}\n${barrel}`;

    expect(combined.includes("TELEGRAM")).toBe(false);
    expect(combined.includes("process.env")).toBe(false);
    expect(combined.includes("loadConfig")).toBe(false);
    expect(combined.includes("litellm")).toBe(false);
    expect(combined.includes("ChatModel")).toBe(false);
    expect(combined.includes("child_process")).toBe(false);
    expect(combined.includes("grammy")).toBe(false);
    expect(queueSource.includes('from "../model')).toBe(false);
    expect(queueSource.includes("litellm")).toBe(false);
    expect(queueSource.includes("child_process")).toBe(false);
    expect(queueSource.includes("Number(")).toBe(false);
    expect(tools.createSubtask.effect).toBe("write");
    expect(tools.approve.effect).toBe("write");
    expect(toolNames(tools)).toEqual(["create_subtask", "approve"]);
  });
});

function toolNames(value: DelegationTools): string[] {
  return [value.createSubtask.name, value.approve.name];
}

function toolContext(runId: string): ToolContext {
  return {
    runId,
    agentId: AGENT_ID,
    fileRoot: "/tmp/harness-delegation-unused",
  };
}

async function enqueueParent(idempotencyKey: string, message = "родитель"): Promise<string> {
  const created = await queue.enqueue({
    tenantId: "local",
    agentId: AGENT_ID,
    source: "api",
    idempotencyKey,
    message,
    chatId: null,
  });
  expect(created.created).toBe(true);
  return created.run.id;
}

function queuedRunId(outcome: ToolOutcome): string {
  if (!outcome.ok || !outcome.text.startsWith("queued ")) {
    throw new Error("child was not queued");
  }
  return outcome.text.slice("queued ".length);
}

async function runStatus(id: string): Promise<string> {
  const rows = await sql<{ status: string }[]>`
    select status from runs where id = ${id}
  `;
  const status = rows[0]?.status;
  if (status === undefined) {
    throw new Error("run is missing");
  }
  return status;
}

async function childStatus(parentId: string): Promise<{ status: string }> {
  const rows = await sql<{ status: string }[]>`
    select status from runs where parent_run_id = ${parentId}
  `;
  const row = rows[0];
  if (row === undefined || rows.length !== 1) {
    throw new Error("child run is missing");
  }
  return row;
}

async function taskRow(runId: string): Promise<{ status: string; approved_at: Date | null }> {
  const rows = await sql<{ status: string; approved_at: Date | null }[]>`
    select status, approved_at
    from tasks
    where run_id = ${runId}
  `;
  const row = rows[0];
  if (row === undefined || rows.length !== 1) {
    throw new Error("task is missing");
  }
  return row;
}

async function countRuns(): Promise<number> {
  const rows = await sql<{ count: number }[]>`select count(*)::int as count from runs`;
  return requiredCount(rows[0]?.count);
}

async function countTasks(): Promise<number> {
  const rows = await sql<{ count: number }[]>`select count(*)::int as count from tasks`;
  return requiredCount(rows[0]?.count);
}

async function countAgents(): Promise<number> {
  const rows = await sql<{ count: number }[]>`select count(*)::int as count from agents`;
  return requiredCount(rows[0]?.count);
}

function requiredCount(value: number | undefined): number {
  if (value === undefined) {
    throw new Error("count is missing");
  }
  return value;
}

function restoreToken(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.TELEGRAM_BOT_TOKEN;
    return;
  }
  process.env.TELEGRAM_BOT_TOKEN = previous;
}

async function sourceText(relativePath: string): Promise<string> {
  const filePath = fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
  // Фиксированные файлы пакета, не путь модели. Литерал в readFile здесь невозможен.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- аргумент не литерал: это файлы src пакета
  return readFile(filePath, "utf8");
}
