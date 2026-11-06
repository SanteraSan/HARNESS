/** Канонические имена. Проверка ниже идёт без учёта регистра. read_file и list_dir сюда не входят. */
export const DENIED_TOOL_NAMES = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "bash",
  "read",
  "write",
  "edit",
  "multi_edit",
  "glob",
  "grep",
  "ls",
  "todo_read",
  "todo_write",
  "web_fetch",
  "web_search",
] as const;

const deniedLookup = new Set(DENIED_TOOL_NAMES.map((name) => name.toLowerCase()));

export function isDeniedToolName(name: string): boolean {
  return deniedLookup.has(name.toLowerCase());
}

/** Запрет сильнее allowlist: имя из списка не попадает в выдачу, даже если оно разрешено агенту. */
export function filterToolNames(allowlist: readonly string[]): string[] {
  const allowed: string[] = [];
  for (const name of allowlist) {
    if (!isDeniedToolName(name)) {
      allowed.push(name);
    }
  }
  return allowed;
}
