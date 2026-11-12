/* Фикстуры собирает сам тест во временном каталоге, это не путь модели. */
/* eslint-disable security/detect-non-literal-fs-filename -- временный корень теста */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listDirTool } from "../../src/tools/list-dir.js";
import { createJail, type JailFixture } from "./temp-root.js";

describe("list_dir", () => {
  let jail: JailFixture | undefined;

  beforeEach(async () => {
    jail = await createJail();
  });

  afterEach(async () => {
    await jail?.cleanup();
  });

  it("должен показать один уровень и не спускаться во вложенный каталог", async () => {
    const root = mustJail(jail);
    await mkdir(path.join(root.root, "nested", "deep"), { recursive: true });
    await writeFile(path.join(root.root, "top.txt"), "top", "utf8");
    await writeFile(path.join(root.root, "nested", "inner.txt"), "inner", "utf8");
    await writeFile(path.join(root.root, "nested", "deep", "hidden.txt"), "hidden", "utf8");

    const outcome = await listDirTool.execute({}, root.ctx);
    const nested = await listDirTool.execute({ path: "nested" }, root.ctx);
    const dotted = await listDirTool.execute({ path: "." }, root.ctx);

    expect(listDirTool.effect).toBe("read");
    expect(outcome).toEqual({
      ok: true,
      text: "nested/\ntop.txt",
      truncated: false,
      entries: [
        { name: "nested", isDirectory: true },
        { name: "top.txt", isDirectory: false },
      ],
    });
    expect(dotted).toEqual(outcome);
    expect(nested).toEqual({
      ok: true,
      text: "deep/\ninner.txt",
      truncated: false,
      entries: [
        { name: "deep", isDirectory: true },
        { name: "inner.txt", isDirectory: false },
      ],
    });
  });

  it("должен отказать на ../ и не показать внешний каталог", async () => {
    const root = mustJail(jail);

    const outcome = await listDirTool.execute({ path: ".." }, root.ctx);

    expect(outcome).toEqual({ ok: false, error: "path escapes root" });
  });

  it("должен отказать на симлинк каталога снаружи", async () => {
    const root = mustJail(jail);
    const evil = `${root.root}-evil`;
    await mkdir(path.join(evil, "nested"), { recursive: true });
    root.track(evil);
    await writeFile(path.join(evil, "hidden-outside.txt"), "sentinel-list-prefix", "utf8");
    await symlink(evil, path.join(root.root, "linked-out"));

    const outcome = await listDirTool.execute({ path: "linked-out" }, root.ctx);

    expect(outcome).toEqual({ ok: false, error: "path escapes root" });
  });

  it("должен вернуть пустой каталог без обрезки", async () => {
    const root = mustJail(jail);

    const outcome = await listDirTool.execute({}, root.ctx);

    expect(outcome).toEqual({ ok: true, text: "", truncated: false, entries: [] });
  });

  it("должен остановить список перед именем, которое превысит 8000 кодпоинтов", async () => {
    const root = mustJail(jail);
    const names: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const name = `${String(index).padStart(2, "0")}${"x".repeat(198)}`;
      names.push(name);
      await writeFile(path.join(root.root, name), "x", "utf8");
    }

    const outcome = await listDirTool.execute({}, root.ctx);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const lines = outcome.text.split("\n");
    expect(outcome.truncated).toBe(true);
    expect(lines).toHaveLength(39);
    expect([...outcome.text].length).toBeLessThanOrEqual(8000);
    expect(lines[0]).toBe(names[0]);
    expect(outcome.text.includes(names[39] ?? "")).toBe(false);
    expect(outcome.entries).toHaveLength(39);
  });

  it("должен отказать, если path указывает на файл", async () => {
    const root = mustJail(jail);
    await writeFile(path.join(root.root, "note.txt"), "text", "utf8");

    const outcome = await listDirTool.execute({ path: "note.txt" }, root.ctx);

    expect(outcome).toEqual({ ok: false, error: "not a directory" });
  });
});

function mustJail(jail: JailFixture | undefined): JailFixture {
  if (jail === undefined) {
    throw new Error("jail is not ready");
  }
  return jail;
}
