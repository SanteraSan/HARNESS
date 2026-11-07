import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type {
  ChatModel,
  EnqueueInput,
  FinishOutcome,
  ModelOutput,
  NewRunStep,
  RunQueue,
  Runner,
} from "../../src/contracts/index.js";
import { createRunJournal } from "../../src/journal/index.js";
import { createRunQueue } from "../../src/queue/index.js";
import { toolRegistry } from "../../src/tools/index.js";
import {
  bindWorkerSignals,
  loadRunnerAgent,
  runWorker,
  type WorkerLoopOptions,
} from "../../src/worker.js";
import { sql } from "../helpers/db.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const WORKER_ID = "worker-p6";
const SEEDED_PROMPT =
  "Отвечай по результатам инструментов. Не выдумывай содержимое файлов. Инструменты только из списка: read_file и list_dir. Окончательный ответ пиши обычным текстом, без предисловия, без обратных кавычек и без блоков кода.";

const queue = createRunQueue(sql);
const journal = createRunJournal(sql, ["test-secret-value"]);

const model: ChatModel = {
  complete(): Promise<ModelOutput> {
    return Promise.reject(new Error("worker must not call the model"));
  },
};

describe("worker", () => {
  it("должен исполнять две строки очереди строго по одной", async () => {
    const first = await queue.enqueue(enqueueInput("seq-1", { message: "первый", priority: 1 }));
    const second = await queue.enqueue(enqueueInput("seq-2", { message: "второй", priority: 2 }));

    const order: string[] = [];
    let inflight = 0;
    let peak = 0;
    const runner: Runner = {
      async run(claimed, ctx) {
        inflight += 1;
        peak = Math.max(peak, inflight);
        order.push(claimed.id);
        if (claimed.id === first.run.id) {
          const other = await storedRun(second.run.id);
          expect(other.status).toBe("queued");
          expect(other.locked_by).toBeNull();
        }
        await delay(50);
        inflight -= 1;
        await ctx.finish(claimed.id, WORKER_ID, succeeded(claimed.payload.message));
      },
    };

    const { options, sleeps } = withIdle(runner);
    await runWorker(options);

    expect(order).toEqual([first.run.id, second.run.id]);
    expect(peak).toBe(1);
    expect(inflight).toBe(0);
    expect(sleeps).toEqual([1000]);

    const firstRow = await storedRun(first.run.id);
    const secondRow = await storedRun(second.run.id);
    expect(firstRow.status).toBe("succeeded");
    expect(firstRow.final_text).toBe("первый");
    expect(firstRow.attempt).toBe(1);
    expect(secondRow.status).toBe("succeeded");
    expect(secondRow.final_text).toBe("второй");
    expect(secondRow.attempt).toBe(1);
    if (firstRow.finished_at === null || secondRow.started_at === null) {
      throw new Error("run timestamps are missing");
    }
    expect(firstRow.finished_at.getTime()).toBeLessThanOrEqual(secondRow.started_at.getTime());
  });

  it("должен подхватить просроченную строку следующим проходом", async () => {
    const live = await queue.enqueue(enqueueInput("live-1", { message: "живой", priority: 1 }));
    const expired = await queue.enqueue(
      enqueueInput("expired-1", { message: "просрочен", priority: 5 }),
    );
    const liveClaim = await queue.claimNext("worker-stale", 30);
    const expiredClaim = await queue.claimNext("worker-stale", 30);
    expect(liveClaim?.id).toBe(live.run.id);
    expect(expiredClaim?.id).toBe(expired.run.id);
    expect(expiredClaim?.attempt).toBe(1);

    await sql`
      update runs
      set locked_until = now() - interval '1 second'
      where id = ${expired.run.id}
    `;

    const seen: string[] = [];
    const runner: Runner = {
      async run(claimed, ctx) {
        seen.push(claimed.id);
        expect(claimed.attempt).toBe(2);
        expect(claimed.lockedBy).toBe(WORKER_ID);
        expect(claimed.status).toBe("running");
        await ctx.finish(claimed.id, WORKER_ID, succeeded("поднял"));
      },
    };

    const { options, sleeps } = withIdle(runner);
    await runWorker(options);

    expect(seen).toEqual([expired.run.id]);
    expect(sleeps).toEqual([1000]);

    const expiredRow = await storedRun(expired.run.id);
    expect(expiredRow.status).toBe("succeeded");
    expect(expiredRow.attempt).toBe(2);
    expect(expiredRow.locked_by).toBeNull();
    expect(expiredRow.error).toBeNull();
    expect(expiredRow.final_text).toBe("поднял");

    const liveRow = await storedRun(live.run.id);
    expect(liveRow.status).toBe("running");
    expect(liveRow.locked_by).toBe("worker-stale");
    expect(liveRow.attempt).toBe(1);
  });

  it("должен перевести строку в failed и продолжить цикл, если раннер бросил исключение", async () => {
    const boom = await queue.enqueue(enqueueInput("boom-1", { message: "boom", priority: 1 }));
    const next = await queue.enqueue(enqueueInput("boom-2", { message: "next", priority: 2 }));

    let inflight = 0;
    let peak = 0;
    const runner: Runner = {
      async run(claimed, ctx) {
        inflight += 1;
        peak = Math.max(peak, inflight);
        try {
          if (claimed.payload.message === "boom") {
            throw new Error("test-secret-value");
          }
          const failed = await storedRun(boom.run.id);
          expect(failed.status).toBe("failed");
          expect(failed.error).toBe("runner_failed");
          await ctx.finish(claimed.id, WORKER_ID, succeeded("дальше"));
        } finally {
          inflight -= 1;
        }
      },
    };

    const { options, sleeps } = withIdle(runner);
    await expect(runWorker(options)).resolves.toBeUndefined();

    expect(peak).toBe(1);
    expect(sleeps).toEqual([1000]);

    const failed = await storedRun(boom.run.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("runner_failed");
    expect(failed.final_text).toBeNull();
    expect(failed.locked_by).toBeNull();
    expect(failed.finished_at).not.toBeNull();
    expect(await stepCount(boom.run.id)).toBe(0);

    const continued = await storedRun(next.run.id);
    expect(continued.status).toBe("succeeded");
    expect(continued.final_text).toBe("дальше");
  });

  it("должен не ставить успешный статус, если heartbeat потерял лок", async () => {
    const finishes: FinishOutcome["status"][] = [];
    const spied = spyQueue(queue, finishes);
    const created = await spied.enqueue(enqueueInput("lost-1", { message: "лок" }));

    const runner: Runner = {
      async run(claimed, ctx) {
        await sql`
          update runs
          set locked_by = 'intruder'
          where id = ${claimed.id}
        `;
        const alive = await ctx.heartbeat(claimed.id, WORKER_ID, 30);
        expect(alive).toBe(false);
      },
    };

    const { options, sleeps } = withIdle(runner, { queue: spied });
    await runWorker(options);

    expect(finishes).toEqual([]);
    expect(sleeps).toEqual([1000]);
    const row = await storedRun(created.run.id);
    expect(row.status).toBe("running");
    expect(row.locked_by).toBe("intruder");
    expect(row.final_text).toBeNull();
  });

  it("должен не писать шаги после нуля строк heartbeat", async () => {
    const created = await queue.enqueue(enqueueInput("steps-1", { message: "шаги" }));
    const lateKinds = ["final", "tool_call", "tool_result", "parse_error"] as const;
    const runner: Runner = {
      async run(claimed, ctx) {
        await ctx.appendStep(journalStep(claimed.id, "model_request", "до потери"));
        await sql`
          update runs
          set locked_by = 'intruder'
          where id = ${claimed.id}
        `;
        const alive = await ctx.heartbeat(claimed.id, WORKER_ID, 30);
        expect(alive).toBe(false);
        for (const kind of lateKinds) {
          await expect(
            ctx.appendStep(journalStep(claimed.id, kind, "после потери")),
          ).rejects.toMatchObject({ code: "lock_lost" });
        }
        const wrote = await ctx.finish(claimed.id, WORKER_ID, succeeded("нельзя"));
        expect(wrote).toBe(false);
      },
    };

    const { options } = withIdle(runner);
    await runWorker(options);

    const steps = await storedSteps(created.run.id);
    expect(steps).toEqual([
      { kind: "model_request", request_excerpt: "до потери", response_excerpt: "до потери" },
    ]);
    const row = await storedRun(created.run.id);
    expect(row.status).toBe("running");
    expect(row.locked_by).toBe("intruder");
    expect(row.final_text).toBeNull();
  });

  it("должен продлевать аренду таймером, пока запуск идёт", async () => {
    const created = await queue.enqueue(enqueueInput("beat-1", { message: "пульс" }));
    const runner: Runner = {
      async run(claimed, ctx) {
        const before = await lockedUntilText(claimed.id);
        const moved = await waitForLeaseMove(claimed.id, before, 8_000);
        expect(moved).toBe(true);
        await ctx.finish(claimed.id, WORKER_ID, succeeded("жив"));
      },
    };

    const { options } = withIdle(runner, { heartbeatSeconds: 1, leaseSeconds: 30 });
    await runWorker(options);

    const row = await storedRun(created.run.id);
    expect(row.status).toBe("succeeded");
    expect(row.final_text).toBe("жив");
  });

  it("должен оставить успешный финиш, если раннер упал уже после него", async () => {
    const finishes: FinishOutcome["status"][] = [];
    const spied = spyQueue(queue, finishes);
    const created = await spied.enqueue(enqueueInput("after-1", { message: "после" }));
    const runner: Runner = {
      async run(claimed, ctx) {
        await ctx.finish(claimed.id, WORKER_ID, succeeded("готово"));
        throw new Error("late");
      },
    };

    const { options } = withIdle(runner, { queue: spied });
    await runWorker(options);

    expect(finishes).toEqual(["succeeded"]);
    const row = await storedRun(created.run.id);
    expect(row.status).toBe("succeeded");
    expect(row.final_text).toBe("готово");
    expect(row.error).toBeNull();
  });

  it("должен не ставить успешный статус и не брать следующий запуск после остановки", async () => {
    const first = await queue.enqueue(enqueueInput("stop-1", { message: "первый", priority: 1 }));
    const second = await queue.enqueue(enqueueInput("stop-2", { message: "второй", priority: 2 }));

    let release: (() => void) | undefined;
    const releaseRun = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const controller = new AbortController();
    const seen: string[] = [];
    const runner: Runner = {
      async run(claimed) {
        seen.push(claimed.id);
        markStarted?.();
        await releaseRun;
      },
    };

    const pending = runWorker({
      ...baseOptions(runner),
      signal: controller.signal,
      sleep: () => Promise.reject(new Error("idle sleep must not run")),
    });

    await started;
    controller.abort();
    if (release === undefined) {
      throw new Error("release is missing");
    }
    release();
    await pending;

    expect(seen).toEqual([first.run.id]);
    const firstRow = await storedRun(first.run.id);
    expect(firstRow.status).toBe("running");
    expect(firstRow.final_text).toBeNull();
    expect(firstRow.locked_by).toBe(WORKER_ID);
    const secondRow = await storedRun(second.run.id);
    expect(secondRow.status).toBe("queued");
    expect(secondRow.locked_by).toBeNull();
  });

  it("должен не захватывать строку, если остановка уже запрошена", async () => {
    const created = await queue.enqueue(enqueueInput("pre-stop", { message: "жди" }));
    await runWorker({
      ...baseOptions({
        run(): Promise<void> {
          return Promise.reject(new Error("runner must not start"));
        },
      }),
      signal: AbortSignal.abort(),
      sleep: () => Promise.reject(new Error("idle sleep must not run")),
    });

    const row = await storedRun(created.run.id);
    expect(row.status).toBe("queued");
    expect(row.locked_by).toBeNull();
    expect(row.attempt).toBe(0);
  });

  it("должен по сигналу звать остановку один раз и не менять очередь", async () => {
    const created = await queue.enqueue(enqueueInput("sig-1", { message: "сигнал" }));
    let stops = 0;
    const detach = bindWorkerSignals(() => {
      stops += 1;
    });
    try {
      process.emit("SIGTERM");
      process.emit("SIGINT");
    } finally {
      detach();
    }

    expect(stops).toBe(1);
    const row = await storedRun(created.run.id);
    expect(row.status).toBe("queued");
    expect(row.locked_by).toBeNull();
    expect(row.final_text).toBeNull();
  });

  it("должен отказать пустому worker id до захвата", async () => {
    const created = await queue.enqueue(enqueueInput("empty-worker", { message: "нет" }));
    const { options } = withIdle(
      {
        run(): Promise<void> {
          return Promise.reject(new Error("runner must not start"));
        },
      },
      { workerId: " " },
    );

    await expect(runWorker(options)).rejects.toMatchObject({
      name: "WorkerError",
      code: "invalid_worker",
    });
    const row = await storedRun(created.run.id);
    expect(row.status).toBe("queued");
    expect(row.attempt).toBe(0);
  });

  it("должен вызывать захват одним вызовом и не собирать пул", async () => {
    const source = await readFile("src/worker.ts", "utf8");
    expect(source.match(/claimNext\(/g)).toHaveLength(1);
    expect(source.includes("Promise.all")).toBe(false);
    expect(source.includes("grammy")).toBe(false);
    expect(source.includes('status: "succeeded"')).toBe(false);
    expect(source.includes("status: 'succeeded'")).toBe(false);
  });

  it("должен читать агента сида для раннера", async () => {
    const agent = await loadRunnerAgent(sql, AGENT_ID);
    expect(agent.id).toBe(AGENT_ID);
    expect(agent.modelAlias).toBe("agent");
    expect(agent.provider).toBe("local");
    expect(agent.maxSteps).toBe(8);
    expect(agent.systemPrompt).toBe(SEEDED_PROMPT);
    expect(agent.toolAllowlist).toEqual(["read_file", "list_dir"]);
  });

  it("должен отказать, если агент запуска не найден", async () => {
    await expect(
      loadRunnerAgent(sql, "00000000-0000-4000-8000-0000000000aa"),
    ).rejects.toMatchObject({
      name: "WorkerError",
      code: "agent_not_found",
    });
  });
});

function withIdle(
  runner: Runner,
  patch: Partial<Omit<WorkerLoopOptions, "signal" | "sleep" | "runner">> = {},
): { options: WorkerLoopOptions; sleeps: number[] } {
  const sleeps: number[] = [];
  const controller = new AbortController();
  const options: WorkerLoopOptions = {
    ...baseOptions(runner),
    signal: controller.signal,
    sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
      sleeps.push(milliseconds);
      if (!signal.aborted) {
        controller.abort();
      }
      return Promise.resolve();
    },
    ...patch,
  };
  return { options, sleeps };
}

function baseOptions(runner: Runner): WorkerLoopOptions {
  return {
    queue,
    runner,
    journal,
    model,
    tools: toolRegistry,
    workerId: WORKER_ID,
    leaseSeconds: 30,
    heartbeatSeconds: 15,
    signal: AbortSignal.abort(),
  };
}

function spyQueue(real: RunQueue, finishes: FinishOutcome["status"][]): RunQueue {
  return {
    enqueue: (input) => real.enqueue(input),
    claimNext: (workerId, leaseSeconds) => real.claimNext(workerId, leaseSeconds),
    heartbeat: (runId, workerId, leaseSeconds) => real.heartbeat(runId, workerId, leaseSeconds),
    reapExpired: () => real.reapExpired(),
    finish: async (runId, workerId, outcome) => {
      finishes.push(outcome.status);
      return real.finish(runId, workerId, outcome);
    },
  };
}

function enqueueInput(
  idempotencyKey: string,
  overrides: { message?: string; priority?: number } = {},
): EnqueueInput {
  const input: EnqueueInput = {
    tenantId: "local",
    agentId: AGENT_ID,
    source: "api",
    idempotencyKey,
    message: overrides.message ?? "привет",
    chatId: null,
  };
  if (overrides.priority !== undefined) {
    input.priority = overrides.priority;
  }
  return input;
}

function journalStep(runId: string, kind: NewRunStep["kind"], marker: string): NewRunStep {
  return {
    runId,
    kind,
    toolName: kind === "tool_call" || kind === "tool_result" ? "list_dir" : null,
    requestExcerpt: marker,
    responseExcerpt: marker,
    promptTokens: null,
    completionTokens: null,
    error: null,
  };
}

function succeeded(finalText: string): FinishOutcome {
  return {
    status: "succeeded",
    finalText,
    error: null,
    modelAlias: "agent",
    provider: "local",
    promptTokens: 1,
    completionTokens: 1,
  };
}

interface StoredRun {
  status: string;
  attempt: number;
  error: string | null;
  locked_by: string | null;
  final_text: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

async function storedRun(id: string): Promise<StoredRun> {
  const rows = await sql<StoredRun[]>`
    select status, attempt, error, locked_by, final_text, started_at, finished_at
    from runs
    where id = ${id}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("run is missing");
  }
  return row;
}

async function lockedUntilText(id: string): Promise<string> {
  const rows = await sql<{ stamp: string | null }[]>`
    select locked_until::text as stamp
    from runs
    where id = ${id}
  `;
  const stamp = rows[0]?.stamp;
  if (stamp === undefined || stamp === null) {
    throw new Error("locked_until is missing");
  }
  return stamp;
}

async function waitForLeaseMove(id: string, before: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let stamp = before;
  while (stamp === before && Date.now() < deadline) {
    await delay(50);
    stamp = await lockedUntilText(id);
  }
  return stamp !== before;
}

interface StoredStep {
  kind: string;
  request_excerpt: string | null;
  response_excerpt: string | null;
}

async function storedSteps(runId: string): Promise<StoredStep[]> {
  return sql<StoredStep[]>`
    select kind, request_excerpt, response_excerpt
    from run_steps
    where run_id = ${runId}
    order by step_index asc
  `;
}

async function stepCount(runId: string): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    select count(*)::int as count
    from run_steps
    where run_id = ${runId}
  `;
  const count = rows[0]?.count;
  if (count === undefined) {
    throw new Error("count is missing");
  }
  return count;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
