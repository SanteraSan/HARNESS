import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type Update, type UserFromGetMe } from "grammy/types";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { EnqueueInput } from "../../src/contracts/types.js";
import { createTelegramBot } from "../../src/telegram/bot.js";
import { saveChatModelChoice } from "../../src/telegram/chat-model.js";
import {
  partsFromMessage,
  viewFromParts,
  type TelegramUpdateView,
} from "../../src/telegram/decide.js";
import {
  handleTelegramUpdate,
  type TelegramEnqueue,
  type TelegramEnqueueResult,
} from "../../src/telegram/handle.js";
import { sql } from "../helpers/db.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const CHAT_ID = "9223372036854775807";
const CHAT = 9223372036854775807n;
const ALLOWED = ["7"];
const LOCAL_TEXT = "Этот чат спрашивает локальную модель.";
const CLOUD_TEXT = "Этот чат спрашивает внешнюю модель.";
const IMPORT_MARKERS = ["../model", "litellm", "claude-sdk", "claudesdk", "@anthropic-ai"] as const;

describe("chat model command", () => {
  beforeEach(async () => {
    await sql`delete from chat_model_choices`;
  });

  afterAll(async () => {
    await sql`delete from chat_model_choices`;
  });

  it("должен по /cloud и /local записать алиас и не создать запуск", async () => {
    const recorded = recordingEnqueue();
    const cloud = await handleTelegramUpdate(textView("/cloud", "7", "15"), {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
      saveChatModel: (chatId, modelAlias) => saveChatModelChoice(sql, chatId, modelAlias),
    });

    expect(recorded.calls).toEqual([]);
    expect(cloud).toEqual({
      text: CLOUD_TEXT,
      followRunId: null,
      chatId: null,
      wakeBuffer: false,
    });
    expect(await countRuns()).toBe(0);
    const storedCloud = await choiceRow();
    expect(storedCloud.model_alias).toBe("coder-cloud");
    expect(storedCloud.chat_id).toBe(CHAT.toString());
    expect(typeof storedCloud.chat_id).toBe("string");

    await sql`
      update chat_model_choices
      set updated_at = now() - interval '1 day'
      where tenant_id = 'local'
        and chat_id = ${sql.types.chat_id(CHAT_ID)}
    `;
    const before = await choiceRow();

    const local = await handleTelegramUpdate(textView("/local", "7", "16"), {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
      saveChatModel: (chatId, modelAlias) => saveChatModelChoice(sql, chatId, modelAlias),
    });

    expect(recorded.calls).toEqual([]);
    expect(local.text).toBe(LOCAL_TEXT);
    expect(local.followRunId).toBeNull();
    expect(await countRuns()).toBe(0);
    expect(await countChoices()).toBe(1);
    const storedLocal = await choiceRow();
    expect(storedLocal.model_alias).toBe("agent");
    expect(storedLocal.chat_id).toBe(CHAT_ID);
    expect(storedLocal.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it("должен отказать чужому пользователю и не писать строку", async () => {
    const recorded = recordingEnqueue();
    const result = await handleTelegramUpdate(textView("/cloud", "8", "17"), {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
      saveChatModel: () => Promise.reject(new Error("stranger must not save")),
    });

    expect(recorded.calls).toEqual([]);
    expect(result.text).toBe("Нет доступа.");
    expect(result.followRunId).toBeNull();
    expect(await countChoices()).toBe(0);
    expect(await countRuns()).toBe(0);
  });

  it("должен не класть команду в буфер занятого чата", async () => {
    const recorded = recordingEnqueue();
    let remembered = 0;
    const result = await handleTelegramUpdate(textView("/local", "7", "18"), {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
      rememberBusy: () => {
        remembered += 1;
        return Promise.resolve();
      },
      hasPendingBuffer: () => Promise.resolve(true),
      findExistingRun: () => Promise.resolve(null),
      saveChatModel: (chatId, modelAlias) => saveChatModelChoice(sql, chatId, modelAlias),
    });

    expect(remembered).toBe(0);
    expect(recorded.calls).toEqual([]);
    expect(result.text).toBe(LOCAL_TEXT);
    expect(result.wakeBuffer).toBe(false);
    expect(await countRuns()).toBe(0);
    const row = await choiceRow();
    expect(row.model_alias).toBe("agent");
  });

  it("должен обычный текст с префиксом команды поставить в очередь", async () => {
    const recorded = recordingEnqueue();
    const trimmed = requireView(
      viewFromParts(
        partsFromMessage(19, {
          chat: { id: 42 },
          from: { id: 7 },
          text: "  /cloud  ",
        }),
      ),
    );
    const command = await handleTelegramUpdate(trimmed, {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
      saveChatModel: (chatId, modelAlias) => saveChatModelChoice(sql, chatId, modelAlias),
    });
    expect(command.text).toBe(CLOUD_TEXT);
    expect(recorded.calls).toEqual([]);

    const prose = await handleTelegramUpdate(textView("/cloud пожалуйста", "7", "20"), {
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
      saveChatModel: () => Promise.reject(new Error("prose must not save")),
    });

    expect(prose.followRunId).toBe("run-1");
    expect(recorded.calls).toEqual([
      {
        tenantId: "local",
        agentId: AGENT_ID,
        source: "telegram",
        idempotencyKey: `tg:${AGENT_ID}:20`,
        message: "/cloud пожалуйста",
        chatId: CHAT,
      },
    ]);
    expect(typeof recorded.calls[0]?.chatId).toBe("bigint");
  });

  it("должен отказать алиасу вне списка", async () => {
    const insert = sql`
      insert into chat_model_choices (tenant_id, chat_id, model_alias)
      values ('local', ${sql.types.chat_id("42")}, 'gemini')
    `;
    await expect(insert).rejects.toMatchObject({ code: "23514" });
    expect(await countChoices()).toBe(0);
  });

  it("должен из бота ответить на /cloud и не звать enqueue", async () => {
    const recorded = recordingEnqueue();
    const saved: { chatId: bigint; modelAlias: string }[] = [];
    const sent: string[] = [];
    const bot = createTelegramBot({
      token: "test-secret-value",
      allowedUserIds: ALLOWED,
      agentId: AGENT_ID,
      enqueue: recorded.enqueue,
      readRun: () => Promise.reject(new Error("model poll must not start")),
      delivery: { sent: new Set() },
      isStopped: () => false,
      sleep: () => Promise.resolve(),
      now: () => 0,
      track: () => undefined,
      fetch: fakeFetch(sent),
      saveChatModel: (chatId, modelAlias) => {
        saved.push({ chatId, modelAlias });
        return saveChatModelChoice(sql, chatId, modelAlias);
      },
    });
    bot.botInfo = fakeBotInfo();

    await bot.handleUpdate(messageUpdate(21, 7, "/cloud"));

    expect(recorded.calls).toEqual([]);
    expect(saved).toEqual([{ chatId: 42n, modelAlias: "coder-cloud" }]);
    expect(typeof saved[0]?.chatId).toBe("bigint");
    expect(sent.some((body) => body.includes(CLOUD_TEXT))).toBe(true);
    expect(await countRuns()).toBe(0);
    const row = await sql<{ model_alias: string; chat_id: string }[]>`
      select model_alias, chat_id
      from chat_model_choices
      where tenant_id = 'local'
        and chat_id = ${sql.types.chat_id("42")}
    `;
    expect(row[0]?.model_alias).toBe("coder-cloud");
    expect(row[0]?.chat_id).toBe("42");
  });

  it("должен не импортировать клиент модели и Claude SDK из каталога Telegram", async () => {
    const sources = await telegramSources();
    expect(sources.length).toBeGreaterThanOrEqual(8);
    const offenders: string[] = [];
    for (const item of sources) {
      const imports = importText(item.source);
      for (const marker of IMPORT_MARKERS) {
        if (imports.includes(marker)) {
          offenders.push(`${item.filePath} ${marker}`);
        }
      }
      if (item.source.includes("TELEGRAM_MODEL_ALIAS")) {
        offenders.push(`${item.filePath} TELEGRAM_MODEL_ALIAS`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

function textView(message: string, userId: string, updateId: string): TelegramUpdateView {
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

function recordingEnqueue(): { enqueue: TelegramEnqueue; calls: EnqueueInput[] } {
  const calls: EnqueueInput[] = [];
  const result: TelegramEnqueueResult = { runId: "run-1", reason: "created" };
  return {
    calls,
    enqueue: (input) => {
      calls.push(input);
      return Promise.resolve(result);
    },
  };
}

function messageUpdate(updateId: number, userId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      date: 1_700_000_000,
      chat: { id: 42, type: "private" },
      from: { id: userId, is_bot: false, first_name: "a" },
      text,
    },
  } as Update;
}

function fakeBotInfo(): UserFromGetMe {
  return {
    id: 1,
    is_bot: true,
    first_name: "test",
    username: "test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
}

/** Строки import/export. Комментарий про модель импортом не считается. */
function importText(source: string): string {
  const lines: string[] = [];
  let capturing = false;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("import ") || trimmed.startsWith("export ")) {
      capturing = true;
    }
    if (!capturing) {
      continue;
    }
    lines.push(trimmed);
    if (trimmed.endsWith(";")) {
      capturing = false;
    }
  }
  return lines.join("\n").toLowerCase();
}

function fakeFetch(sent: string[]): typeof fetch {
  return (_input, init) => {
    sent.push(typeof init?.body === "string" ? init.body : "");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 2,
            date: 1,
            chat: { id: 42, type: "private" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
}

interface ChoiceRow {
  model_alias: string;
  chat_id: string;
  updated_at: Date;
}

async function choiceRow(): Promise<ChoiceRow> {
  const rows = await sql<ChoiceRow[]>`
    select model_alias, chat_id, updated_at
    from chat_model_choices
    where tenant_id = 'local'
  `;
  const row = rows[0];
  if (row === undefined || rows.length !== 1) {
    throw new Error("chat model choice row is missing");
  }
  return row;
}

async function countChoices(): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    select count(*)::int as count from chat_model_choices
  `;
  return rows[0]?.count ?? 0;
}

async function countRuns(): Promise<number> {
  const rows = await sql<{ count: number }[]>`select count(*)::int as count from runs`;
  return rows[0]?.count ?? 0;
}

async function telegramSources(): Promise<{ filePath: string; source: string }[]> {
  const directory = fileURLToPath(new URL("../../src/telegram", import.meta.url));
  // Каталог пакета фиксирован. Путь модели сюда не приходит.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- src/telegram
  const entries = await readdir(directory, { recursive: true, encoding: "utf8" });
  const found: { filePath: string; source: string }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) {
      continue;
    }
    const filePath = path.join(directory, entry);
    found.push({ filePath, source: await readSource(filePath) });
  }
  return found;
}

async function readSource(filePath: string): Promise<string> {
  // Фиксированные файлы репозитория, не путь из запуска.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- чтение исходников пакета
  return readFile(filePath, "utf8");
}
