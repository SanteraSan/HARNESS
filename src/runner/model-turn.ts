import { logger } from "../config.js";
import { acquireModelSlot, type ModelSlots } from "../queue/model-slots.js";

/** setInterval принимает задержку не больше 32-битного знакового целого. */
const MAX_TIMER_MS = 2_147_483_647;

export class ModelTurnError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModelTurnError";
    this.code = code;
  }
}

export interface ModelTurnOptions {
  slots: ModelSlots;
  heartbeatSeconds: number;
  signal: AbortSignal;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface TurnGate {
  active: boolean;
  runLost: boolean;
  slotLost: boolean;
  released: boolean;
}

export type ModelTurnResult<T> = { ok: true; value: T } | { ok: false };

/**
 * Ход модели держит слот до записи сумм токенов либо до потери лока запуска.
 * Отпускание — короткий UPDATE до разбора инструментов и до HTTP сервиса.
 * Нет слота в опциях — вызов идёт как раньше: тесты без таблицы слотов.
 */
export async function runModelTurn<T>(args: {
  turn: ModelTurnOptions | null;
  runId: string;
  workerId: string;
  leaseSeconds: number;
  heartbeatRun: (runId: string, workerId: string, leaseSeconds: number) => Promise<boolean>;
  onSlotLost: (slotIndex: number) => Promise<void>;
  call: () => Promise<T>;
  afterHeld: (value: T) => Promise<void>;
}): Promise<ModelTurnResult<T>> {
  if (args.turn === null) {
    const value = await args.call();
    await args.afterHeld(value);
    return { ok: true, value };
  }

  const delay = slotHeartbeatDelay(args.turn.heartbeatSeconds);
  const waited = await acquireModelSlot({
    slots: args.turn.slots,
    workerId: args.workerId,
    runId: args.runId,
    leaseSeconds: args.leaseSeconds,
    signal: args.turn.signal,
    sleep: args.turn.sleep,
    heartbeatRun: args.heartbeatRun,
  });
  if (waited === "lock_lost" || waited === "stopped") {
    return { ok: false };
  }

  const slotIndex = waited.slotIndex;
  const turn = args.turn;
  const gate: TurnGate = { active: true, runLost: false, slotLost: false, released: false };
  const timer = setInterval(() => {
    pulseSlot(turn, args, slotIndex, gate);
  }, delay);
  timer.unref();

  try {
    const value = await args.call();
    gate.active = false;
    clearInterval(timer);
    if (gate.runLost) {
      return { ok: false };
    }
    const runAlive = await args.heartbeatRun(args.runId, args.workerId, args.leaseSeconds);
    if (!runAlive || gate.runLost) {
      return { ok: false };
    }
    const slotAlive =
      !gate.slotLost &&
      (await turn.slots.heartbeat(slotIndex, args.workerId, args.runId, args.leaseSeconds));
    if (!slotAlive) {
      logger.warn({ run_id: args.runId, slot_index: slotIndex, code: "slot_lost" }, "slot lost");
      await args.onSlotLost(slotIndex);
      return { ok: false };
    }
    await args.afterHeld(value);
    const freed = await turn.slots.release(slotIndex, args.workerId, args.runId);
    gate.released = true;
    if (!freed) {
      logger.warn({ run_id: args.runId, slot_index: slotIndex, code: "slot_lost" }, "slot lost");
      await args.onSlotLost(slotIndex);
      return { ok: false };
    }
    return { ok: true, value };
  } finally {
    gate.active = false;
    clearInterval(timer);
    if (!gate.released) {
      await turn.slots.release(slotIndex, args.workerId, args.runId);
      gate.released = true;
    }
  }
}

function pulseSlot(
  turn: ModelTurnOptions,
  args: {
    runId: string;
    workerId: string;
    leaseSeconds: number;
    heartbeatRun: (runId: string, workerId: string, leaseSeconds: number) => Promise<boolean>;
  },
  slotIndex: number,
  gate: TurnGate,
): void {
  void touchSlot(turn, args, slotIndex, gate).catch((error: unknown) => {
    logger.error(
      { run_id: args.runId, slot_index: slotIndex, err: error },
      "slot heartbeat failed",
    );
  });
}

/**
 * Потеря лока запуска отпускает слот сразу, коротким UPDATE.
 * Пока лок жив, heartbeat только продлевает аренду и второй вызов слот не берёт.
 */
async function touchSlot(
  turn: ModelTurnOptions,
  args: {
    runId: string;
    workerId: string;
    leaseSeconds: number;
    heartbeatRun: (runId: string, workerId: string, leaseSeconds: number) => Promise<boolean>;
  },
  slotIndex: number,
  gate: TurnGate,
): Promise<void> {
  const runAlive = await args.heartbeatRun(args.runId, args.workerId, args.leaseSeconds);
  if (!gate.active) {
    return;
  }
  if (!runAlive) {
    gate.runLost = true;
    const freed = await turn.slots.release(slotIndex, args.workerId, args.runId);
    if (freed) {
      gate.released = true;
    }
    return;
  }
  const slotAlive = await turn.slots.heartbeat(
    slotIndex,
    args.workerId,
    args.runId,
    args.leaseSeconds,
  );
  if (!gate.active) {
    return;
  }
  if (!slotAlive) {
    gate.slotLost = true;
  }
}

function slotHeartbeatDelay(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new ModelTurnError("invalid_heartbeat", "heartbeat is invalid");
  }
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > MAX_TIMER_MS) {
    throw new ModelTurnError("invalid_heartbeat", "heartbeat is invalid");
  }
  return milliseconds;
}
