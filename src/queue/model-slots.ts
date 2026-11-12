import type { Sql } from "../db/client.js";
import { QueueError } from "./run-queue.js";

/** Пауза ожидания свободного слота. Модель в ней не вызывается. */
const SLOT_WAIT_MS = 1000;

export interface ModelSlots {
  count(): Promise<number>;
  reapExpired(): Promise<number>;
  claim(workerId: string, runId: string, leaseSeconds: number): Promise<number | null>;
  heartbeat(
    slotIndex: number,
    workerId: string,
    runId: string,
    leaseSeconds: number,
  ): Promise<boolean>;
  release(slotIndex: number, workerId: string, runId: string): Promise<boolean>;
}

export interface AcquiredSlot {
  slotIndex: number;
}

export interface AcquireModelSlotInput {
  slots: ModelSlots;
  workerId: string;
  runId: string;
  leaseSeconds: number;
  signal: AbortSignal;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  heartbeatRun: (runId: string, workerId: string, leaseSeconds: number) => Promise<boolean>;
}

/**
 * Слот — строка model_slots. Клиент модели этот модуль не импортирует.
 * Захват и снятие — короткие операторы, now() Postgres, без второй пула.
 */
export function createModelSlots(sql: Sql): ModelSlots {
  return {
    count() {
      return countModelSlots(sql);
    },
    reapExpired() {
      return reapExpiredSlots(sql);
    },
    claim(workerId, runId, leaseSeconds) {
      return claimModelSlot(sql, workerId, runId, leaseSeconds);
    },
    heartbeat(slotIndex, workerId, runId, leaseSeconds) {
      return heartbeatModelSlot(sql, slotIndex, workerId, runId, leaseSeconds);
    },
    release(slotIndex, workerId, runId) {
      return releaseModelSlot(sql, slotIndex, workerId, runId);
    },
  };
}

/**
 * Каждый круг сначала снимает просроченные слоты мёртвых владельцев, потом берёт строку.
 * Пауза не держит транзакцию. Модель отсюда не вызывается.
 * Нет строки — heartbeat запуска; false значит, что лок запуска потерян.
 */
export async function acquireModelSlot(
  input: AcquireModelSlotInput,
): Promise<AcquiredSlot | "lock_lost" | "stopped"> {
  for (;;) {
    if (input.signal.aborted) {
      return "stopped";
    }
    // Короткий UPDATE отдельно от захвата и не во время вызова модели.
    await input.slots.reapExpired();
    const slotIndex = await input.slots.claim(input.workerId, input.runId, input.leaseSeconds);
    if (slotIndex !== null) {
      return { slotIndex };
    }
    const alive = await input.heartbeatRun(input.runId, input.workerId, input.leaseSeconds);
    if (!alive) {
      return "lock_lost";
    }
    await input.sleep(SLOT_WAIT_MS, input.signal);
  }
}

async function countModelSlots(sql: Sql): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    select count(*)::int as count from model_slots
  `;
  return requireSlotCount(rows[0]?.count);
}

/**
 * Просроченный слот снимается отдельным UPDATE и runs не меняет.
 * Живой лок запуска слот не отдаёт: иначе второй вызов начнётся,
 * пока первый ещё в модели. Потеря лока — не running, другой locked_by
 * или locked_until запуска раньше now().
 */
async function reapExpiredSlots(sql: Sql): Promise<number> {
  const updated = await sql`
    update model_slots as slot
    set locked_by = null,
        locked_until = null,
        run_id = null
    where slot.locked_until is not null
      and slot.locked_until < now()
      and not exists (
        select 1
        from runs
        where runs.id = slot.run_id
          and runs.status = 'running'
          and runs.locked_by = slot.locked_by
          and runs.locked_until is not null
          and runs.locked_until >= now()
      )
  `;
  return requireSlotCount(updated.count);
}

/**
 * Один UPDATE. FOR UPDATE SKIP LOCKED внутри него, не отдельным чтением.
 * Соединение отпускается вместе с оператором, до вызова модели.
 */
async function claimModelSlot(
  sql: Sql,
  workerId: string,
  runId: string,
  leaseSeconds: number,
): Promise<number | null> {
  const rows = await sql<{ slot_index: number }[]>`
    update model_slots
    set locked_by = ${workerId},
        locked_until = now() + make_interval(secs => ${leaseSeconds}),
        run_id = ${runId}
    where slot_index = (
      select slot_index
      from model_slots
      where locked_by is null
      order by slot_index
      for update skip locked
      limit 1
    )
    returning slot_index
  `;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return requireSlotIndex(row.slot_index);
}

/** Ноль строк — слот уже не наш. Чужой locked_by срок не двигает. */
async function heartbeatModelSlot(
  sql: Sql,
  slotIndex: number,
  workerId: string,
  runId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const updated = await sql<{ slot_index: number }[]>`
    update model_slots
    set locked_until = now() + make_interval(secs => ${leaseSeconds})
    where slot_index = ${slotIndex}
      and locked_by = ${workerId}
      and run_id = ${runId}
      and locked_by is not null
    returning slot_index
  `;
  return updated.length === 1;
}

/**
 * Отпускание не ставит запуску succeeded и runs не трогает.
 * Ноль строк — слот уже не наш.
 */
async function releaseModelSlot(
  sql: Sql,
  slotIndex: number,
  workerId: string,
  runId: string,
): Promise<boolean> {
  const updated = await sql<{ slot_index: number }[]>`
    update model_slots
    set locked_by = null,
        locked_until = null,
        run_id = null
    where slot_index = ${slotIndex}
      and locked_by = ${workerId}
      and run_id = ${runId}
      and locked_by is not null
    returning slot_index
  `;
  return updated.length === 1;
}

function requireSlotCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new QueueError("invalid_slot", "slot count is invalid");
  }
  return value;
}

function requireSlotIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new QueueError("invalid_slot", "slot index is invalid");
  }
  return value;
}
