/* Фикстуры собирает сам тест во временном каталоге, это не путь модели. */
/* eslint-disable security/detect-non-literal-fs-filename -- временный корень теста */
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decideToolCall, modelToolsForAllowlist, toolRegistry } from "../../src/tools/registry.js";
import { recordNoteTool } from "../../src/tools/record-note.js";
import { createJail, type JailFixture } from "./temp-root.js";

describe("record_note", () => {
  let jail: JailFixture | undefined;

  beforeEach(async () => {
    jail = await createJail();
  });

  afterEach(async () => {
    await jail?.cleanup();
  });

  it("должен записать один файл и вернуть тот же результат при том же ключе", async () => {
    const root = mustJail(jail);
    const first = await recordNoteTool.execute(
      { path: "out/one.txt", text: "первая", idempotency_key: "same" },
      root.ctx,
    );
    const second = await recordNoteTool.execute(
      { path: "out/two.txt", text: "другая", idempotency_key: "same" },
      root.ctx,
    );

    expect(recordNoteTool.effect).toBe("write");
    expect(first).toEqual({
      ok: true,
      text: "wrote out/one.txt",
      truncated: false,
      entries: null,
    });
    expect(second).toEqual(first);
    expect(await readFile(path.join(root.root, "out", "one.txt"), "utf8")).toBe("первая");
    await expect(stat(path.join(root.root, "out", "two.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await noteNames(root.root)).toEqual(["one.txt"]);
  });

  it("должен создать второй файл для другого ключа", async () => {
    const root = mustJail(jail);
    await recordNoteTool.execute(
      { path: "out/one.txt", text: "первая", idempotency_key: "key-a" },
      root.ctx,
    );
    const second = await recordNoteTool.execute(
      { path: "out/two.txt", text: "вторая", idempotency_key: "key-b" },
      root.ctx,
    );

    expect(second).toEqual({
      ok: true,
      text: "wrote out/two.txt",
      truncated: false,
      entries: null,
    });
    expect(await readFile(path.join(root.root, "out", "one.txt"), "utf8")).toBe("первая");
    expect(await readFile(path.join(root.root, "out", "two.txt"), "utf8")).toBe("вторая");
    expect(await noteNames(root.root)).toEqual(["one.txt", "two.txt"]);
  });

  it("должен отказать на путь вне FILE_ROOT/out и не создать файл", async () => {
    const root = mustJail(jail);

    const outcome = await recordNoteTool.execute(
      { path: "note.txt", text: "мимо", idempotency_key: "outside-out" },
      root.ctx,
    );

    expect(outcome).toEqual({ ok: false, error: "path escapes root" });
    await expect(stat(path.join(root.root, "note.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(root.root, "out", "note.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("должен отказать на ../ и не записать файл снаружи", async () => {
    const root = mustJail(jail);
    const secret = await outsideFile(root, "harness-note-dotdot-", "sentinel-dotdot");
    const relative = path.relative(root.root, secret);
    expect(relative.startsWith(`..${path.sep}`)).toBe(true);

    const outcome = await recordNoteTool.execute(
      { path: relative, text: "pwned", idempotency_key: "dotdot" },
      root.ctx,
    );

    expect(outcome).toEqual({ ok: false, error: "path escapes root" });
    expect(await readFile(secret, "utf8")).toBe("sentinel-dotdot");
  });

  it("должен отказать на абсолютный путь снаружи и не записать файл", async () => {
    const root = mustJail(jail);
    const secret = await outsideFile(root, "harness-note-absolute-", "sentinel-absolute");

    const outcome = await recordNoteTool.execute(
      { path: secret, text: "pwned", idempotency_key: "absolute" },
      root.ctx,
    );

    expect(outcome).toEqual({ ok: false, error: "path escapes root" });
    expect(await readFile(secret, "utf8")).toBe("sentinel-absolute");
  });

  it("должен отказать на симлинк наружу и не записать файл снаружи", async () => {
    const root = mustJail(jail);
    const secret = await outsideFile(root, "harness-note-symlink-", "sentinel-symlink");
    await mkdir(path.join(root.root, "out"));
    await symlink(secret, path.join(root.root, "out", "escape.txt"));

    const outcome = await recordNoteTool.execute(
      { path: "out/escape.txt", text: "pwned", idempotency_key: "symlink" },
      root.ctx,
    );

    expect(outcome).toEqual({ ok: false, error: "path escapes root" });
    expect(await readFile(secret, "utf8")).toBe("sentinel-symlink");
  });

  it("должен отказать, если каталог out — симлинк наружу, и не записать файл", async () => {
    const root = mustJail(jail);
    const outside = await mkdtemp(path.join(tmpdir(), "harness-note-out-"));
    root.track(outside);
    await symlink(outside, path.join(root.root, "out"));

    const outcome = await recordNoteTool.execute(
      { path: "out/note.txt", text: "pwned", idempotency_key: "out-link" },
      root.ctx,
    );

    expect(outcome).toEqual({ ok: false, error: "path escapes root" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("должен отказать на симлинк каталога внутри out и не записать файл снаружи", async () => {
    const root = mustJail(jail);
    const outside = await mkdtemp(path.join(tmpdir(), "harness-note-mid-"));
    root.track(outside);
    await mkdir(path.join(root.root, "out"));
    await symlink(outside, path.join(root.root, "out", "link"));

    const outcome = await recordNoteTool.execute(
      { path: "out/link/note.txt", text: "pwned", idempotency_key: "mid-link" },
      root.ctx,
    );

    expect(outcome).toEqual({ ok: false, error: "path escapes root" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("должен отказать на симлинк в каталог с общим префиксом и не записать файл", async () => {
    const root = mustJail(jail);
    const evil = `${root.root}-evil`;
    await mkdir(evil);
    root.track(evil);
    const secret = path.join(evil, "secret.txt");
    await writeFile(secret, "sentinel-prefix", "utf8");
    await mkdir(path.join(root.root, "out"));
    await symlink(secret, path.join(root.root, "out", "prefix.txt"));

    const outcome = await recordNoteTool.execute(
      { path: "out/prefix.txt", text: "pwned", idempotency_key: "prefix" },
      root.ctx,
    );

    expect(outcome).toEqual({ ok: false, error: "path escapes root" });
    expect(await readFile(secret, "utf8")).toBe("sentinel-prefix");
  });

  it("должен записать файл во вложенный каталог внутри out", async () => {
    const root = mustJail(jail);

    const outcome = await recordNoteTool.execute(
      { path: "out/nested/note.txt", text: "внутри", idempotency_key: "nested" },
      root.ctx,
    );

    expect(outcome).toEqual({
      ok: true,
      text: "wrote out/nested/note.txt",
      truncated: false,
      entries: null,
    });
    expect(await readFile(path.join(root.root, "out", "nested", "note.txt"), "utf8")).toBe(
      "внутри",
    );
  });

  it("должен отказать, если аргументы не строки", async () => {
    const root = mustJail(jail);

    const outcome = await recordNoteTool.execute({ path: 1 }, root.ctx);

    expect(outcome).toEqual({ ok: false, error: "invalid arguments" });
  });

  it("должен быть в реестре с effect write и попадать в allowlist", () => {
    expect(recordNoteTool.effect).toBe("write");
    expect(toolRegistry.map((tool) => [tool.name, tool.effect])).toEqual([
      ["read_file", "read"],
      ["list_dir", "read"],
      ["record_note", "write"],
    ]);
    const decision = decideToolCall("record_note", ["record_note"]);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.tool).toBe(recordNoteTool);
    }
    expect(modelToolsForAllowlist(["record_note"]).map((spec) => spec.name)).toEqual([
      "record_note",
    ]);
  });
});

function mustJail(jail: JailFixture | undefined): JailFixture {
  if (jail === undefined) {
    throw new Error("jail is not ready");
  }
  return jail;
}

async function noteNames(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(path.join(root, "out"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
  const notes: string[] = [];
  for (const name of names) {
    if (name !== ".record-note") {
      notes.push(name);
    }
  }
  notes.sort();
  return notes;
}

async function outsideFile(jail: JailFixture, prefix: string, contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  jail.track(dir);
  const filePath = path.join(dir, "secret.txt");
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") {
      return code;
    }
  }
  return null;
}
