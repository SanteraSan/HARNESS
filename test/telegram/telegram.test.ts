import { describe, expect, it } from "vitest";

import type { EnqueueInput } from "../../src/contracts/types.js";
import { createTelegramBot } from "../../src/telegram/bot.js";
import type { DialogMessage } from "../../src/telegram/buffer.js";
import {
  BUFFER_BEHIND_TEXT,
  INVALID_UPDATE_TEXT,
  MESSAGE_LIMIT,
  POLL_LIMIT_MS,
  partsFromMessage,
  pollOutgoing,
  pollStep,
  replyForBuffered,
  viewFromParts,
  type RunSnapshot,
  type TelegramUpdateView,
} from "../../src/telegram/decide.js";
import { followRun, type DeliveryMemory } from "../../src/telegram/follow.js";
import {
  handleTelegramUpdate,
  type TelegramEnqueue,
  type TelegramEnqueueResult,
} from "../../src/telegram/handle.js";

const BOT_TOKEN = "test-secret-value";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const LIVE_RUN_ID = "00000000-0000-4000-8000-000000000099";
const CREATED_RUN_ID = "00000000-0000-4000-8000-000000000010";
const CHAT_ID = "9223372036854775807";
const ALLOWED = ["7"];

describe("handleTelegramUpdate", () => {
  it("должен отказать чужому user id и не звать enqueue", async () => {
    const recorded = recordingEnqueue({ runId: CREATED_RUN_ID, reason: "created" });
    const result = await handleTelegramUpdate(textView("привет", "8"), {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
    });

    expect(recorded.calls).toEqual([]);
    expect(result.text).toBe("Нет доступа.");
    expect(result.followRunId).toBeNull();
  });

  it("должен на файл и стикер не звать enqueue", async () => {
    const recorded = recordingEnqueue({ runId: CREATED_RUN_ID, reason: "created" });
    const file = requireView(
      viewFromParts(
        partsFromMessage(9, {
          chat: { id: 10 },
          from: { id: 7 },
          document: { file_id: "doc" },
          text: "подпись",
        }),
      ),
    );
    const sticker = requireView(
      viewFromParts(
        partsFromMessage(10, {
          chat: { id: 10 },
          from: { id: 7 },
          sticker: { file_id: "sticker" },
        }),
      ),
    );

    const fileResult = await handleTelegramUpdate(file, {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
    });
    const stickerResult = await handleTelegramUpdate(sticker, {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
    });

    expect(file.content).toEqual({ type: "file" });
    expect(sticker.content).toEqual({ type: "file" });
    expect(recorded.calls).toEqual([]);
    expect(fileResult.text).toBe("В этом срезе принимается только текст.");
    expect(stickerResult.text).toBe("В этом срезе принимается только текст.");
  });

  it("должен пропустить служебное сообщение без текста и без файла", async () => {
    const recorded = recordingEnqueue({ runId: CREATED_RUN_ID, reason: "created" });
    const service = requireView(
      viewFromParts(
        partsFromMessage(11, {
          chat: { id: 10 },
          from: { id: 7 },
        }),
      ),
    );
    const result = await handleTelegramUpdate(service, {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
    });

    expect(service.content).toEqual({ type: "none" });
    expect(recorded.calls).toEqual([]);
    expect(result.text).toBeNull();
  });

  it("должен на пустой текст не звать enqueue", async () => {
    const recorded = recordingEnqueue({ runId: CREATED_RUN_ID, reason: "created" });
    const blank = requireView(
      viewFromParts(
        partsFromMessage(4, {
          chat: { id: 10 },
          from: { id: 7 },
          text: "   ",
        }),
      ),
    );
    const result = await handleTelegramUpdate(blank, {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
    });

    expect(recorded.calls).toEqual([]);
    expect(result.text).toBe("В этом срезе принимается только текст.");
  });

  it("должен на текст звать enqueue с ключом tg:{agentId}:{updateId}", async () => {
    const recorded = recordingEnqueue({ runId: CREATED_RUN_ID, reason: "created" });
    const result = await handleTelegramUpdate(textView("прочитай README"), {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
    });

    expect(recorded.calls).toEqual([
      {
        tenantId: "local",
        agentId: AGENT_ID,
        source: "telegram",
        idempotencyKey: `tg:${AGENT_ID}:15`,
        message: "прочитай README",
        chatId: 9223372036854775807n,
      },
    ]);
    const chatId = recorded.calls[0]?.chatId;
    expect(typeof chatId).toBe("bigint");
    expect(chatId).toBe(9223372036854775807n);
    expect(result.text).toBe(`Запуск принят. ${CREATED_RUN_ID}`);
    expect(result.followRunId).toBe(CREATED_RUN_ID);
    expect(result.chatId).toBe(CHAT_ID);
  });

  it("должен не звать enqueue на чужой update id", async () => {
    const recorded = recordingEnqueue({ runId: CREATED_RUN_ID, reason: "created" });
    const hostile: TelegramUpdateView = {
      updateId: "15; drop table runs",
      userId: "7",
      chatId: "10",
      content: { type: "text", message: "привет" },
    };
    const result = await handleTelegramUpdate(hostile, {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
    });

    expect(recorded.calls).toEqual([]);
    expect(result.text).toBe(INVALID_UPDATE_TEXT);
    expect(result.followRunId).toBeNull();
  });

  it("должен сохранить текст занятого чата и назвать id живого запуска", async () => {
    const recorded = recordingEnqueue({ runId: LIVE_RUN_ID, reason: "dialog_busy" });
    const saved: DialogMessage[] = [];
    const result = await handleTelegramUpdate(textView("ещё раз", "7", "16"), {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
      rememberBusy: (message) => {
        saved.push(message);
        return Promise.resolve();
      },
    });

    expect(recorded.calls).toHaveLength(1);
    expect(saved).toEqual([
      {
        tenantId: "local",
        agentId: AGENT_ID,
        chatId: 9223372036854775807n,
        idempotencyKey: `tg:${AGENT_ID}:16`,
        message: "ещё раз",
      },
    ]);
    expect(typeof saved[0]?.chatId).toBe("bigint");
    expect(result.text).toBe(replyForBuffered(LIVE_RUN_ID));
    expect(result.text).toContain(LIVE_RUN_ID);
    expect(result.followRunId).toBe(LIVE_RUN_ID);
  });

  it("должен при непустом буфере сохранить текст и не звать enqueue", async () => {
    const recorded = recordingEnqueue({ runId: CREATED_RUN_ID, reason: "created" });
    const saved: DialogMessage[] = [];
    const result = await handleTelegramUpdate(textView("хвост", "7", "18"), {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
      rememberBusy: (message) => {
        saved.push(message);
        return Promise.resolve();
      },
      hasPendingBuffer: () => Promise.resolve(true),
      findExistingRun: () => Promise.resolve(null),
    });

    expect(recorded.calls).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.message).toBe("хвост");
    expect(typeof saved[0]?.chatId).toBe("bigint");
    expect(result.text).toBe(BUFFER_BEHIND_TEXT);
    expect(result.followRunId).toBeNull();
    expect(result.wakeBuffer).toBe(true);
  });

  it("должен на уже известный ключ вернуть тот же id и не звать enqueue", async () => {
    const recorded = recordingEnqueue({ runId: CREATED_RUN_ID, reason: "created" });
    const result = await handleTelegramUpdate(textView("прочитай README"), {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
      rememberBusy: () => Promise.reject(new Error("buffer")),
      hasPendingBuffer: () => Promise.resolve(true),
      findExistingRun: () => Promise.resolve(CREATED_RUN_ID),
    });

    expect(recorded.calls).toEqual([]);
    expect(result.followRunId).toBe(CREATED_RUN_ID);
    expect(result.text).toBe(`Этот запуск уже есть. ${CREATED_RUN_ID}`);
  });

  it("должен на повтор ключа вернуть тот же id", async () => {
    const recorded = recordingEnqueue({ runId: CREATED_RUN_ID, reason: "replay" });
    const result = await handleTelegramUpdate(textView("прочитай README"), {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
    });

    expect(recorded.calls[0]?.idempotencyKey).toBe(`tg:${AGENT_ID}:15`);
    expect(result.text).toBe(`Этот запуск уже есть. ${CREATED_RUN_ID}`);
  });

  it("должен не звать enqueue, если текст длиннее лимита payload", async () => {
    const recorded = recordingEnqueue({ runId: CREATED_RUN_ID, reason: "created" });
    const result = await handleTelegramUpdate(textView("а".repeat(MESSAGE_LIMIT + 1)), {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
    });

    expect(recorded.calls).toEqual([]);
    expect(result.followRunId).toBeNull();
    expect(result.text).toBe("Сообщение длиннее 8000 символов.");
  });
});

describe("pollOutgoing", () => {
  it("должен отдать final_text один раз и молчать на повторном опросе", () => {
    const run: RunSnapshot = {
      id: CREATED_RUN_ID,
      status: "succeeded",
      finalText: "содержимое файла",
      error: "не должен попасть",
    };

    const first = pollOutgoing(run, new Set());
    expect(first.text).toBe("содержимое файла");
    expect(first.delivered.has(CREATED_RUN_ID)).toBe(true);

    const second = pollOutgoing(run, first.delivered);
    expect(second.text).toBeNull();
  });

  it("должен молчать, пока запуск не завершён", () => {
    const waiting = pollOutgoing(
      {
        id: CREATED_RUN_ID,
        status: "running",
        finalText: "рано",
        error: null,
      },
      new Set(),
    );
    expect(waiting.text).toBeNull();
    expect(waiting.delivered.has(CREATED_RUN_ID)).toBe(false);
  });

  it("должен для failed включить error и не включить стек", () => {
    const failed = pollOutgoing(
      {
        id: CREATED_RUN_ID,
        status: "failed",
        finalText: "Error: boom\n    at src/runner/index.ts:2:2",
        error: "json_in_text\n    at OpenAICompatRunner.run (src/runner/index.ts:10:5)",
      },
      new Set(),
    );

    expect(failed.text).toBe("Запуск не выполнен. json_in_text");
    expect(failed.text).toContain("json_in_text");
    expect(failed.text).not.toContain("src/runner");
    expect(failed.text).not.toContain("OpenAICompatRunner");
    expect(failed.text).not.toContain("Error: boom");
    expect(failed.text).not.toContain("\n");
  });

  it("должен прекратить опрос после 10 минут, не отправляя текст", () => {
    const run: RunSnapshot = {
      id: CREATED_RUN_ID,
      status: "queued",
      finalText: null,
      error: null,
    };
    const earlier = pollStep(run, new Set(), POLL_LIMIT_MS - 1);
    expect(earlier.keepWaiting).toBe(true);
    expect(earlier.text).toBeNull();

    const timedOut = pollStep(run, new Set(), POLL_LIMIT_MS);
    expect(timedOut.keepWaiting).toBe(false);
    expect(timedOut.text).toBeNull();
  });
});

describe("followRun", () => {
  it("должен отправить final_text один раз в тот же chat_id", async () => {
    const delivery: DeliveryMemory = { sent: new Set() };
    const sent: { chatId: string; text: string }[] = [];
    const run: RunSnapshot = {
      id: CREATED_RUN_ID,
      status: "succeeded",
      finalText: "итог",
      error: null,
    };
    const deps = {
      readRun: () => Promise.resolve(run),
      send: (chatId: string, text: string) => {
        sent.push({ chatId, text });
        return Promise.resolve();
      },
      sleep: () => Promise.reject(new Error("sleep")),
      now: () => 0,
      isStopped: () => false,
      delivery,
    };

    await followRun(CREATED_RUN_ID, CHAT_ID, deps);
    await followRun(CREATED_RUN_ID, CHAT_ID, deps);

    expect(sent).toEqual([{ chatId: CHAT_ID, text: "итог" }]);
    expect(typeof sent[0]?.chatId).toBe("string");
  });
});

describe("createTelegramBot", () => {
  it("должен принимать фейковый токен и не ходить в сеть до start", () => {
    const calls: string[] = [];
    createTelegramBot({
      token: BOT_TOKEN,
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: () => Promise.resolve({ runId: CREATED_RUN_ID, reason: "created" as const }),
      readRun: () => Promise.resolve(null),
      delivery: { sent: new Set() },
      isStopped: () => false,
      sleep: () => Promise.resolve(),
      now: () => 0,
      track: () => undefined,
      fetch: () => {
        calls.push("called");
        return Promise.reject(new Error("network"));
      },
    });

    expect(calls).toEqual([]);
  });
});

function textView(message: string, userId = "7", updateId = "15"): TelegramUpdateView {
  return {
    updateId,
    userId,
    chatId: CHAT_ID,
    content: { type: "text", message },
  };
}

function requireView(view: TelegramUpdateView | null): TelegramUpdateView {
  if (view === null) {
    throw new Error("update view");
  }
  return view;
}

function recordingEnqueue(result: TelegramEnqueueResult): {
  enqueue: TelegramEnqueue;
  calls: EnqueueInput[];
} {
  const calls: EnqueueInput[] = [];
  return {
    calls,
    enqueue: (input) => {
      calls.push(input);
      return Promise.resolve(result);
    },
  };
}
