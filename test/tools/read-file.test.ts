/* Фикстуры собирает сам тест во временном каталоге, это не путь модели. */
/* eslint-disable security/detect-non-literal-fs-filename -- временный корень теста */
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFileTool } from "../../src/tools/read-file.js";
import { createJail, type JailFixture } from "./temp-root.js";

const READ_LIMIT_BYTES = 64 * 1024;

describe("read_file", () => {
  let jail: JailFixture | undefined;

  beforeEach(async () => {
    jail = await createJail();
  });

  afterEach(async () => {
    await jail?.cleanup();
  });

  it("должен прочитать файл внутри корня", async () => {
    const root = mustJail(jail);
    await writeFile(path.join(root.root, "note.txt"), "привет", "utf8");

    const outcome = await readFileTool.execute({ path: "note.txt" }, root.ctx);

    expect(readFileTool.effect).toBe("read");
    expect(outcome).toEqual({ ok: true, text: "привет", truncated: false, entries: null });
  });

  it("должен отказать на ../ и не прочитать файл снаружи", async () => {
    const root = mustJail(jail);
    const secret = await outsideFile(root, "harness-outside-", "sentinel-dotdot");
    const relative = path.relative(root.root, secret);
    expect(relative.startsWith(`..${path.sep}`)).toBe(true);

    const outcome = await readFileTool.execute({ path: relative }, root.ctx);

    expect(outcome).toEqual({ ok: false, error: "path escapes root" });
  });

  it("должен отказать на абсолютный путь снаружи и не прочитать файл", async () => {
    const root = mustJail(jail);
    const secret = await outsideFile(root, "harness-absolute-", "sentinel-absolute");

    const outcome = await readFileTool.execute({ path: secret }, root.ctx);

    expect(outcome).toEqual({ ok: false, error: "path escapes root" });
  });

  it("должен отказать на симлинк наружу и не прочитать файл", async () => {
    const root = mustJail(jail);
    const secret = await outsideFile(root, "harness-symlink-", "sentinel-symlink");
    await symlink(secret, path.join(root.root, "escape.txt"));

    const outcome = await readFileTool.execute({ path: "escape.txt" }, root.ctx);

    expect(outcome).toEqual({ ok: false, error: "path escapes root" });
  });

  it("должен отказать на каталог с общим префиксом имени", async () => {
    const root = mustJail(jail);
    const evil = `${root.root}-evil`;
    await mkdir(evil);
    root.track(evil);
    const secret = path.join(evil, "secret.txt");
    await writeFile(secret, "sentinel-prefix", "utf8");
    await symlink(secret, path.join(root.root, "prefix.txt"));

    const outcome = await readFileTool.execute({ path: "prefix.txt" }, root.ctx);

    expect(outcome).toEqual({ ok: false, error: "path escapes root" });
  });

  it("должен прочитать симлинк, который остаётся внутри корня", async () => {
    const root = mustJail(jail);
    await writeFile(path.join(root.root, "note.txt"), "внутри", "utf8");
    await symlink(path.join(root.root, "note.txt"), path.join(root.root, "alias.txt"));

    const outcome = await readFileTool.execute({ path: "alias.txt" }, root.ctx);

    expect(outcome).toEqual({ ok: true, text: "внутри", truncated: false, entries: null });
  });

  it("должен обрезать файл больше 64 КиБ и поставить truncated", async () => {
    const root = mustJail(jail);
    const payload = "q".repeat(READ_LIMIT_BYTES + 32);
    await writeFile(path.join(root.root, "big.txt"), payload, "utf8");

    const outcome = await readFileTool.execute({ path: "big.txt" }, root.ctx);

    expect(outcome).toEqual({
      ok: true,
      text: "q".repeat(READ_LIMIT_BYTES),
      truncated: true,
      entries: null,
    });
  });

  it("должен прочитать файл ровно в 64 КиБ без обрезки", async () => {
    const root = mustJail(jail);
    const payload = "b".repeat(READ_LIMIT_BYTES);
    await writeFile(path.join(root.root, "exact.txt"), payload, "utf8");

    const outcome = await readFileTool.execute({ path: "exact.txt" }, root.ctx);

    expect(outcome).toEqual({ ok: true, text: payload, truncated: false, entries: null });
  });

  it("должен обрезать незавершённый символ UTF-8 на границе лимита", async () => {
    const root = mustJail(jail);
    const head = "a".repeat(READ_LIMIT_BYTES - 1);
    await writeFile(path.join(root.root, "split.txt"), `${head}яzzz`, "utf8");

    const outcome = await readFileTool.execute({ path: "split.txt" }, root.ctx);

    expect(outcome).toEqual({ ok: true, text: head, truncated: true, entries: null });
  });

  it("должен отказать, если путь указывает на каталог", async () => {
    const root = mustJail(jail);
    await mkdir(path.join(root.root, "dir"));

    const outcome = await readFileTool.execute({ path: "dir" }, root.ctx);

    expect(outcome).toEqual({ ok: false, error: "not a file" });
  });

  it("должен отказать на бинарное содержимое", async () => {
    const root = mustJail(jail);
    await writeFile(path.join(root.root, "bin.dat"), Buffer.from([0xff, 0xfe, 0xfd]));

    const outcome = await readFileTool.execute({ path: "bin.dat" }, root.ctx);

    expect(outcome).toEqual({ ok: false, error: "binary content" });
  });

  it("должен отказать, если path не строка", async () => {
    const root = mustJail(jail);

    const outcome = await readFileTool.execute({ path: 1 }, root.ctx);

    expect(outcome).toEqual({ ok: false, error: "invalid arguments" });
  });
});

function mustJail(jail: JailFixture | undefined): JailFixture {
  if (jail === undefined) {
    throw new Error("jail is not ready");
  }
  return jail;
}

async function outsideFile(jail: JailFixture, prefix: string, contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  jail.track(dir);
  const filePath = path.join(dir, "secret.txt");
  await writeFile(filePath, contents, "utf8");
  return filePath;
}
