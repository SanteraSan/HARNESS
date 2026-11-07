import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";

import { CronError } from "./errors.js";

/**
 * Скрипт крона — процесс без модели.
 * Только spawn с массивом argv и shell: false. Строка оболочки не собирается.
 * В дочерний процесс не копируется окружение с секретами.
 */

const ARG_MAX = 200;

const ARGV_MAX = 8;

export type AllowedCommand = "true" | "false" | "echo";

type AllowedPath =
  "/usr/bin/true" | "/bin/true" | "/usr/bin/false" | "/bin/false" | "/usr/bin/echo" | "/bin/echo";

export interface ParsedCommand {
  name: AllowedCommand;
  args: readonly string[];
}

const resolved = new Map<AllowedCommand, AllowedPath>();

export function parseCommand(argv: readonly string[]): ParsedCommand | null {
  if (argv.length < 1 || argv.length > ARGV_MAX) {
    return null;
  }
  const name = argv[0];
  if (!isAllowedName(name)) {
    return null;
  }
  const args: string[] = [];
  let header = true;
  for (const arg of argv) {
    if (header) {
      header = false;
      continue;
    }
    if (typeof arg !== "string" || !isSafeArg(arg)) {
      return null;
    }
    args.push(arg);
  }
  return { name, args };
}

export async function runAllowlisted(
  name: AllowedCommand,
  args: readonly string[],
): Promise<number> {
  const executable = await resolveExecutable(name);
  return spawnAllowlisted(executable, args);
}

function isAllowedName(value: unknown): value is AllowedCommand {
  return value === "true" || value === "false" || value === "echo";
}

function isSafeArg(arg: string): boolean {
  if (arg.length < 1 || arg.length > ARG_MAX) {
    return false;
  }
  for (let index = 0; index < arg.length; index += 1) {
    const code = arg.charCodeAt(index);
    if (code < 32 || code === 127 || isShellMeta(code)) {
      return false;
    }
  }
  return true;
}

function isShellMeta(code: number): boolean {
  return (
    code === 34 ||
    code === 36 ||
    code === 38 ||
    code === 39 ||
    code === 40 ||
    code === 41 ||
    code === 59 ||
    code === 60 ||
    code === 62 ||
    code === 92 ||
    code === 96 ||
    code === 124
  );
}

async function resolveExecutable(name: AllowedCommand): Promise<AllowedPath> {
  const cached = resolved.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const found = await findExecutable(name);
  if (found === null) {
    throw new CronError("allowlist_unavailable", "allowlisted executable is missing");
  }
  resolved.set(name, found);
  return found;
}

async function findExecutable(name: AllowedCommand): Promise<AllowedPath | null> {
  if (name === "true") {
    if (await probe("/usr/bin/true")) {
      return "/usr/bin/true";
    }
    if (await probe("/bin/true")) {
      return "/bin/true";
    }
    return null;
  }
  if (name === "false") {
    if (await probe("/usr/bin/false")) {
      return "/usr/bin/false";
    }
    if (await probe("/bin/false")) {
      return "/bin/false";
    }
    return null;
  }
  if (await probe("/usr/bin/echo")) {
    return "/usr/bin/echo";
  }
  if (await probe("/bin/echo")) {
    return "/bin/echo";
  }
  return null;
}

function probe(file: AllowedPath): Promise<boolean> {
  if (file === "/usr/bin/true") {
    return access("/usr/bin/true", constants.X_OK).then(
      () => true,
      () => false,
    );
  }
  if (file === "/bin/true") {
    return access("/bin/true", constants.X_OK).then(
      () => true,
      () => false,
    );
  }
  if (file === "/usr/bin/false") {
    return access("/usr/bin/false", constants.X_OK).then(
      () => true,
      () => false,
    );
  }
  if (file === "/bin/false") {
    return access("/bin/false", constants.X_OK).then(
      () => true,
      () => false,
    );
  }
  if (file === "/usr/bin/echo") {
    return access("/usr/bin/echo", constants.X_OK).then(
      () => true,
      () => false,
    );
  }
  return access("/bin/echo", constants.X_OK).then(
    () => true,
    () => false,
  );
}

function spawnAllowlisted(executable: AllowedPath, args: readonly string[]): Promise<number> {
  const argv = args.slice();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      shell: false,
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin" },
    });
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      settle();
    };
    child.once("error", (error: Error) => {
      finish(() => {
        reject(error);
      });
    });
    child.once("close", (code) => {
      finish(() => {
        resolve(typeof code === "number" ? code : 1);
      });
    });
  });
}
