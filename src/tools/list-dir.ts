/* Список только каталога, который resolveInsideRoot уже удержал внутри корня. */
/* eslint-disable security/detect-non-literal-fs-filename -- путь после тюрьмы I19, литерал невозможен */
import { readdir } from "node:fs/promises";

import { z } from "zod";

import type { DirectoryEntry, Tool, ToolContext, ToolOutcome } from "../contracts/types.js";
import { resolveInsideRoot } from "./path-jail.js";
import { runTool } from "./run.js";

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
    "Показывает один уровень каталога: имя и признак каталога. Во вложенные каталоги не спускается.",
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
      return { ok: true, text: listingText(entries), truncated: false, entries };
    });
  },
};

function listingText(entries: readonly DirectoryEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(entry.isDirectory ? `${entry.name}/` : entry.name);
  }
  return lines.join("\n");
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
