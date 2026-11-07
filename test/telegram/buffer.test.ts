import { describe, expect, it } from "vitest";

import type { FinishOutcome } from "../../src/contracts/types.js";
import { createRunQueue } from "../../src/queue/index.js";
import {
  findExistingRun,
  hasPendingDialog,
  releaseNextBuffered,
  saveDialogMessage,
} from "../../src/telegram/buffer.js";
import { parseDecimalChatId } from "../../src/telegram/chat-id.js";
import {
  BUFFER_BEHIND_TEXT,
  replyForBuffered,
  type RunSnapshot,
  type TelegramUpdateView,
} from "../../src/telegram/decide.js";
import { prepareRunDelivery } from "../../src/telegram/delivery.js";
import { followRun, type DeliveryMemory } from "../../src/telegram/follow.js";
import { handleTelegramUpdate, type TelegramEnqueue } from "../../src/telegram/handle.js";
import { readRunSnapshot } from "../../src/telegram/read-run.js";
import { sql } from "../helpers/db.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const CHAT_ID = "9223372036854775807";
const ALLOWED = ["7"];

describe("dialogBuffer", () => {
  it("должен не создавать вторую строку сразу и создать одну после финиша", async () => {
    const chatId = requiredChat();
    const queue = createRunQueue(sql);
    const enqueue = telegramEnqueue(queue);
    const options = bufferOptions(enqueue);

    const first = await handleTelegramUpdate(textView("первый", "15"), options);
    await handleTelegramUpdate(textView("первый", "15"), options);
    expect(await countRuns()).toBe(1);
    expect(await countBuffer()).toBe(0);
    const liveId = first.followRunId;
    if (liveId === null) {
      throw new Error("live run is missing");
    }

    const second = await handleTelegramUpdate(textView("второй", "16"), options);
    expect(second.text).toBe(replyForBuffered(liveId));
    expect(second.followRunId).toBe(liveId);
    expect(await countRuns()).toBe(1);
    expect(await countBuffer()).toBe(1);

    await handleTelegramUpdate(textView("второй", "16"), options);
    expect(await countRuns()).toBe(1);
    expect(await countBuffer()).toBe(1);

    const storedBuffer = await sql<
      { chat_id: string; message: string; idempotency_key: string }[]
    >`
      select chat_id, message, idempotency_key
      from dialog_buffer
    `;
    expect(storedBuffer[0]?.chat_id).toBe(CHAT_ID);
    expect(typeof storedBuffer[0]?.chat_id).toBe("string");
    expect(storedBuffer[0]?.message).toBe("второй");
    expect(storedBuffer[0]?.idempotency_key).toBe(`tg:${AGENT_ID}:16`);

    expect(await releaseNextBuffered(sql, enqueue, AGENT_ID, chatId)).toBeNull();
    expect(await countRuns()).toBe(1);

    await finishLive(queue);
    const released = await releaseNextBuffered(sql, enqueue, AGENT_ID, chatId);
    if (released === null) {
      throw new Error("buffer did not enqueue");
    }
    expect(released.runId).not.toBe(liveId);
    expect(released.chatId).toBe(CHAT_ID);
    expect(typeof released.chatId).toBe("string");
    expect(await countRuns()).toBe(2);
    expect(await countBuffer()).toBe(0);

    const created = await sql<
      {
        status: string;
        payload: { message: string };
        chat_id: string;
        idempotency_key: string;
      }[]
    >`
      select status, payload, chat_id, idempotency_key
      from runs
      where id = ${released.runId}
    `;
    expect(created[0]?.status).toBe("queued");
    expect(created[0]?.payload).toEqual({ message: "второй" });
    expect(created[0]?.chat_id).toBe(CHAT_ID);
    expect(typeof created[0]?.chat_id).toBe("string");
    expect(created[0]?.idempotency_key).toBe(`tg:${AGENT_ID}:16`);
  });

  it("должен поставить из буфера только одно сообщение за раз", async () => {
    const chatId = requiredChat();
    const queue = createRunQueue(sql);
    const enqueue = telegramEnqueue(queue);
    const options = bufferOptions(enqueue);

    await handleTelegramUpdate(textView("первый", "21"), options);
    await handleTelegramUpdate(textView("второй", "22"), options);
    const third = await handleTelegramUpdate(textView("третий", "23"), options);

    expect(third.text).toBe(BUFFER_BEHIND_TEXT);
    expect(third.followRunId).toBeNull();
    expect(third.wakeBuffer).toBe(true);
    expect(await countRuns()).toBe(1);
    expect(await countBuffer()).toBe(2);

    await finishLive(queue);
    const firstRelease = await releaseNextBuffered(sql, enqueue, AGENT_ID, chatId);
    if (firstRelease === null) {
      throw new Error("first buffered message was not enqueued");
    }
    expect(await countRuns()).toBe(2);
    expect(await countBuffer()).toBe(1);
    expect(await messageOf(firstRelease.runId)).toBe("второй");

    expect(await releaseNextBuffered(sql, enqueue, AGENT_ID, chatId)).toBeNull();
    expect(await countRuns()).toBe(2);

    await finishLive(queue);
    const secondRelease = await releaseNextBuffered(sql, enqueue, AGENT_ID, chatId);
    if (secondRelease === null) {
      throw new Error("second buffered message was not enqueued");
    }
    expect(await countRuns()).toBe(3);
    expect(await countBuffer()).toBe(0);
    expect(await messageOf(secondRelease.runId)).toBe("третий");
  });
});

describe("prepareRunDelivery", () => {
  it("должен не готовить тот же итог второй раз после перезапуска процесса", async () => {
    const queue = createRunQueue(sql);
    const created = await queue.enqueue({
      tenantId: "local",
      agentId: AGENT_ID,
      source: "telegram",
      idempotencyKey: "tg-delivery-once",
      message: "скажи итог",
      chatId: requiredChat(),
    });
    await finishLive(queue);
    const snapshot = await requiredSnapshot(created.run.id);
    expect(snapshot.finalText).toBe("итог");

    const sent: string[] = [];
    const preparedTexts: (string | null)[] = [];
    const prepare = async (run: RunSnapshot): Promise<{ pending: boolean; text: string | null }> => {
      const prepared = await prepareRunDelivery(sql, run);
      preparedTexts.push(prepared.text);
      return prepared;
    };
    const deps = {
      readRun: () => Promise.resolve(snapshot),
      send: (_chatId: string, text: string) => {
        sent.push(text);
        return Promise.resolve();
      },
      sleep: () => Promise.reject(new Error("sleep")),
      now: () => 0,
      isStopped: () => false,
      prepareDelivery: prepare,
    };

    const firstProcess: DeliveryMemory = { sent: new Set() };
    const restartedProcess: DeliveryMemory = { sent: new Set() };
    await followRun(snapshot.id, CHAT_ID, { ...deps, delivery: firstProcess });
    await followRun(snapshot.id, CHAT_ID, { ...deps, delivery: restartedProcess });

    expect(sent).toEqual(["итог"]);
    expect(preparedTexts).toEqual(["итог", null]);
    expect(typeof CHAT_ID).toBe("string");
    const marks = await sql<{ count: number }[]>`
      select count(*)::int as count from run_deliveries
    `;
    expect(marks[0]?.count).toBe(1);
  });

  it("должен не ставить отметку, пока запуск не завершён", async () => {
    const queue = createRunQueue(sql);
    const created = await queue.enqueue({
      tenantId: "local",
      agentId: AGENT_ID,
      source: "telegram",
      idempotencyKey: "tg-delivery-waiting",
      message: "подожди",
      chatId: requiredChat(),
    });
    const snapshot = await requiredSnapshot(created.run.id);
    const prepared = await prepareRunDelivery(sql, snapshot);

    expect(prepared).toEqual({ pending: true, text: null });
    const marks = await sql<{ count: number }[]>`
      select count(*)::int as count from run_deliveries
    `;
    expect(marks[0]?.count).toBe(0);
  });
});

function bufferOptions(enqueue: TelegramEnqueue): {
  allowedUserIds: readonly string[];
  agentId: string;
  enqueue: TelegramEnqueue;
  rememberBusy: (message: {
    tenantId: string;
    agentId: string;
    chatId: bigint;
    idempotencyKey: string;
    message: string;
  }) => Promise<void>;
  hasPendingBuffer: (agentId: string, chatId: bigint) => Promise<boolean>;
  findExistingRun: (agentId: string, idempotencyKey: string) => Promise<string | null>;
} {
  return {
    allowedUserIds: ALLOWED,
    agentId: AGENT_ID,
    enqueue,
    rememberBusy: (message) => saveDialogMessage(sql, message),
    hasPendingBuffer: (agentId, chatId) => hasPendingDialog(sql, agentId, chatId),
    findExistingRun: (agentId, key) => findExistingRun(sql, agentId, key),
  };
}

function telegramEnqueue(queue: ReturnType<typeof createRunQueue>): TelegramEnqueue {
  return async (input) => {
    const result = await queue.enqueue(input);
    return { runId: result.run.id, reason: result.reason };
  };
}

function textView(message: string, updateId: string): TelegramUpdateView {
  return {
    updateId,
    userId: "7",
    chatId: CHAT_ID,
    content: { type: "text", message },
  };
}

function requiredChat(): bigint {
  const chatId = parseDecimalChatId(CHAT_ID);
  if (chatId === null) {
    throw new Error("chat id");
  }
  return chatId;
}

async function finishLive(queue: ReturnType<typeof createRunQueue>): Promise<void> {
  const claimed = await queue.claimNext("buffer-worker", 30);
  if (claimed === null) {
    throw new Error("claim returned no run");
  }
  const finished = await queue.finish(claimed.id, "buffer-worker", succeeded("итог"));
  expect(finished).toBe(true);
}

function succeeded(finalText: string): FinishOutcome {
  return {
    status: "succeeded",
    finalText,
    error: null,
    modelAlias: "agent",
    provider: "local",
    promptTokens: null,
    completionTokens: null,
  };
}

async function requiredSnapshot(runId: string): Promise<RunSnapshot> {
  const snapshot = await readRunSnapshot(sql, runId);
  if (snapshot === null) {
    throw new Error("run snapshot is missing");
  }
  return snapshot;
}

async function messageOf(runId: string): Promise<string> {
  const rows = await sql<{ payload: { message: string } }[]>`
    select payload
    from runs
    where id = ${runId}
  `;
  const payload = rows[0]?.payload;
  if (payload === undefined) {
    throw new Error("run message is missing");
  }
  return payload.message;
}

async function countRuns(): Promise<number> {
  const rows = await sql<{ count: number }[]>`select count(*)::int as count from runs`;
  const count = rows[0]?.count;
  if (count === undefined) {
    throw new Error("count is missing");
  }
  return count;
}

async function countBuffer(): Promise<number> {
  const rows = await sql<{ count: number }[]>`select count(*)::int as count from dialog_buffer`;
  const count = rows[0]?.count;
  if (count === undefined) {
    throw new Error("count is missing");
  }
  return count;
}
