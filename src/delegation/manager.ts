import { z } from "zod";

import type { RunQueue, Tool, ToolContext, ToolOutcome } from "../contracts/types.js";
import type { Sql } from "../db/client.js";
import { runTool } from "../tools/run.js";

/** Как у payload постановки: длиннее раннер всё равно не примет. */
const MESSAGE_MAX = 8000;

/**
 * Глубина 1 — запуск без родителя. Глубина 2 — его ребёнок.
 * Ребёнок снова вызвать create_subtask не может: сверх потолка строка не создаётся.
 */
export const MAX_DELEGATION_DEPTH = 2;

/** Сколько дочерних строк может поставить один parent_run_id. */
export const MAX_CHILDREN_PER_PARENT = 8;

const KEY_MAX = 256;

const createSubtaskParameters = z
  .object({
    message: z.string().min(1).max(MESSAGE_MAX).describe("Текст дочернего запуска"),
    idempotency_key: z
      .string()
      .min(1)
      .max(KEY_MAX)
      .describe("Ключ идемпотентности: повтор возвращает тот же запуск"),
  })
  .strict();

const approveParameters = z.object({}).strict();

/**
 * Очередь и база. Токена бота и клиента модели здесь нет:
 * менеджер не получает сырой токен, approve модель не вызывает.
 */
export interface DelegationDeps {
  sql: Sql;
  queue: RunQueue;
}

export interface DelegationTools {
  createSubtask: Tool;
  approve: Tool;
}

interface SubtaskRequest {
  message: string;
  idempotencyKey: string;
}

interface ParentRun {
  tenantId: string;
  agentId: string;
  taskStatus: "open" | "approved" | null;
}

type TaskStatus = "open" | "approved";

/**
 * Инструменты менеджера. Дочерний запуск — строка той же очереди.
 * Процесс воркера не порождается: следующий захват заберёт её сам.
 */
export function createDelegationTools(deps: DelegationDeps): DelegationTools {
  return {
    createSubtask: {
      name: "create_subtask",
      description:
        "Ставит дочерний запуск в общую очередь с parent_run_id и source = delegation. Отдельный процесс не создаётся.",
      effect: "write",
      parameters: createSubtaskParameters,
      execute(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
        const parsed = createSubtaskParameters.safeParse(args);
        if (!parsed.success) {
          return Promise.resolve(failed("invalid arguments"));
        }
        const request: SubtaskRequest = {
          message: parsed.data.message,
          idempotencyKey: parsed.data.idempotency_key,
        };
        return runTool(ctx, "create_subtask", () => createSubtask(deps, ctx, request));
      },
    },
    approve: {
      name: "approve",
      description:
        "Переводит задачу родительского запуска в approved. Модель и токен бота не используются.",
      effect: "write",
      parameters: approveParameters,
      execute(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
        if (!approveParameters.safeParse(args).success) {
          return Promise.resolve(failed("invalid arguments"));
        }
        return runTool(ctx, "approve", () => approveParent(deps.sql, ctx));
      },
    },
  };
}

async function createSubtask(
  deps: DelegationDeps,
  ctx: ToolContext,
  request: SubtaskRequest,
): Promise<ToolOutcome> {
  const parent = await readParent(deps.sql, ctx.runId, ctx.agentId);
  if (parent === null) {
    return failed("not allowed");
  }
  if (parent.taskStatus === "approved") {
    return failed("task is approved");
  }
  const depth = await delegationDepth(deps.sql, ctx.runId);
  if (depth >= MAX_DELEGATION_DEPTH) {
    return failed("delegation depth");
  }
  const children = await childCount(deps.sql, ctx.runId);
  if (children >= MAX_CHILDREN_PER_PARENT) {
    return failed("delegation fanout");
  }

  const result = await deps.queue.enqueue({
    tenantId: parent.tenantId,
    agentId: parent.agentId,
    source: "delegation",
    idempotencyKey: request.idempotencyKey,
    message: request.message,
    chatId: null,
    parentRunId: ctx.runId,
  });

  // Чужой ключ и живой диалог не становятся дочерним запуском и не отдают его текст.
  if (
    result.reason === "dialog_busy" ||
    result.run.id === ctx.runId ||
    result.run.parentRunId !== ctx.runId
  ) {
    return failed("not allowed");
  }

  await ensureOpenTask(deps.sql, parent, ctx.runId);
  return done(`queued ${result.run.id}`);
}

/**
 * Только статус задачи родителя. Запуск, модель и токен бота не читаются.
 * Повтор не сдвигает approved_at: переход уже записан.
 */
async function approveParent(sql: Sql, ctx: ToolContext): Promise<ToolOutcome> {
  const updated = await sql<{ id: string }[]>`
    update tasks
    set status = 'approved',
        approved_at = now()
    where run_id = ${ctx.runId}
      and agent_id = ${ctx.agentId}
      and status = 'open'
    returning id
  `;
  if (updated.length === 1) {
    return done("approved");
  }

  const existing = await sql<{ status: string }[]>`
    select status
    from tasks
    where run_id = ${ctx.runId}
      and agent_id = ${ctx.agentId}
  `;
  const status = existing.length === 1 ? taskStatus(existing[0]?.status) : null;
  if (status === "approved") {
    return done("approved");
  }
  return failed("task is missing");
}

async function delegationDepth(sql: Sql, runId: string): Promise<number> {
  let depth = 1;
  let current: string | null = runId;
  const seen = new Set<string>();
  while (current !== null && depth <= MAX_DELEGATION_DEPTH) {
    if (seen.has(current)) {
      return MAX_DELEGATION_DEPTH + 1;
    }
    seen.add(current);
    const id: string = current;
    const rows: { parent_run_id: string | null }[] = await sql<{ parent_run_id: string | null }[]>`
      select parent_run_id
      from runs
      where id = ${id}
    `;
    const parent: { parent_run_id: string | null } | undefined = rows[0];
    const parentId: string | null = parent?.parent_run_id ?? null;
    if (parentId === null) {
      return depth;
    }
    depth += 1;
    current = parentId;
  }
  return depth;
}

async function childCount(sql: Sql, runId: string): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    select count(*)::int as count
    from runs
    where parent_run_id = ${runId}
  `;
  const count = rows[0]?.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    return MAX_CHILDREN_PER_PARENT;
  }
  return count;
}

async function readParent(sql: Sql, runId: string, agentId: string): Promise<ParentRun | null> {
  const runs = await sql<{ tenant_id: string; agent_id: string }[]>`
    select tenant_id, agent_id
    from runs
    where id = ${runId}
      and agent_id = ${agentId}
  `;
  const run = runs[0];
  if (run === undefined || runs.length !== 1) {
    return null;
  }

  const tasks = await sql<{ status: string }[]>`
    select status
    from tasks
    where run_id = ${runId}
      and agent_id = ${agentId}
  `;
  const row = tasks[0];
  if (row === undefined) {
    return {
      tenantId: run.tenant_id,
      agentId: run.agent_id,
      taskStatus: null,
    };
  }
  if (tasks.length !== 1) {
    return null;
  }
  const status = taskStatus(row.status);
  if (status === null) {
    return null;
  }
  return {
    tenantId: run.tenant_id,
    agentId: run.agent_id,
    taskStatus: status,
  };
}

async function ensureOpenTask(sql: Sql, parent: ParentRun, runId: string): Promise<void> {
  await sql`
    insert into tasks (tenant_id, agent_id, run_id, status)
    values (${parent.tenantId}, ${parent.agentId}, ${runId}, 'open')
    on conflict (run_id) do nothing
  `;
}

function taskStatus(value: unknown): TaskStatus | null {
  if (value === "open" || value === "approved") {
    return value;
  }
  return null;
}

function done(text: string): ToolOutcome {
  return { ok: true, text, truncated: false, entries: null };
}

function failed(error: string): ToolOutcome {
  return { ok: false, error };
}
