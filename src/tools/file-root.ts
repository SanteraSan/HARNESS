/* FILE_ROOT задаёт конфигурация, литерала нет. realpath и префикс с разделителем — ниже. */
/* eslint-disable security/detect-non-literal-fs-filename -- корень процесса не бывает литералом */
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Корень репозитория относительно этого файла: src/tools → корень пакета.
 * Сравнение идёт по realpath, не по строке из конфига.
 */
export function repositoryRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

export class FileRootError extends Error {
  readonly code = "invalid_file_root";

  constructor(message: string) {
    super(message);
    this.name = "FileRootError";
  }
}

/**
 * I19 на старте процесса: тюрьма не может быть репозиторием, его предком,
 * домашним каталогом или каталогом с `.env`.
 * Префикс только с разделителем: каталог `root-evil` не считается корнем `root`.
 */
export async function assertFileRoot(fileRoot: string): Promise<void> {
  if (fileRoot.trim().length === 0) {
    throw new FileRootError("file root is empty");
  }
  const rootReal = await realpath(fileRoot);
  const repoReal = await realpath(repositoryRoot());
  const homeReal = await realpath(homedir());
  if (
    rootReal === repoReal ||
    rootReal === homeReal ||
    directoryContains(rootReal, repoReal)
  ) {
    throw new FileRootError("file root escapes workspace");
  }
  if (await pathExists(path.join(rootReal, ".env"))) {
    throw new FileRootError("file root contains .env");
  }
}

function directoryContains(parent: string, child: string): boolean {
  const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(prefix);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
