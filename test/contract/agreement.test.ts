import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONTRACT_VERSION,
  JSON_BODY_LIMIT_BYTES,
  MODEL_TOOL_TEXT_CHARS,
  RESPONSE_BODY_LIMIT_BYTES,
  RESPONSE_TEXT_MAX_CODE_POINTS,
  clipModelText,
  codePointLength,
  parseServicesManifest,
  parseToolRequest,
  parseToolResponse,
} from "../../contract/index.js";
import {
  FINGERPRINT_RE,
  SERVICE_ID_RE,
  TOOL_CALL_ID_RE,
  TOOL_NAME_RE,
  UUID_RE,
} from "../../contract/limits.js";

const RUN_ID = "00000000-0000-4000-8000-000000000010";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const PIN = "a".repeat(64);

const LOOPBACK_URL = new RegExp(
  "^(?:https?://(?:127\\.0\\.0\\.1|127\\.0\\.0\\.1:(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])))/?$",
);
const PRIVATE_10_URL = new RegExp(
  "^https://(?:10\\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])\\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])\\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])|10\\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])\\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])\\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5]):(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))/?$",
);
const PRIVATE_172_URL = new RegExp(
  "^https://(?:172\\.(?:1[6-9]|2[0-9]|3[0-1])\\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])\\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])|172\\.(?:1[6-9]|2[0-9]|3[0-1])\\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])\\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5]):(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))/?$",
);
const PRIVATE_192_URL = new RegExp(
  "^https://(?:192\\.168\\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])\\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])|192\\.168\\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])\\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5]):(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))/?$",
);
const ADDRESS_PATTERNS = [LOOPBACK_URL, PRIVATE_10_URL, PRIVATE_172_URL, PRIVATE_192_URL];

/** Схема error: нет C0, DEL и C1, не длиннее 400 единиц UTF-16. Длину в кодпоинтах режет maxLength. */
const ERROR_TEXT_PATTERN = "^[^\\u0000-\\u001F\\u007F\\u0080-\\u009F]{1,400}$";

const PATH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 4096 },
  },
};

describe("schema and parser agreement", () => {
  it("должен принять ответ с text на максимуме схемы и не пометить его payload_too_large", async () => {
    const responseSchema = await readJson("harness.tool.v1.response.schema.json");
    const maxLength = own(own(responseSchema, "properties"), "text");
    const max = own(maxLength, "maxLength");
    expect(max).toBe(RESPONSE_TEXT_MAX_CODE_POINTS);
    if (typeof max !== "number") {
      throw new Error("text maxLength missing");
    }

    const raw = JSON.stringify({
      contract: CONTRACT_VERSION,
      ok: true,
      text: "a".repeat(max),
      truncated: true,
      duration_ms: 1,
      blobs: [],
    });
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(JSON_BODY_LIMIT_BYTES);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(RESPONSE_BODY_LIMIT_BYTES);
    const parsed = parseToolResponse(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.ok !== true) {
      return;
    }
    expect(parsed.value.text).toBe("a".repeat(max));
    const clipped = clipModelText(parsed.value.text);
    expect(codePointLength(clipped.text)).toBe(MODEL_TOOL_TEXT_CHARS);
    expect(clipped.clipped).toBe(true);

    const overSchema = JSON.stringify({
      contract: CONTRACT_VERSION,
      ok: true,
      text: "a".repeat(max + 1),
      truncated: false,
      duration_ms: 1,
      blobs: [],
    });
    expect(Buffer.byteLength(overSchema, "utf8")).toBeLessThanOrEqual(RESPONSE_BODY_LIMIT_BYTES);
    expect(parseToolResponse(overSchema)).toEqual({ ok: false, reason: "invalid_body" });
    expect(parseToolResponse(" ".repeat(RESPONSE_BODY_LIMIT_BYTES + 1))).toEqual({
      ok: false,
      reason: "payload_too_large",
    });
    expect(parseToolRequest(" ".repeat(JSON_BODY_LIMIT_BYTES + 1))).toEqual({
      ok: false,
      reason: "payload_too_large",
    });
  });

  it("должен отвергнуть корень parameters, который не object", async () => {
    const services = await readJson("harness.services.v1.schema.json");
    const root = dig(services, ["$defs", "tool", "properties", "parameters", "allOf"]);
    expect(Array.isArray(root)).toBe(true);
    if (!Array.isArray(root)) {
      return;
    }
    expect(root).toContainEqual({
      required: ["type"],
      properties: { type: { const: "object" } },
    });

    expect(manifestOk({ type: "string" })).toBe(false);
    expect(manifestOk({ type: "boolean" })).toBe(false);
    expect(manifestOk({ type: "object" })).toBe(false);
    expect(manifestOk({ type: "object", additionalProperties: false })).toBe(true);
    expect(manifestOk(PATH_PARAMETERS)).toBe(true);
  });

  it("должен отвергнуть required, которого нет в properties", async () => {
    const services = await readJson("harness.services.v1.schema.json");
    const guards = dig(services, ["$defs", "parameters", "allOf"]);
    expect(Array.isArray(guards)).toBe(true);
    if (!Array.isArray(guards)) {
      return;
    }
    expect(guards).toContainEqual({
      if: {
        properties: { required: { type: "array", minItems: 1 } },
        required: ["required"],
      },
      then: { required: ["properties"] },
    });

    expect(
      manifestOk({
        type: "object",
        additionalProperties: false,
        required: ["path"],
      }),
    ).toBe(false);
    expect(
      manifestOk({
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { other: { type: "string" } },
      }),
    ).toBe(false);
    expect(
      manifestOk({
        type: "object",
        additionalProperties: false,
        required: [],
      }),
    ).toBe(true);
    expect(manifestOk(PATH_PARAMETERS)).toBe(true);
  });

  it("должен отвергнуть enum, который не совпадает с type", async () => {
    const services = await readJson("harness.services.v1.schema.json");
    const guards = dig(services, ["$defs", "parameters", "allOf"]);
    expect(Array.isArray(guards)).toBe(true);
    if (!Array.isArray(guards)) {
      return;
    }
    expect(dig(findStringEnum(guards), ["then", "properties", "enum", "items"])).toEqual({
      type: "string",
      maxLength: 64,
    });
    expect(dig(findTypedEnum(guards, "boolean"), ["then", "properties", "enum", "items"])).toEqual({
      type: "boolean",
    });
    expect(dig(findTypedEnum(guards, "integer"), ["then", "properties", "enum", "items"])).toEqual({
      type: "integer",
    });
    expect(dig(findTypedEnum(guards, "number"), ["then", "properties", "enum", "items"])).toEqual({
      type: "number",
    });
    expect(guards).toContainEqual({
      if: {
        properties: { type: { const: "object" } },
        required: ["type"],
      },
      then: { not: { required: ["enum"] } },
    });

    expect(fieldEnum("string", [true])).toBe(false);
    expect(fieldEnum("string", ["a", "b"])).toBe(true);
    expect(fieldEnum("string", ["a".repeat(64)])).toBe(true);
    expect(fieldEnum("string", ["a".repeat(65)])).toBe(false);
    expect(fieldEnum("string", ["🙂".repeat(64)])).toBe(true);
    expect(fieldEnum("string", ["🙂".repeat(65)])).toBe(false);
    expect(fieldEnum("integer", [1, 1.5])).toBe(false);
    expect(fieldEnum("integer", [1, 2])).toBe(true);
    expect(fieldEnum("boolean", [true, false])).toBe(true);
    expect(fieldEnum("boolean", [true, 1])).toBe(false);
    expect(fieldEnum("number", [1, 1.5])).toBe(true);
    expect(
      manifestOk({
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "object", additionalProperties: false, enum: [true] },
        },
      }),
    ).toBe(false);
    expect(
      manifestOk({
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "object", additionalProperties: false },
        },
      }),
    ).toBe(true);
  });

  it("должен выразить в схеме те же ограничения base_url, что применяет разбор", async () => {
    const services = await readJson("harness.services.v1.schema.json");
    const baseUrl = dig(services, ["$defs", "service", "properties", "base_url"]);
    const anyOf = own(baseUrl, "anyOf");
    expect(Array.isArray(anyOf)).toBe(true);
    if (!Array.isArray(anyOf)) {
      return;
    }
    expect(anyOf.map((entry) => own(entry, "pattern"))).toEqual(
      ADDRESS_PATTERNS.map(publishedPattern),
    );
    expect(
      dig(services, ["$defs", "service", "allOf", "0", "if", "properties", "base_url", "pattern"]),
    ).toBe(publishedPattern(LOOPBACK_URL));
    expect(dig(services, ["$defs", "service", "allOf", "0", "else", "required"])).toEqual([
      "tls_fingerprint256",
    ]);
    expect(dig(services, ["$defs", "service", "properties", "tls_fingerprint256", "pattern"])).toBe(
      FINGERPRINT_RE.source,
    );
    expect(dig(services, ["$defs", "service", "properties", "id", "pattern"])).toBe(
      SERVICE_ID_RE.source,
    );
    expect(dig(services, ["$defs", "tool", "properties", "name", "pattern"])).toBe(
      TOOL_NAME_RE.source,
    );

    const accepted = [
      "http://127.0.0.1/",
      "http://127.0.0.1",
      "https://127.0.0.1/",
      "http://127.0.0.1:65535/",
      "https://10.0.0.1/",
      "https://10.255.255.255:443",
      "https://172.16.0.1/",
      "https://172.31.255.255/",
      "https://192.168.1.1:8080/",
    ];
    const rejected = [
      "http://10.1.2.3/",
      "http://127.0.0.1:65536/",
      "http://127.0.0.1:0/",
      "https://172.15.0.1/",
      "https://172.32.0.1/",
      "https://192.169.1.1/",
      "https://8.8.8.8/",
      "http://0.0.0.0/",
      "http://127.0.0.2/",
      "http://localhost/",
      "http://[::1]/",
      "http://127.0.0.1/notes",
      "https://10.01.2.3/",
      "HTTP://127.0.0.1/",
    ];
    for (const url of accepted) {
      expect(addressAllowed(url)).toBe(true);
      expect(manifestOk(PATH_PARAMETERS, url, PIN)).toBe(true);
    }
    for (const url of rejected) {
      expect(addressAllowed(url)).toBe(false);
      expect(manifestOk(PATH_PARAMETERS, url, PIN)).toBe(false);
    }
    expect(addressAllowed("http://127.0.0.1/")).toBe(true);
    expect(LOOPBACK_URL.test("http://127.0.0.1/")).toBe(true);
    expect(manifestOk(PATH_PARAMETERS, "http://127.0.0.1/")).toBe(true);
    expect(LOOPBACK_URL.test("https://10.1.2.3/")).toBe(false);
    expect(manifestOk(PATH_PARAMETERS, "https://10.1.2.3/")).toBe(false);
    expect(manifestOk(PATH_PARAMETERS, "https://10.1.2.3/", "A".repeat(64))).toBe(false);
    expect(manifestOk(PATH_PARAMETERS, "https://127.0.0.1/")).toBe(true);
  });

  it("должен не пускать во вложенные properties слова, которые бракует разбор", async () => {
    const services = await readJson("harness.services.v1.schema.json");
    const parameters = dig(services, ["$defs", "parameters"]);
    expect(own(parameters, "additionalProperties")).toBe(false);
    const propertyNode = own(parameters, "properties");
    if (typeof propertyNode !== "object" || propertyNode === null || Array.isArray(propertyNode)) {
      throw new Error("properties missing");
    }
    const keys = Object.keys(propertyNode).sort();
    expect(keys).toEqual([
      "additionalProperties",
      "enum",
      "maxItems",
      "maxLength",
      "minLength",
      "properties",
      "required",
      "type",
    ]);
    expect(dig(parameters, ["properties", "properties", "additionalProperties"])).toEqual({
      $ref: "#/$defs/parameters",
    });
    expect(dig(parameters, ["properties", "properties", "maxProperties"])).toBe(32);

    expect(
      manifestOk({
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", pattern: ".*" },
        },
      }),
    ).toBe(false);
    expect(
      manifestOk({
        type: "object",
        additionalProperties: false,
        properties: {
          meta: {
            type: "object",
            additionalProperties: false,
            properties: {
              flag: { type: "boolean" },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("должен повторить в схеме запроса паттерны идентификаторов и имени", async () => {
    const requestSchema = await readJson("harness.tool.v1.request.schema.json");
    const properties = own(requestSchema, "properties");
    expect(own(own(properties, "run_id"), "pattern")).toBe(UUID_RE.source);
    expect(own(own(properties, "agent_id"), "pattern")).toBe(UUID_RE.source);
    expect(own(own(properties, "tool_call_id"), "pattern")).toBe(TOOL_CALL_ID_RE.source);
    expect(own(own(properties, "name"), "pattern")).toBe(TOOL_NAME_RE.source);

    const badRun = "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz";
    expect(badRun).toHaveLength(36);
    expect(UUID_RE.test(badRun)).toBe(false);
    expect(parseToolRequest(requestBody({ run_id: badRun })).ok).toBe(false);
    expect(TOOL_NAME_RE.test(".")).toBe(false);
    expect(parseToolRequest(requestBody({ name: "." })).ok).toBe(false);
    expect(TOOL_CALL_ID_RE.test("call:1")).toBe(false);
    expect(parseToolRequest(requestBody({ tool_call_id: "call:1" })).ok).toBe(false);
    expect(parseToolRequest(requestBody({})).ok).toBe(true);
  });

  it("должен не пускать в error символы, которые отвергает разбор", async () => {
    const responseSchema = await readJson("harness.tool.v1.response.schema.json");
    const error = dig(responseSchema, ["properties", "error"]);
    expect(own(error, "pattern")).toBe(ERROR_TEXT_PATTERN);
    expect(own(error, "minLength")).toBe(1);
    expect(own(error, "maxLength")).toBe(200);

    const samples = [
      { text: "path escapes root", ok: true },
      { text: "path\nescapes", ok: false },
      { text: "path\tescapes", ok: false },
      { text: "a\u0000b", ok: false },
      { text: "a\u007Fb", ok: false },
      { text: "a\u0085b", ok: false },
      { text: "a\u009Fb", ok: false },
      { text: "a\u00A0b", ok: true },
      { text: "", ok: false },
      { text: "a".repeat(200), ok: true },
      { text: "a".repeat(201), ok: false },
      { text: "🙂".repeat(200), ok: true },
      { text: "🙂".repeat(201), ok: false },
    ];
    for (const sample of samples) {
      expect(schemaAllowsError(sample.text)).toBe(sample.ok);
      expect(parseToolResponse(failureBody(sample.text)).ok).toBe(sample.ok);
    }
  });
});

function requestBody(override: { run_id?: string; tool_call_id?: string; name?: string }): string {
  return JSON.stringify({
    contract: CONTRACT_VERSION,
    run_id: override.run_id ?? RUN_ID,
    tool_call_id: override.tool_call_id ?? "call_1",
    agent_id: AGENT_ID,
    name: override.name ?? "read_file",
    arguments: { path: "notes/a.txt" },
  });
}

function failureBody(error: string): string {
  return JSON.stringify({
    contract: CONTRACT_VERSION,
    ok: false,
    error,
    truncated: false,
    duration_ms: 1,
    blobs: [],
  });
}

function schemaAllowsError(text: string): boolean {
  return errorUnitsAllowed(text) && codePointLength(text) >= 1 && codePointLength(text) <= 200;
}

function errorUnitsAllowed(text: string): boolean {
  if (text.length < 1 || text.length > 400) {
    return false;
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return false;
    }
  }
  return true;
}

function fieldEnum(type: string, values: readonly unknown[]): boolean {
  return manifestOk({
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type, enum: values },
    },
  });
}

function manifestOk(parameters: unknown, baseUrl = "http://127.0.0.1/", pin?: string): boolean {
  return parseServicesManifest(manifest([tool("read_file", parameters)], baseUrl, pin)).ok;
}

function addressAllowed(url: string): boolean {
  return ADDRESS_PATTERNS.some((pattern) => pattern.test(url));
}

function tool(name: string, parameters: unknown): Record<string, unknown> {
  return {
    name,
    effect: "read",
    description: "Читает файл.",
    accepts_blobs: false,
    parameters,
  };
}

function manifest(tools: unknown[], baseUrl: string, pin?: string): Record<string, unknown> {
  const service: Record<string, unknown> = {
    id: "files",
    base_url: baseUrl,
    tools,
  };
  if (pin !== undefined) {
    service.tls_fingerprint256 = pin;
  }
  return {
    contract: "harness.services.v1",
    services: [service],
  };
}

/** V8 в source экранирует слэш. В схеме слэш записан как есть. */
function publishedPattern(pattern: RegExp): string {
  return pattern.source.replaceAll("\\/", "/");
}

function findStringEnum(guards: readonly unknown[]): unknown {
  return (
    guards.find(
      (entry) => dig(entry, ["then", "properties", "enum", "items", "type"]) === "string",
    ) ?? null
  );
}

function findTypedEnum(guards: readonly unknown[], type: string): unknown {
  return (
    guards.find((entry) => {
      return (
        dig(entry, ["if", "properties", "type", "const"]) === type &&
        dig(entry, ["then", "properties", "enum", "items", "type"]) === type
      );
    }) ?? null
  );
}

async function readJson(name: string): Promise<unknown> {
  const path = fileURLToPath(new URL(`../../contract/${name}`, import.meta.url));
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function dig(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    current = own(current, key);
  }
  return current;
}

function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, key)?.value as unknown;
}
