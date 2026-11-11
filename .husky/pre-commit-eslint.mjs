import { execFile } from "node:child_process";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

import { ESLint } from "eslint";

// Имена из индекса уходят в ESLint массивом. Оболочка из них не собирается:
// git вызывается execFile с постоянным списком аргументов, без shell.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
]);

function readCachedNames() {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["diff", "--cached", "-z", "--name-only", "--diff-filter=ACMR"],
      { cwd: repoRoot, maxBuffer: 1_048_576, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error instanceof Error ? error : new Error("git diff не прочитан"));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function isRepoPath(name) {
  if (name.length === 0 || name.length > 4096 || name.startsWith("/") || name.startsWith("-")) {
    return false;
  }
  if (
    name === "eslint.config.js" ||
    name.startsWith("node_modules/") ||
    name.startsWith("dist/") ||
    name.startsWith("coverage/")
  ) {
    return false;
  }
  const parts = name.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      return false;
    }
  }
  return true;
}

function extensionOf(name) {
  const slash = name.lastIndexOf("/");
  const base = slash === -1 ? name : name.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return base.slice(dot);
}

const raw = await readCachedNames();
const files = [];
for (const name of raw.split("\0")) {
  if (!isRepoPath(name) || !sourceExtensions.has(extensionOf(name))) {
    continue;
  }
  files.push(name);
}

if (files.length === 0) {
  process.exit(0);
}

const eslint = new ESLint({
  cwd: repoRoot,
  errorOnUnmatchedPattern: false,
});
const results = await eslint.lintFiles(files);
const formatter = await eslint.loadFormatter("stylish");
const text = await formatter.format(results);
if (text.length > 0) {
  process.stdout.write(text);
}

let errors = 0;
for (const result of results) {
  errors += result.errorCount;
}
if (errors > 0) {
  process.exit(1);
}
