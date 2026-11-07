/* Запись только в каталог, который resolveInsideRoot уже удержал внутри out. */
/* eslint-disable security/detect-non-literal-fs-filename -- путь после тюрьмы I19, литерал невозможен */
import { createHash } from "node:crypto";
import { type Stats } from "node:fs";
import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { Tool, ToolContext, ToolOutcome } from "../contracts/types.js";
import { ToolFailure } from "./failure.js";
import { resolveInsideRoot } from "./path-jail.js";
import { runTool } from "./run.js";

/** Каталог побочного эффекта. Файл вне него — ошибка, даже если путь внутри FILE_ROOT. */
const OUT_DIR = "out";

/**
 * Служебные файлы ключа. Сегмент с этим именем в path не принимается,
 * чтобы вызов не перезаписал чужой результат.
 */
const LEDGER_DIR = ".record-note";

/** I19: в файл не пишем больше, чем read_file согласен прочитать. */
const NOTE_BYTES = 64 * 1024;

const recordNoteParameters = z.object({
  path: z.string().min(1).max(4096).describe("Путь файла внутри каталога out рабочего каталога"),
  text: z.string().min(1).max(NOTE_BYTES).describe("Текст заметки, UTF-8"),
  idempotency_key: z
    .string()
    .min(1)
    .max(256)
    .describe("Ключ идемпотентности: повтор возвращает первый результат"),
});

interface NoteRequest {
  path: string;
  text: string;
  idempotencyKey: string;
}

export const recordNoteTool: Tool = {
  name: "record_note",
  description:
    "Записывает текстовый файл в каталог out. Повтор с тем же ключом идемпотентности возвращает первый результат и не создаёт второй файл.",
  effect: "write",
  parameters: recordNoteParameters,
  execute(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const parsed = recordNoteParameters.safeParse(args);
    if (!parsed.success) {
      return Promise.resolve({ ok: false, error: "invalid arguments" });
    }
    if (Buffer.byteLength(parsed.data.text, "utf8") > NOTE_BYTES) {
      return Promise.resolve({ ok: false, error: "invalid arguments" });
    }
    const request: NoteRequest = {
      path: parsed.data.path,
      text: parsed.data.text,
      idempotencyKey: parsed.data.idempotency_key,
    };
    return runTool(ctx, recordNoteTool.name, () => writeNote(ctx, request));
  },
};

async function writeNote(ctx: ToolContext, request: NoteRequest): Promise<ToolOutcome> {
  const replay = await readReplay(ctx.fileRoot, ctx.agentId, request.idempotencyKey);
  if (replay !== null) {
    return written(replay);
  }

  const segments = noteSegments(request.path);
  const outReal = await openOut(ctx.fileRoot, true);
  const target = await resolveNewNote(outReal, segments);
  const outcomeText = `wrote ${segments.join("/")}`;
  const raced = await commitNote(
    outReal,
    ctx.agentId,
    request.idempotencyKey,
    target,
    segments.slice(1).join("/"),
    request.text,
    outcomeText,
  );
  return written(raced ?? outcomeText);
}

function written(text: string): ToolOutcome {
  return { ok: true, text, truncated: false, entries: null };
}

/**
 * Путь относительно FILE_ROOT: первый сегмент только `out`, без `..` и без абсолютного корня.
 * realpath отсутствующего файла невозможен, поэтому дальше тюрьма проверяет существующие каталоги,
 * а имя файла остаётся одним сегментом.
 */
function noteSegments(userPath: string): string[] {
  if (userPath.length === 0 || userPath.length > 4096 || userPath.includes("\0")) {
    throw new ToolFailure("invalid_path", "invalid path");
  }
  if (path.isAbsolute(userPath) || path.win32.isAbsolute(userPath)) {
    throw new ToolFailure("path_rejected", "path escapes root");
  }

  const segments: string[] = [];
  let current = "";
  for (const char of userPath) {
    if (char === "/" || char === "\\") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);

  if (segments.length < 2 || segments[0] !== OUT_DIR) {
    throw new ToolFailure("path_rejected", "path escapes root");
  }
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment.length > 255 ||
      segment === "." ||
      segment === ".." ||
      segment === LEDGER_DIR
    ) {
      throw new ToolFailure("path_rejected", "path escapes root");
    }
  }
  return segments;
}

/**
 * Корень записи — реальный каталог FILE_ROOT/out, не симлинк.
 * resolveInsideRoot(fileRoot, "out") принимает симлинк на другой каталог внутри корня:
 * realpath уводит цель из каталога out. Такой out — ошибка, файл не пишется.
 */
async function openOut(fileRoot: string, create: true): Promise<string>;
async function openOut(fileRoot: string, create: false): Promise<string | null>;
async function openOut(fileRoot: string, create: boolean): Promise<string | null> {
  const rootReal = await resolveInsideRoot(fileRoot, ".");
  const outLexical = path.join(rootReal, OUT_DIR);
  let info = await lstatIfExists(outLexical);
  if (info !== null && info.isSymbolicLink()) {
    throw new ToolFailure("path_rejected", "path escapes root");
  }
  if (info === null) {
    if (!create) {
      return null;
    }
    await mkdirIfMissing(outLexical);
    info = await lstatIfExists(outLexical);
  }
  if (info === null || info.isSymbolicLink()) {
    throw new ToolFailure("path_rejected", "path escapes root");
  }
  if (!info.isDirectory()) {
    throw new ToolFailure("not_a_directory", "not a directory");
  }
  const outReal = await resolveInsideRoot(rootReal, OUT_DIR);
  if (outReal !== outLexical) {
    throw new ToolFailure("path_rejected", "path escapes root");
  }
  return outReal;
}

async function resolveNewNote(outReal: string, segments: readonly string[]): Promise<string> {
  const inside = segments.slice(1);
  const fileName = inside[inside.length - 1];
  if (fileName === undefined) {
    throw new ToolFailure("invalid_path", "invalid path");
  }

  let parent = outReal;
  let relative = "";
  for (const directory of inside.slice(0, -1)) {
    relative = relative.length === 0 ? directory : `${relative}/${directory}`;
    await mkdirIfMissing(path.join(parent, directory));
    parent = await resolveInsideRoot(outReal, relative);
    await assertDirectory(parent);
  }

  try {
    const existing = await resolveInsideRoot(parent, fileName);
    const info = await stat(existing);
    if (info.isDirectory()) {
      throw new ToolFailure("not_a_file", "not a file");
    }
    throw new ToolFailure("exists", "file exists");
  } catch (error) {
    if (error instanceof ToolFailure) {
      throw error;
    }
    if (errorCode(error) === "ENOENT") {
      return path.join(parent, fileName);
    }
    throw error;
  }
}

/**
 * Повтор ключа читается до создания файла. Нет каталога out — записи ещё не было.
 * agentId входит в хеш: чужой агент с тем же ключом не получает чужой результат.
 */
async function readReplay(
  fileRoot: string,
  agentId: string,
  idempotencyKey: string,
): Promise<string | null> {
  const outReal = await openOut(fileRoot, false);
  if (outReal === null) {
    return null;
  }
  const ledgerInfo = await statIfExists(path.join(outReal, LEDGER_DIR));
  if (ledgerInfo === null || !ledgerInfo.isDirectory()) {
    return null;
  }
  const ledgerDir = await resolveInsideRoot(outReal, LEDGER_DIR);
  return readLedgerFile(ledgerDir, ledgerName(agentId, idempotencyKey));
}

async function commitNote(
  outReal: string,
  agentId: string,
  idempotencyKey: string,
  target: string,
  relativeInsideOut: string,
  text: string,
  outcomeText: string,
): Promise<string | null> {
  await mkdirIfMissing(path.join(outReal, LEDGER_DIR));
  const ledgerDir = await resolveInsideRoot(outReal, LEDGER_DIR);
  await assertDirectory(ledgerDir);
  const name = ledgerName(agentId, idempotencyKey);
  const existing = await readLedgerFile(ledgerDir, name);
  if (existing !== null) {
    return existing;
  }
  const ledgerFile = path.join(ledgerDir, name);
  const payload = JSON.stringify({ text: outcomeText });

  try {
    await writeFile(ledgerFile, payload, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
    const winner = await readLedgerFile(ledgerDir, name);
    if (winner === null) {
      throw new ToolFailure("bad_ledger", "tool failed");
    }
    return winner;
  }

  try {
    await writeFile(target, text, { encoding: "utf8", flag: "wx" });
    // Реальный путь уже созданного файла обязан остаться внутри каталога out.
    await resolveInsideRoot(outReal, relativeInsideOut);
  } catch (error) {
    await rm(target, { force: true });
    await rm(ledgerFile, { force: true });
    throw error;
  }
  return null;
}

function ledgerName(agentId: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(agentId, "utf8")
    .update("\0")
    .update(idempotencyKey, "utf8")
    .digest("hex");
  return `${digest}.json`;
}

/** realpath файла ключа: симлинк наружу не читается и не становится результатом. */
async function readLedgerFile(ledgerDir: string, name: string): Promise<string | null> {
  let real: string;
  try {
    real = await resolveInsideRoot(ledgerDir, name);
  } catch (error) {
    if (error instanceof ToolFailure) {
      throw error;
    }
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
  return readLedger(real);
}

async function readLedger(ledgerFile: string): Promise<string | null> {
  const info = await statIfExists(ledgerFile);
  if (info === null) {
    return null;
  }
  if (!info.isFile()) {
    throw new ToolFailure("bad_ledger", "tool failed");
  }
  // Размер журнала не превращает повтор ключа в ошибку: возвращается первый результат.
  const raw = await readFile(ledgerFile);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new ToolFailure("bad_ledger", "tool failed");
  }
  return parseLedger(decoded);
}

function parseLedger(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ToolFailure("bad_ledger", "tool failed");
  }
  if (!isLedgerRecord(value) || !Object.hasOwn(value, "text")) {
    throw new ToolFailure("bad_ledger", "tool failed");
  }
  const text = value.text;
  if (typeof text !== "string" || text.length === 0) {
    throw new ToolFailure("bad_ledger", "tool failed");
  }
  return text;
}

/** JSON.parse объекта. Чужие ключи не копируются: читается только text. */
function isLedgerRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function assertDirectory(directory: string): Promise<void> {
  const info = await stat(directory);
  if (!info.isDirectory()) {
    throw new ToolFailure("not_a_directory", "not a directory");
  }
}

async function mkdirIfMissing(directory: string): Promise<void> {
  try {
    await mkdir(directory);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
  }
}

async function lstatIfExists(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function statIfExists(target: string): Promise<Stats | null> {
  try {
    return await stat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && code.length > 0 && code.length <= 32) {
      return code;
    }
  }
  return null;
}
