import { describe, expect, it } from "vitest";

import {
  CONTRACT_VERSION,
  MODEL_TOOL_TEXT_CHARS,
  RECORD_NOTE_TEXT_MAX,
  clipModelText,
  compareIdempotency,
  formatIdempotencyKey,
  omitIdempotencyArgument,
  parseToolArguments,
  parseToolCall,
  type ToolResponse,
} from "../../contract/index.js";

const RUN_ID = "00000000-0000-4000-8000-000000000010";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const CALL_ID = "call_1";
const KEY = `"${RUN_ID}:${CALL_ID}"`;

function callBody(name: string, args: unknown, toolCallId = CALL_ID): string {
  return JSON.stringify({
    contract: CONTRACT_VERSION,
    run_id: RUN_ID,
    tool_call_id: toolCallId,
    agent_id: AGENT_ID,
    service: "files",
    name,
    arguments: args,
  });
}

function input(body: string, pathName: string, idempotencyKey: string | null) {
  return {
    body,
    contractHeader: CONTRACT_VERSION,
    idempotencyKey,
    pathName,
  };
}

const storedResponse: ToolResponse = {
  contract: CONTRACT_VERSION,
  ok: true,
  text: "wrote out/a.txt",
  truncated: false,
  duration_ms: 4,
  blobs: [],
};

describe("tool arguments", () => {
  it("должен принять path чтения и необязательный path каталога", () => {
    expect(parseToolArguments("read_file", { path: "notes/a.txt" })).toEqual({
      ok: true,
      value: { path: "notes/a.txt" },
    });
    expect(parseToolArguments("list_dir", {})).toEqual({ ok: true, value: {} });
    expect(parseToolArguments("list_dir", { path: "notes" })).toEqual({
      ok: true,
      value: { path: "notes" },
    });
  });

  it("должен отвергнуть лишнее поле аргументов и пустой path", () => {
    expect(parseToolArguments("read_file", { path: "a", extra: true })).toEqual({
      ok: false,
      reason: "unknown_field",
    });
    expect(parseToolArguments("read_file", { path: "" })).toEqual({
      ok: false,
      reason: "invalid_body",
    });
    expect(parseToolArguments("list_dir", { path: "a", mode: "deep" })).toEqual({
      ok: false,
      reason: "unknown_field",
    });
  });

  it("должен принять text заметки на пределе спецификации и отвергнуть более длинный", () => {
    const text = "a".repeat(RECORD_NOTE_TEXT_MAX);
    expect(parseToolArguments("record_note", { path: "out/a.txt", text }).ok).toBe(true);
    expect(parseToolArguments("record_note", { path: "out/a.txt", text: `${text}b` })).toEqual({
      ok: false,
      reason: "invalid_body",
    });
  });

  it("должен принять text из эмодзи на пределе кодпоинтов и отвергнуть на один длиннее", () => {
    const text = "🙂".repeat(RECORD_NOTE_TEXT_MAX);
    expect(text.length).toBe(RECORD_NOTE_TEXT_MAX * 2);
    expect(parseToolArguments("record_note", { path: "out/a.txt", text }).ok).toBe(true);
    expect(parseToolArguments("record_note", { path: "out/a.txt", text: `${text}🙂` })).toEqual({
      ok: false,
      reason: "invalid_body",
    });
  });

  it("должен отвергнуть idempotency_key в аргументах сервиса и снять его с копии хаба", () => {
    const args = { path: "out/a.txt", text: "note", idempotency_key: "local-key" };
    expect(parseToolArguments("record_note", args)).toEqual({
      ok: false,
      reason: "unknown_field",
    });
    const stripped = omitIdempotencyArgument(args);
    expect(stripped.ok).toBe(true);
    if (!stripped.ok) {
      return;
    }
    expect(stripped.value).toEqual({ path: "out/a.txt", text: "note" });
    expect(parseToolArguments("record_note", stripped.value).ok).toBe(true);
  });

  it("должен снять idempotency_key до строгой проверки и не дать conflict на том же тексте", () => {
    const plain = parseToolCall(
      input(callBody("record_note", { path: "out/a.txt", text: "note" }), "record_note", KEY),
    );
    const extra = parseToolCall(
      input(
        callBody("record_note", {
          path: "out/a.txt",
          text: "note",
          idempotency_key: "local-key",
        }),
        "record_note",
        KEY,
      ),
    );
    const other = parseToolCall(
      input(
        callBody("record_note", {
          path: "out/a.txt",
          text: "note",
          idempotency_key: "other-key",
        }),
        "record_note",
        KEY,
      ),
    );
    expect(plain.ok && extra.ok && other.ok).toBe(true);
    if (!plain.ok || !extra.ok || !other.ok) {
      return;
    }
    expect(extra.value.arguments).toEqual({ path: "out/a.txt", text: "note" });
    expect(extra.value.request.arguments).toEqual({ path: "out/a.txt", text: "note" });
    expect(extra.value.canonicalText.includes("idempotency_key")).toBe(false);
    expect(Buffer.compare(plain.value.bodySha256, extra.value.bodySha256)).toBe(0);
    expect(Buffer.compare(plain.value.bodySha256, other.value.bodySha256)).toBe(0);
    expect(
      compareIdempotency({
        effect: "write",
        key: `${RUN_ID}:${CALL_ID}`,
        bodySha256: extra.value.bodySha256,
        stored: {
          key: `${RUN_ID}:${CALL_ID}`,
          bodySha256: plain.value.bodySha256,
          state: "done",
          response: storedResponse,
        },
      }),
    ).toEqual({ kind: "replay", response: storedResponse });
    expect(
      parseToolCall(
        input(
          callBody("record_note", {
            path: "out/a.txt",
            text: "note",
            idempotency_key: "local-key",
            extra: true,
          }),
          "record_note",
          KEY,
        ),
      ),
    ).toEqual({ ok: false, reason: "unknown_field" });
  });
});

describe("parseToolCall", () => {
  it("должен разобрать чтение без ключа идемпотентности", () => {
    const parsed = parseToolCall(
      input(callBody("read_file", { path: "notes/a.txt" }), "read_file", null),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.effect).toBe("read");
    expect(parsed.value.idempotencyKey).toBeNull();
    expect(parsed.value.bodySha256).toHaveLength(32);
  });

  it("должен отвергнуть запись без ключа идемпотентности", () => {
    const parsed = parseToolCall(
      input(callBody("record_note", { path: "out/a.txt", text: "note" }), "record_note", null),
    );
    expect(parsed).toEqual({ ok: false, reason: "invalid_body" });
  });

  it("должен отвергнуть кривой ключ и на чтении", () => {
    const parsed = parseToolCall(
      input(callBody("read_file", { path: "notes/a.txt" }), "read_file", "call_1"),
    );
    expect(parsed).toEqual({ ok: false, reason: "invalid_body" });
  });

  it("должен отвергнуть чужой заголовок версии и имя вне трёх инструментов", () => {
    const body = callBody("read_file", { path: "notes/a.txt" });
    expect(
      parseToolCall({
        body,
        contractHeader: "harness.tool.v2",
        idempotencyKey: null,
        pathName: "read_file",
      }),
    ).toEqual({ ok: false, reason: "unsupported_version" });
    expect(parseToolCall(input(callBody("Bash", {}), "Bash", null))).toEqual({
      ok: false,
      reason: "unknown_tool",
    });
  });

  it("должен отвергнуть сегмент пути . и несовпадение имени с телом", () => {
    const body = callBody("read_file", { path: "notes/a.txt" });
    expect(parseToolCall(input(body, ".", null))).toEqual({ ok: false, reason: "invalid_body" });
    expect(parseToolCall(input(body, "list_dir", null))).toEqual({
      ok: false,
      reason: "invalid_body",
    });
  });
});

describe("compareIdempotency", () => {
  it("должен вернуть первый ответ при том же ключе и том же теле", () => {
    const parsed = parseToolCall(
      input(callBody("record_note", { path: "out/a.txt", text: "note" }), "record_note", KEY),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const again = parseToolCall(
      input(
        JSON.stringify({
          arguments: { text: "note", path: "out/a.txt" },
          name: "record_note",
          service: "files",
          agent_id: AGENT_ID,
          tool_call_id: CALL_ID,
          run_id: RUN_ID,
          contract: CONTRACT_VERSION,
        }),
        "record_note",
        KEY,
      ),
    );
    expect(again.ok).toBe(true);
    if (!again.ok) {
      return;
    }
    expect(Buffer.compare(parsed.value.bodySha256, again.value.bodySha256)).toBe(0);
    expect(
      compareIdempotency({
        effect: "write",
        key: parsed.value.idempotencyKey,
        bodySha256: again.value.bodySha256,
        stored: {
          key: `${RUN_ID}:${CALL_ID}`,
          bodySha256: parsed.value.bodySha256,
          state: "done",
          response: storedResponse,
        },
      }),
    ).toEqual({ kind: "replay", response: storedResponse });
  });

  it("должен ответить 409 на тот же ключ и другое тело", () => {
    const first = parseToolCall(
      input(callBody("record_note", { path: "out/a.txt", text: "one" }), "record_note", KEY),
    );
    const second = parseToolCall(
      input(callBody("record_note", { path: "out/a.txt", text: "two" }), "record_note", KEY),
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(
      compareIdempotency({
        effect: "write",
        key: `${RUN_ID}:${CALL_ID}`,
        bodySha256: second.value.bodySha256,
        stored: {
          key: `${RUN_ID}:${CALL_ID}`,
          bodySha256: first.value.bodySha256,
          state: "done",
          response: storedResponse,
        },
      }),
    ).toEqual({ kind: "conflict", status: 409, reason: "idempotency_conflict" });
  });

  it("должен не читать хранилище для чтения и требовать ключ для записи", () => {
    const hash = new Uint8Array(32);
    expect(
      compareIdempotency({
        effect: "read",
        key: `${RUN_ID}:${CALL_ID}`,
        bodySha256: hash,
        stored: {
          key: `${RUN_ID}:${CALL_ID}`,
          bodySha256: hash,
          state: "done",
          response: storedResponse,
        },
      }),
    ).toEqual({ kind: "read" });
    expect(
      compareIdempotency({
        effect: "write",
        key: null,
        bodySha256: hash,
        stored: null,
      }),
    ).toEqual({ kind: "missing_key" });
    expect(formatIdempotencyKey(RUN_ID, CALL_ID)).toBe(`${RUN_ID}:${CALL_ID}`);
    expect(formatIdempotencyKey(RUN_ID, "bad:id")).toBeNull();
  });

  it("должен ответить 409, пока тот же хеш ещё выполняется", () => {
    const hash = new Uint8Array(32);
    hash[0] = 1;
    expect(
      compareIdempotency({
        effect: "write",
        key: `${RUN_ID}:${CALL_ID}`,
        bodySha256: hash,
        stored: {
          key: `${RUN_ID}:${CALL_ID}`,
          bodySha256: hash,
          state: "started",
          response: null,
        },
      }),
    ).toEqual({ kind: "in_progress", status: 409, reason: "idempotency_in_progress" });
  });
});

describe("clipModelText", () => {
  it("должен оставить 8000 кодпоинтов и отрезать следующий", () => {
    const emoji = "😀";
    expect(clipModelText("a".repeat(MODEL_TOOL_TEXT_CHARS))).toEqual({
      text: "a".repeat(MODEL_TOOL_TEXT_CHARS),
      clipped: false,
    });
    const clipped = clipModelText(`${emoji.repeat(MODEL_TOOL_TEXT_CHARS)}x`);
    expect(clipped.clipped).toBe(true);
    expect([...clipped.text].length).toBe(MODEL_TOOL_TEXT_CHARS);
    expect(clipped.text.endsWith("x")).toBe(false);
  });

  it("должен оставить пустую строку без отрезания", () => {
    expect(clipModelText("")).toEqual({ text: "", clipped: false });
  });
});
