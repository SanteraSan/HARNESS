export interface ListedTool {
  name: string;
  description: string;
  effect: "read" | "write";
  parameters: Record<string, unknown>;
}

/**
 * Пересечение манифеста и allowlist, затем вычитание запрета без учёта регистра.
 * Запрещённое имя не становится инструментом модели, даже если оно есть в обоих списках.
 */
export function selectToolsForModel(
  tools: readonly ListedTool[],
  allowlist: readonly string[],
  deniedNames: readonly string[],
): ListedTool[] {
  const denied = new Set<string>();
  for (const name of deniedNames) {
    denied.add(name.toLowerCase());
  }
  const allowed = new Set<string>();
  for (const name of allowlist) {
    if (!denied.has(name.toLowerCase())) {
      allowed.add(name);
    }
  }
  const selected: ListedTool[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      continue;
    }
    if (denied.has(tool.name.toLowerCase())) {
      continue;
    }
    if (!allowed.has(tool.name)) {
      continue;
    }
    seen.add(tool.name);
    selected.push(tool);
  }
  return selected;
}
