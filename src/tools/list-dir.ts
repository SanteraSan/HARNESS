/* Список только каталога, который resolveInsideRoot уже удержал внутри корня. */
/* eslint-disable security/detect-non-literal-fs-filename -- путь после тюрьмы I19, литерал невозможен */
import { readdir } from "node:fs/promises";

import { z } from "zod";

import type { DirectoryEntry, Tool, ToolContext, ToolOutcome } from "../contracts/types.js";
import { resolveInsideRoot } from "./path-jail.js";
import { runTool } from "./run.js";

/** Потолок текста сервиса: следующий элемент сверх этого числа кодпоинтов не добавляется. */
const LIST_DIR_TEXT_CODE_POINTS = 8000;

const listDirParameters = z.object({
  path: z
    .string()
    .min(1)
    .max(4096)
    .describe("Относительный путь каталога. Без поля — корень рабочего каталога")
    .optional(),
});

export const listDirTool: Tool = {
  name: "list_dir",
  description:
    "Показывает один уровень каталога: имя и признак каталога. Во вложенные каталоги не спускается. Имена добавляются, пока следующее не превысит 8000 кодпоинтов; иначе список обрезан.",
  effect: "read",
  parameters: listDirParameters,
  execute(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const parsed = listDirParameters.safeParse(args);
    if (!parsed.success) {
      return Promise.resolve({ ok: false, error: "invalid arguments" });
    }
    const userPath = parsed.data.path ?? ".";
    return runTool(ctx, listDirTool.name, async () => {
      const real = await resolveInsideRoot(ctx.fileRoot, userPath);
      const dirents = await readdir(real, { withFileTypes: true });
      const entries: DirectoryEntry[] = [];
      for (const dirent of dirents) {
        entries.push({ name: dirent.name, isDirectory: dirent.isDirectory() });
      }
      entries.sort((left, right) => compareNames(left.name, right.name));
      const bounded = boundListing(entries);
      return {
        ok: true,
        text: bounded.text,
        truncated: bounded.truncated,
        entries: bounded.entries,
      };
    });
  },
};

/**
 * Добавляет имена, пока следующий элемент не превысит 8000 кодпоинтов.
 * Пустой каталог — пустой текст и truncated false. Имя посередине не режется.
 */
function boundListing(entries: readonly DirectoryEntry[]): {
  text: string;
  truncated: boolean;
  entries: DirectoryEntry[];
} {
  const kept: DirectoryEntry[] = [];
  let text = "";
  for (const entry of entries) {
    const line = entry.isDirectory ? `${entry.name}/` : entry.name;
    const next = text.length === 0 ? line : `${text}\n${line}`;
    if (codePointCount(next) > LIST_DIR_TEXT_CODE_POINTS) {
      return { text, truncated: true, entries: kept };
    }
    text = next;
    kept.push(entry);
  }
  return { text, truncated: false, entries: kept };
}

function codePointCount(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length;) {
    const code = value.codePointAt(index);
    count += 1;
    index += code !== undefined && code > 0xffff ? 2 : 1;
  }
  return count;
}

function compareNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
