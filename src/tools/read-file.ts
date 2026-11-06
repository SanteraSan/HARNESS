/* Чтение только пути, который resolveInsideRoot уже удержал внутри корня. */
/* eslint-disable security/detect-non-literal-fs-filename -- путь после тюрьмы I19, литерал невозможен */
import { open, readFile, stat } from "node:fs/promises";

import { z } from "zod";

import type { Tool, ToolContext, ToolOutcome } from "../contracts/types.js";
import { ToolFailure } from "./failure.js";
import { resolveInsideRoot } from "./path-jail.js";
import { runTool } from "./run.js";

/** I19: в ответ и в память сверх этого лимита содержимое не попадает. */
const READ_LIMIT_BYTES = 64 * 1024;

const readFileParameters = z.object({
  path: z
    .string()
    .min(1)
    .max(4096)
    .describe("Относительный путь к текстовому файлу внутри рабочего каталога"),
});

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Читает текстовый файл UTF-8 внутри рабочего каталога. Каталог, бинарные данные и путь снаружи корня — ошибка.",
  effect: "read",
  parameters: readFileParameters,
  execute(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const parsed = readFileParameters.safeParse(args);
    if (!parsed.success) {
      return Promise.resolve({ ok: false, error: "invalid arguments" });
    }
    const userPath = parsed.data.path;
    return runTool(ctx, readFileTool.name, async () => {
      const real = await resolveInsideRoot(ctx.fileRoot, userPath);
      const loaded = await readBoundedUtf8(real);
      return { ok: true, text: loaded.text, truncated: loaded.truncated, entries: null };
    });
  },
};

async function readBoundedUtf8(realPath: string): Promise<{ text: string; truncated: boolean }> {
  const info = await stat(realPath);
  if (!info.isFile()) {
    throw new ToolFailure("not_a_file", "not a file");
  }

  // Файл толще лимита не читаем целиком: readFile забрал бы его в память без верхней границы.
  if (info.size > READ_LIMIT_BYTES) {
    const handle = await open(realPath, "r");
    try {
      const buffer = Buffer.alloc(READ_LIMIT_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, READ_LIMIT_BYTES, 0);
      const text = decodeLimited(buffer.subarray(0, bytesRead), true);
      if (text === null) {
        throw new ToolFailure("binary_content", "binary content");
      }
      return { text, truncated: true };
    } finally {
      await handle.close();
    }
  }

  const buffer = await readFile(realPath);
  if (buffer.length > READ_LIMIT_BYTES) {
    const text = decodeLimited(buffer.subarray(0, READ_LIMIT_BYTES), true);
    if (text === null) {
      throw new ToolFailure("binary_content", "binary content");
    }
    return { text, truncated: true };
  }

  const text = decodeLimited(buffer, false);
  if (text === null) {
    throw new ToolFailure("binary_content", "binary content");
  }
  return { text, truncated: false };
}

/**
 * На границе лимита последовательность UTF-8 может быть разрезана.
 * Снимаем только незавершённый хвост, середина файла не переписывается.
 */
function decodeLimited(bytes: Buffer, truncated: boolean): string | null {
  const body = truncated ? trimIncompleteTail(bytes) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

function trimIncompleteTail(bytes: Buffer): Buffer {
  const length = bytes.length;
  const window = Math.min(4, length);
  for (let back = 1; back <= window; back += 1) {
    const index = length - back;
    const byte = bytes.readUInt8(index);
    if ((byte & 0xc0) === 0x80) {
      continue;
    }
    const needed = utf8LeadLength(byte);
    if (needed === 0 || back < needed) {
      return bytes.subarray(0, index);
    }
    return bytes;
  }
  return bytes.subarray(0, Math.max(0, length - 3));
}

function utf8LeadLength(lead: number): number {
  if ((lead & 0x80) === 0) {
    return 1;
  }
  if ((lead & 0xe0) === 0xc0) {
    return 2;
  }
  if ((lead & 0xf0) === 0xe0) {
    return 3;
  }
  if ((lead & 0xf8) === 0xf0) {
    return 4;
  }
  return 0;
}
