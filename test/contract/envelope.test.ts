import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONTRACT_VERSION,
  HTTP_ERROR_FIELD_NAMES,
  JSON_BODY_LIMIT_BYTES,
  REQUEST_FIELD_NAMES,
  RESPONSE_FIELD_NAMES,
  parseHttpError,
  parseToolRequest,
  parseToolResponse,
} from "../../contract/index.js";

const RUN_ID = "00000000-0000-4000-8000-000000000010";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const CALL_ID = "call_1";

function requestBody(name: string, args: unknown, service = "files"): string {
  return JSON.stringify({
    contract: CONTRACT_VERSION,
    run_id: RUN_ID,
    tool_call_id: CALL_ID,
    agent_id: AGENT_ID,
    service,
    name,
    arguments: args,
  });
}

async function readJson(name: string): Promise<unknown> {
  const path = fileURLToPath(new URL(`../../contract/${name}`, import.meta.url));
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function propertyNames(value: unknown): string[] {
  const properties = own(value, "properties");
  if (typeof properties !== "object" || properties === null) {
    return [];
  }
  return Object.keys(properties).sort();
}

function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, key)?.value as unknown;
}

describe("harness.tool.v1 envelope", () => {
  it("должен разобрать пример чтения и пример ответа", async () => {
    const request = await readFile(
      fileURLToPath(new URL("../../contract/examples/read-file.request.json", import.meta.url)),
      "utf8",
    );
    const success = await readFile(
      fileURLToPath(new URL("../../contract/examples/read-file.success.json", import.meta.url)),
      "utf8",
    );
    const failure = await readFile(
      fileURLToPath(new URL("../../contract/examples/read-file.failure.json", import.meta.url)),
      "utf8",
    );
    const httpError = await readFile(
      fileURLToPath(new URL("../../contract/examples/http-error.json", import.meta.url)),
      "utf8",
    );

    const parsed = parseToolRequest(request);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.contract).toBe(CONTRACT_VERSION);
    expect(parsed.value.arguments).toEqual({ path: "notes/a.txt" });
    expect(parseToolResponse(success).ok).toBe(true);
    expect(parseToolResponse(failure)).toEqual({
      ok: true,
      value: {
        contract: CONTRACT_VERSION,
        ok: false,
        error: "path escapes root",
        error_code: "forbidden",
        truncated: false,
        duration_ms: 2,
        blobs: [],
      },
    });
    expect(parseHttpError(httpError)).toEqual({ ok: true, value: { reason: "invalid_body" } });
  });

  it("должен отвергнуть лишнее поле, не отбрасывая его", () => {
    const raw = {
      contract: CONTRACT_VERSION,
      run_id: RUN_ID,
      tool_call_id: CALL_ID,
      agent_id: AGENT_ID,
      name: "read_file",
      arguments: { path: "notes/a.txt" },
      chat_id: "1",
    };
    expect(parseToolRequest(JSON.stringify(raw))).toEqual({
      ok: false,
      reason: "unknown_field",
    });
  });

  it("должен отвергнуть чужую версию контракта", () => {
    const raw = {
      contract: "harness.tool.v2",
      run_id: RUN_ID,
      tool_call_id: CALL_ID,
      agent_id: AGENT_ID,
      name: "read_file",
      arguments: { path: "notes/a.txt" },
    };
    expect(parseToolRequest(JSON.stringify(raw))).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
  });

  it("должен отвергнуть ключи __proto__, constructor и prototype", () => {
    const base = requestBody("read_file", { path: "notes/a.txt" });
    const proto = base.replace('"arguments"', '"__proto__":{"admin":true},"arguments"');
    const constructor = base.replace('"arguments"', '"constructor":{"x":1},"arguments"');
    const nested = requestBody("read_file", { path: "notes/a.txt", prototype: "x" });
    expect(parseToolRequest(proto)).toEqual({ ok: false, reason: "unknown_field" });
    expect(parseToolRequest(constructor)).toEqual({ ok: false, reason: "unknown_field" });
    expect(parseToolRequest(nested)).toEqual({ ok: false, reason: "unknown_field" });
  });

  it("должен отвергнуть идентификатор, который не строка", () => {
    const raw = `{"contract":"${CONTRACT_VERSION}","run_id":10,"tool_call_id":"${CALL_ID}","agent_id":"${AGENT_ID}","service":"files","name":"read_file","arguments":{"path":"a"}}`;
    expect(parseToolRequest(raw)).toEqual({ ok: false, reason: "invalid_body" });
  });

  it("должен отвергнуть ответ с полем токенов", () => {
    const raw = {
      contract: CONTRACT_VERSION,
      ok: true,
      text: "notes/a.txt",
      truncated: false,
      duration_ms: 4,
      blobs: [],
      prompt_tokens: 3,
    };
    expect(parseToolResponse(JSON.stringify(raw))).toEqual({
      ok: false,
      reason: "unknown_field",
    });
  });

  it("должен отвергнуть text у ошибки и error у успеха", () => {
    const bothOnSuccess = {
      contract: CONTRACT_VERSION,
      ok: true,
      text: "a",
      error: "path escapes root",
      truncated: false,
      duration_ms: 1,
      blobs: [],
    };
    const textOnFailure = {
      contract: CONTRACT_VERSION,
      ok: false,
      text: "a",
      error: "path escapes root",
      error_code: "forbidden",
      truncated: false,
      duration_ms: 1,
      blobs: [],
    };
    expect(parseToolResponse(JSON.stringify(bothOnSuccess)).ok).toBe(false);
    expect(parseToolResponse(JSON.stringify(textOnFailure))).toEqual({
      ok: false,
      reason: "unknown_field",
    });
  });

  it("должен отвергнуть ошибку с управляющим символом и duration вне предела", () => {
    const broken = {
      contract: CONTRACT_VERSION,
      ok: false,
      error: "path\nescapes",
      error_code: "forbidden",
      truncated: false,
      duration_ms: 1,
      blobs: [],
    };
    const late = {
      contract: CONTRACT_VERSION,
      ok: true,
      text: "a",
      truncated: false,
      duration_ms: 600001,
      blobs: [],
    };
    expect(parseToolResponse(JSON.stringify(broken))).toEqual({
      ok: false,
      reason: "invalid_body",
    });
    expect(parseToolResponse(JSON.stringify(late))).toEqual({ ok: false, reason: "invalid_body" });
  });

  it("должен отвергнуть тело больше 32 КиБ до разбора", () => {
    const raw = `${" ".repeat(JSON_BODY_LIMIT_BYTES)}x`;
    expect(Buffer.byteLength(raw, "utf8")).toBe(JSON_BODY_LIMIT_BYTES + 1);
    expect(parseToolRequest(raw)).toEqual({ ok: false, reason: "payload_too_large" });
  });

  it("должен отвергнуть повтор ключа в одном объекте", () => {
    const raw = `{"contract":"${CONTRACT_VERSION}","contract":"${CONTRACT_VERSION}","run_id":"${RUN_ID}","tool_call_id":"${CALL_ID}","agent_id":"${AGENT_ID}","service":"files","name":"read_file","arguments":{"path":"a"}}`;
    expect(parseToolRequest(raw)).toEqual({ ok: false, reason: "invalid_body" });
  });

  it("должен совпасть со списком полей канона JSON Schema", async () => {
    expect(REQUEST_FIELD_NAMES).toEqual([
      "agent_id",
      "arguments",
      "contract",
      "name",
      "run_id",
      "service",
      "tool_call_id",
    ]);
    expect(RESPONSE_FIELD_NAMES).toEqual([
      "blobs",
      "contract",
      "duration_ms",
      "error",
      "error_code",
      "ok",
      "text",
      "truncated",
    ]);
    expect(HTTP_ERROR_FIELD_NAMES).toEqual(["reason"]);
    expect(propertyNames(await readJson("harness.tool.v1.request.schema.json"))).toEqual([
      ...REQUEST_FIELD_NAMES,
    ]);
    expect(propertyNames(await readJson("harness.tool.v1.response.schema.json"))).toEqual([
      ...RESPONSE_FIELD_NAMES,
    ]);
    expect(propertyNames(await readJson("harness.tool.v1.http-error.schema.json"))).toEqual([
      ...HTTP_ERROR_FIELD_NAMES,
    ]);
    const requestSchema = await readJson("harness.tool.v1.request.schema.json");
    const responseSchema = await readJson("harness.tool.v1.response.schema.json");
    expect(own(requestSchema, "additionalProperties")).toBe(false);
    expect(own(responseSchema, "unevaluatedProperties")).toBe(false);
    expect(own(responseSchema, "additionalProperties")).toBe(false);
  });

  it("должен принять service тем же алфавитом, что id сервиса, и отвергнуть чужой", () => {
    expect(parseToolRequest(requestBody("read_file", { path: "notes/a.txt" })).ok).toBe(true);
    expect(parseToolRequest(requestBody("read_file", { path: "a" }, "files.read_file"))).toEqual({
      ok: false,
      reason: "invalid_body",
    });
    expect(parseToolRequest(requestBody("read_file", { path: "a" }, "Files"))).toEqual({
      ok: false,
      reason: "invalid_body",
    });
    const missing = JSON.parse(requestBody("read_file", { path: "a" })) as Record<string, unknown>;
    delete missing.service;
    expect(parseToolRequest(JSON.stringify(missing))).toEqual({
      ok: false,
      reason: "invalid_body",
    });
  });

  it("должен заменить неизвестный error_code на internal и оставить строку error", () => {
    const raw = {
      contract: CONTRACT_VERSION,
      ok: false,
      error: "path escapes root",
      error_code: "path_escape",
      truncated: false,
      duration_ms: 2,
      blobs: [] as string[],
    };
    expect(parseToolResponse(JSON.stringify(raw))).toEqual({
      ok: true,
      value: {
        contract: CONTRACT_VERSION,
        ok: false,
        error: "path escapes root",
        error_code: "internal",
        truncated: false,
        duration_ms: 2,
        blobs: [],
      },
    });
    raw.error_code = "not_found";
    const known = parseToolResponse(JSON.stringify(raw));
    expect(known.ok).toBe(true);
    if (!known.ok || known.value.ok !== false) {
      return;
    }
    expect(known.value.error_code).toBe("not_found");
    expect(known.value.error).toBe("path escapes root");
    const missing = { ...raw };
    delete (missing as { error_code?: string }).error_code;
    expect(parseToolResponse(JSON.stringify(missing))).toEqual({
      ok: false,
      reason: "invalid_body",
    });
    const onSuccess = {
      contract: CONTRACT_VERSION,
      ok: true,
      text: "a",
      error_code: "internal",
      truncated: false,
      duration_ms: 1,
      blobs: [],
    };
    expect(parseToolResponse(JSON.stringify(onSuccess))).toEqual({
      ok: false,
      reason: "unknown_field",
    });
  });

  it("должен отвергнуть лишнее поле тела HTTP-ошибки", () => {
    expect(parseHttpError('{"reason":"invalid_body","detail":"x"}')).toEqual({
      ok: false,
      reason: "unknown_field",
    });
  });
});
