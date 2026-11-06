/* Путь присылает модель, литерала нет. realpath и префикс с разделителем — ниже, правило fs этого не видит. */
/* eslint-disable security/detect-non-literal-fs-filename -- проверка I19 не выражается литералом пути */
import { realpath } from "node:fs/promises";
import path from "node:path";

import { ToolFailure } from "./failure.js";

/**
 * I19: realpath корня и цели, затем префикс с разделителем.
 * Без разделителя каталог `root-evil` проходит проверку `startsWith(root)`.
 */
export async function resolveInsideRoot(fileRoot: string, userPath: string): Promise<string> {
  if (userPath.length === 0 || userPath.length > 4096 || userPath.includes("\0")) {
    throw new ToolFailure("invalid_path", "invalid path");
  }

  const rootReal = await realpath(fileRoot);
  const resolved = path.resolve(rootReal, userPath);
  if (!isInsideRoot(rootReal, resolved)) {
    throw new ToolFailure("path_rejected", "path escapes root");
  }

  const real = await realpath(resolved);
  if (!isInsideRoot(rootReal, real)) {
    throw new ToolFailure("path_rejected", "path escapes root");
  }
  return real;
}

function isInsideRoot(rootReal: string, candidate: string): boolean {
  const prefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  return candidate === rootReal || candidate.startsWith(prefix);
}
