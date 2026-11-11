import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONTRACT_VERSION,
  HUB_TOOLS,
  RECORD_NOTE_TEXT_MAX,
  TOOL_PATH_MAX,
  canonicalBody,
} from "../../contract/index.js";

const CONTRACT_ROOT = fileURLToPath(new URL("../../contract/", import.meta.url));
const FORBIDDEN_PARAMETER_KEYS = ["pattern", "$ref", "$data", "allOf", "items", "maxItems"];

async function readJson(relative: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(CONTRACT_ROOT, relative), "utf8")) as unknown;
}

function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, key)?.value as unknown;
}

function collectKeys(value: unknown, found: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, found);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_PARAMETER_KEYS.includes(key)) {
      found.push(key);
    }
    collectKeys(own(value, key), found);
  }
}

describe("contract catalog", () => {
  it("должен держать версию файла VERSION", async () => {
    const version = (await readFile(path.join(CONTRACT_ROOT, "VERSION"), "utf8")).trim();
    expect(version).toBe(CONTRACT_VERSION);
    expect(version).toBe("harness.tool.v1");
  });

  it("должен описать три инструмента теми же полями, что и JSON", async () => {
    expect(HUB_TOOLS.map((tool) => tool.name)).toEqual(["read_file", "list_dir", "record_note"]);
    for (const tool of HUB_TOOLS) {
      const document = await readJson(`tools/${tool.name}.json`);
      expect(own(document, "name")).toBe(tool.name);
      expect(own(document, "version")).toBe(tool.version);
      expect(own(document, "effect")).toBe(tool.effect);
      expect(own(document, "description")).toBe(tool.description);
      expect(own(document, "accepts_blobs")).toBe(false);
      expect(own(own(document, "call"), "method")).toBe("POST");
      expect(own(own(document, "call"), "path")).toBe(tool.call.path);
      expect(own(own(document, "call"), "idempotency")).toBe(tool.call.idempotency);
      const forbidden: string[] = [];
      collectKeys(own(document, "parameters"), forbidden);
      expect(forbidden).toEqual([]);
      expect(own(own(document, "parameters"), "additionalProperties")).toBe(false);
    }
    const note = await readJson("tools/record_note.json");
    const text = own(own(own(note, "parameters"), "properties"), "text");
    const notePath = own(own(own(note, "parameters"), "properties"), "path");
    expect(own(text, "maxLength")).toBe(RECORD_NOTE_TEXT_MAX);
    expect(own(notePath, "maxLength")).toBe(TOOL_PATH_MAX);
    expect(own(note, "parameters") && own(own(note, "parameters"), "required")).toEqual([
      "path",
      "text",
    ]);
    expect(own(own(own(note, "parameters"), "properties"), "idempotency_key")).toBeUndefined();
  });

  it("должен совпадать с записью примера манифеста", async () => {
    const example = await readJson("examples/services.json");
    const services = own(example, "services");
    if (!Array.isArray(services)) {
      throw new Error("services");
    }
    const records: unknown[] = [];
    for (const service of services) {
      for (const item of unknownItems(own(service, "tools"))) {
        records.push(item);
      }
    }
    const names = records.map((record) => {
      const name = own(record, "name");
      if (typeof name !== "string") {
        throw new Error("name");
      }
      return name;
    });
    const files = (await readdir(path.join(CONTRACT_ROOT, "tools")))
      .filter((file) => file.endsWith(".json"))
      .sort();
    expect(files).toEqual(names.map((name) => `${name}.json`).sort());
    for (const record of records) {
      const name = own(record, "name");
      if (typeof name !== "string") {
        throw new Error("name");
      }
      const review = await readJson(`tools/${name}.json`);
      expect(withoutCall(review)).toEqual(record);
    }
  });

  it("должен прямо назвать localhost, кодпоинты и отсутствие blobs_url", async () => {
    const readme = await readFile(path.join(CONTRACT_ROOT, "README.md"), "utf8");
    const spec = await readFile(
      fileURLToPath(new URL("../../docs/spec/02-contract.md", import.meta.url)),
      "utf8",
    );
    for (const text of [readme, spec]) {
      expect(text.includes("нужен http://127.0.0.1, не localhost")).toBe(true);
      expect(text.includes("UTF-16")).toBe(true);
      expect(text.includes("blobs_url")).toBe(true);
    }
  });

  it("должен не содержать значений Authorization и не входить в воркер", async () => {
    const files = await listFiles(CONTRACT_ROOT);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text.includes("Bearer ")).toBe(false);
      expect(text.includes("sk-")).toBe(false);
    }
    for (const relative of [
      "src/worker.ts",
      "src/runner/openai-compat.ts",
      "src/runner/index.ts",
    ]) {
      const source = await readFile(
        fileURLToPath(new URL(`../../${relative}`, import.meta.url)),
        "utf8",
      );
      expect(source.includes("contract/")).toBe(false);
      expect(source.includes("parseToolCall")).toBe(false);
    }
  });

  it("должен сортировать ключи канона по байтам UTF-8 и писать -0 как 0", () => {
    const low = "\uE000";
    const high = "\u{10000}";
    const sorted = canonicalBody({ [high]: 1, [low]: 2, n: -0 });
    expect(sorted.ok).toBe(true);
    if (!sorted.ok) {
      return;
    }
    const lowAt = sorted.value.text.indexOf(JSON.stringify(low));
    const highAt = sorted.value.text.indexOf(JSON.stringify(high));
    expect(lowAt).toBeGreaterThanOrEqual(0);
    expect(highAt).toBeGreaterThan(lowAt);
    expect(sorted.value.text.includes(':"-0"') || sorted.value.text.includes(":-0")).toBe(false);
    expect(sorted.value.text.includes('"n":0')).toBe(true);
  });
});

function unknownItems(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("tools");
  }
  const items: unknown[] = [];
  for (const item of value as readonly unknown[]) {
    items.push(item);
  }
  return items;
}

function withoutCall(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("tool review is invalid");
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key === "call") {
      continue;
    }
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: own(value, key),
      writable: true,
    });
  }
  return copy;
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
      continue;
    }
    files.push(full);
  }
  return files;
}
