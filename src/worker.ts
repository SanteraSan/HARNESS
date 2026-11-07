import { mkdir } from "node:fs/promises";
import path from "node:path";

import { errorCode, isMainModule, loadConfig, logger } from "./config.js";
import type { Config } from "./config.js";
import type {
  ChatModel,
  ClaimedRun,
  FinishOutcome,
  Provider,
  RunQueue,
  Runner,
  RunnerContext,
  Tool,
} from "./contracts/index.js";
import { createSql, type Sql } from "./db/client.js";
import { createDelegationTools } from "./delegation/index.js";
import { createRunJournal, type RunJournal } from "./journal/index.js";
import { LiteLLMChatModel, collectSecrets } from "./model/index.js";
import { createRunQueue } from "./queue/index.js";
import { OpenAICompatRunner, type RunnerAgent } from "./runner/index.js";
import { toolRegistry } from "./tools/index.js";

/** Пустая очередь: одна секунда, затем снова reap и один захват. */
const IDLE_POLL_MS = 1000;

/** setInterval принимает задержку не больше 32-битного знакового целого. */
const MAX_TIMER_MS = 2_147_483_647;

const RUNNER_FAILED = "runner_failed";

/**
 * Один процесс — один текущий запуск.
 * Итерация делает reap, затем один захват. Второй не начинается, пока Runner не вернулся.
 * Сигнал не ставит успешный статус: процесс выходит, аренду снимет следующий reap.
 */
export interface WorkerLoopOptions {
  queue: RunQueue;
  runner: Runner;
  journal: RunJournal;
  model: ChatModel;
  tools: readonly Tool[];
  workerId: string;
  leaseSeconds: number;
  heartbeatSeconds: number;
  signal: AbortSignal;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class WorkerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkerError";
    this.code = code;
  }
}

interface LockGate {
  held: boolean;
  active: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
}

type IdleSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

/**
 * Цикл воркера. claim внутри итерации один: параллельного захвата в этом файле нет.
 * Пул воркеров не создаётся.
 */
export async function runWorker(options: WorkerLoopOptions): Promise<void> {
  assertLoopOptions(options);
  const sleep = options.sleep ?? sleepForIdle;
  let again = true;
  while (again) {
    // I13: следующая итерация только после возврата этой. Второй запуск не стартует раньше.
    again = await runIteration(options, sleep);
  }
}

/**
 * Агент читается на каждый запуск: в захваченной строке есть только agentId.
 * Промпт и allowlist лежат на строке агента, их забирает OpenAICompatRunner.
 */
export async function loadRunnerAgent(sql: Sql, agentId: string): Promise<RunnerAgent> {
  const rows = await sql<Record<string, unknown>[]>`
    select id, system_prompt, model_alias, provider, max_steps, tool_allowlist
    from agents
    where id = ${agentId}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new WorkerError("agent_not_found", "agent does not exist");
  }
  if (rows.length !== 1) {
    throw new WorkerError("invalid_agent", "agent row is ambiguous");
  }

  const id = requireText(row.id);
  if (id !== agentId) {
    throw new WorkerError("agent_mismatch", "agent does not match the run");
  }
  return {
    id,
    systemPrompt: requireText(row.system_prompt),
    modelAlias: requireText(row.model_alias),
    provider: requireProvider(row.provider),
    maxSteps: requireMaxSteps(row.max_steps),
    toolAllowlist: requireStringArray(row.tool_allowlist),
  };
}

/**
 * Слушатели сигнала только зовут stop.
 * finish отсюда не вызывается: успешный статус обработчик не ставит.
 */
export function bindWorkerSignals(stop: () => void): () => void {
  let stopped = false;
  const halt = (signal: "SIGINT" | "SIGTERM"): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    logger.info({ signal }, "worker shutting down");
    stop();
  };
  const onSigint = (): void => {
    halt("SIGINT");
  };
  const onSigterm = (): void => {
    halt("SIGTERM");
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

async function runIteration(options: WorkerLoopOptions, sleep: IdleSleep): Promise<boolean> {
  if (options.signal.aborted) {
    return false;
  }

  await options.queue.reapExpired();
  if (options.signal.aborted) {
    return false;
  }

  const claimed = await options.queue.claimNext(options.workerId, options.leaseSeconds);
  if (claimed === null) {
    await sleep(IDLE_POLL_MS, options.signal);
    return !options.signal.aborted;
  }
  if (options.signal.aborted) {
    // Захват успел пройти в момент остановки. Runner не стартует и статус не пишется.
    logger.warn({ run_id: claimed.id }, "shutdown left run locked");
    return false;
  }

  logger.info({ run_id: claimed.id }, "run claimed");
  await runClaimed(options, claimed);
  return !options.signal.aborted;
}

async function runClaimed(options: WorkerLoopOptions, claimed: ClaimedRun): Promise<void> {
  const gate: LockGate = { held: true, active: true, timer: undefined };
  const timer = setInterval(() => {
    pulse(options, claimed.id, gate);
  }, heartbeatDelayMs(options.heartbeatSeconds));
  timer.unref();
  gate.timer = timer;

  try {
    await options.runner.run(claimed, runnerContext(options, gate));
  } catch (error: unknown) {
    logger.error({ run_id: claimed.id, err: error }, "runner failed");
    await failOwnedRun(options, claimed.id, gate);
  } finally {
    gate.active = false;
    if (gate.timer !== undefined) {
      clearInterval(gate.timer);
      gate.timer = undefined;
    }
  }
}

function runnerContext(options: WorkerLoopOptions, gate: LockGate): RunnerContext {
  return {
    workerId: options.workerId,
    leaseSeconds: options.leaseSeconds,
    model: options.model,
    tools: options.tools,
    heartbeat(runId, workerId, leaseSeconds) {
      return options.queue.heartbeat(runId, workerId, leaseSeconds).then((alive) => {
        if (!alive) {
          markLockLost(runId, gate);
        }
        return alive;
      });
    },
    finish(runId, workerId, outcome) {
      // I7: лок уже чужой. Очередь не зовём, succeeded отсюда не ставится.
      if (!gate.held) {
        return Promise.resolve(false);
      }
      return options.queue.finish(runId, workerId, outcome);
    },
    async appendStep(step) {
      // I7: ноль строк heartbeat — новые шаги не пишем, в том числе после ответа модели.
      if (!gate.held) {
        throw new WorkerError("lock_lost", "lock lost");
      }
      const alive = await options.queue.heartbeat(
        step.runId,
        options.workerId,
        options.leaseSeconds,
      );
      if (!alive || !gate.held) {
        markLockLost(step.runId, gate);
        throw new WorkerError("lock_lost", "lock lost");
      }
      await options.journal.appendStep(step);
    },
  };
}

function pulse(options: WorkerLoopOptions, runId: string, gate: LockGate): void {
  void options.queue.heartbeat(runId, options.workerId, options.leaseSeconds).then(
    (alive) => {
      if (!gate.active) {
        return;
      }
      if (!alive) {
        markLockLost(runId, gate);
      }
    },
    (error: unknown) => {
      logger.error({ run_id: runId, err: error }, "heartbeat failed");
    },
  );
}

/**
 * I7: исключение раннера переводит строку в failed только пока лок наш.
 * Ноль строк heartbeat — лок потерян: succeeded не ставим и новые шаги не пишем.
 */
async function failOwnedRun(
  options: WorkerLoopOptions,
  runId: string,
  gate: LockGate,
): Promise<void> {
  if (!gate.held) {
    return;
  }

  let alive = false;
  try {
    alive = await options.queue.heartbeat(runId, options.workerId, options.leaseSeconds);
  } catch (error: unknown) {
    logger.error({ run_id: runId, err: error }, "heartbeat failed");
    return;
  }
  if (!alive) {
    markLockLost(runId, gate);
    return;
  }

  try {
    const wrote = await options.queue.finish(runId, options.workerId, failedOutcome());
    if (!wrote) {
      markLockLost(runId, gate);
    }
  } catch (error: unknown) {
    logger.error({ run_id: runId, err: error }, "runner failure was not recorded");
  }
}

function markLockLost(runId: string, gate: LockGate): void {
  if (!gate.active || !gate.held) {
    return;
  }
  gate.held = false;
  if (gate.timer !== undefined) {
    clearInterval(gate.timer);
    gate.timer = undefined;
  }
  logger.warn({ run_id: runId }, "lock lost");
}

function failedOutcome(): FinishOutcome {
  return {
    status: "failed",
    finalText: null,
    error: RUNNER_FAILED,
    modelAlias: null,
    provider: null,
    promptTokens: null,
    completionTokens: null,
  };
}

function assertLoopOptions(options: WorkerLoopOptions): void {
  if (options.workerId.trim().length === 0) {
    throw new WorkerError("invalid_worker", "worker id is empty");
  }
  if (!Number.isSafeInteger(options.leaseSeconds) || options.leaseSeconds <= 0) {
    throw new WorkerError("invalid_lease", "lease is invalid");
  }
  heartbeatDelayMs(options.heartbeatSeconds);
}

function heartbeatDelayMs(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new WorkerError("invalid_heartbeat", "heartbeat is invalid");
  }
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > MAX_TIMER_MS) {
    throw new WorkerError("invalid_heartbeat", "heartbeat is invalid");
  }
  return milliseconds;
}

function sleepForIdle(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) {
      finish();
    }
  });
}

function requireText(value: unknown): string {
  if (typeof value !== "string") {
    throw new WorkerError("invalid_agent", "agent column is invalid");
  }
  return value;
}

function requireProvider(value: unknown): Provider {
  if (value === "local" || value === "external") {
    return value;
  }
  throw new WorkerError("invalid_agent", "agent provider is invalid");
}

function requireMaxSteps(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 16) {
    throw new WorkerError("invalid_agent", "agent max steps is invalid");
  }
  return value;
}

function requireStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new WorkerError("invalid_agent", "agent allowlist is invalid");
  }
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new WorkerError("invalid_agent", "agent allowlist is invalid");
    }
    names.push(item);
  }
  return names;
}

function workerLoopOptions(config: Config, sql: Sql, signal: AbortSignal): WorkerLoopOptions {
  const secrets = collectSecrets({
    databaseUrl: config.databaseUrl,
    harnessTestDatabaseUrl: config.harnessTestDatabaseUrl,
    litellmApiKey: config.litellmApiKey,
    harnessApiToken: config.harnessApiToken,
    telegramBotToken: config.telegramBotToken,
  });
  // Одна очередь процесса: дочерняя строка ждёт следующий захват этого воркера.
  const queue = createRunQueue(sql);
  const delegation = createDelegationTools({ sql, queue });
  return {
    queue,
    journal: createRunJournal(sql, secrets),
    model: new LiteLLMChatModel({
      baseUrl: config.litellmBaseUrl,
      apiKey: config.litellmApiKey,
      secrets,
    }),
    runner: new OpenAICompatRunner({
      loadAgent(agentId: string): Promise<RunnerAgent> {
        return loadRunnerAgent(sql, agentId);
      },
      fileRoot: config.fileRoot,
      secrets,
      // Тот же пул процесса: правила и cost_usd не открывают второе соединение.
      sql,
    }),
    // Allowlist агента по-прежнему решает, попадут ли эти имена в ход модели.
    tools: [...toolRegistry, delegation.createSubtask, delegation.approve],
    workerId: config.workerId,
    leaseSeconds: config.leaseSeconds,
    heartbeatSeconds: config.heartbeatSeconds,
    signal,
  };
}

async function ensureFileRoot(fileRoot: string): Promise<void> {
  if (fileRoot.trim().length === 0) {
    throw new WorkerError("invalid_file_root", "file root is empty");
  }
  const root = path.resolve(fileRoot);
  // Корень задаёт конфигурация процесса. Текст модели сюда не приходит.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- FILE_ROOT из конфига
  await mkdir(root, { recursive: true });
}

function installProcessGuards(): void {
  process.on("uncaughtException", (error: unknown) => {
    logger.error({ err: error }, "uncaught exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error({ err: reason }, "unhandled rejection");
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const sql = createSql(config.databaseUrl);
  await ensureFileRoot(config.fileRoot);
  const stop = new AbortController();
  // Сигнал не вызывает finish. Процесс выходит, строку вернёт reap по аренде.
  bindWorkerSignals(() => {
    stop.abort();
    process.exit(0);
  });
  installProcessGuards();
  logger.info({ worker_id: config.workerId }, "worker started");
  try {
    await runWorker(workerLoopOptions(config, sql, stop.signal));
  } finally {
    await sql.end({ timeout: 5 });
  }
  logger.info({ worker_id: config.workerId }, "worker stopped");
}

if (isMainModule(import.meta.url)) {
  void main().catch((error: unknown) => {
    logger.error({ code: errorCode(error) }, "worker failed");
    process.exit(1);
  });
}
