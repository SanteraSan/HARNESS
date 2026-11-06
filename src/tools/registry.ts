import { toJSONSchema, type ZodType } from "zod";

import { filterToolNames, isDeniedToolName } from "../contracts/tool-policy.js";
import type { ModelToolSpec, Tool } from "../contracts/types.js";
import { listDirTool } from "./list-dir.js";
import { readFileTool } from "./read-file.js";

export const toolRegistry: readonly Tool[] = [readFileTool, listDirTool];

export type ToolDecision = { ok: true; tool: Tool } | { ok: false; error: string };

/**
 * Пересечение реестра и allowlist. Запрет имён — filterToolNames из контракта:
 * имя из списка запрета не попадает в выдачу, даже если оно есть у агента.
 */
export function toolsForAllowlist(
  allowlist: readonly string[],
  registry: readonly Tool[] = toolRegistry,
): Tool[] {
  const selected: Tool[] = [];
  const seen = new Set<string>();
  for (const name of filterToolNames(allowlist)) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const tool = findCallable(name, registry);
    if (tool !== undefined) {
      selected.push(tool);
    }
  }
  return selected;
}

/** Схема для модели берётся из zod-параметров уже отфильтрованных инструментов. */
export function modelToolsForAllowlist(
  allowlist: readonly string[],
  registry: readonly Tool[] = toolRegistry,
): ModelToolSpec[] {
  const specs: ModelToolSpec[] = [];
  for (const tool of toolsForAllowlist(allowlist, registry)) {
    specs.push({
      name: tool.name,
      description: tool.description,
      parameters: toolParameters(tool.parameters),
    });
  }
  return specs;
}

/** Неизвестное, запрещённое и write-имя отклоняется здесь. execute эта функция не вызывает. */
export function decideToolCall(
  name: string,
  allowlist: readonly string[],
  registry: readonly Tool[] = toolRegistry,
): ToolDecision {
  const permitted = filterToolNames(allowlist);
  if (!permitted.includes(name)) {
    return { ok: false, error: "tool denied" };
  }
  const tool = findCallable(name, registry);
  if (tool === undefined) {
    return { ok: false, error: "tool denied" };
  }
  return { ok: true, tool };
}

function findCallable(name: string, registry: readonly Tool[]): Tool | undefined {
  if (isDeniedToolName(name)) {
    return undefined;
  }
  for (const tool of registry) {
    if (tool.name === name && tool.effect === "read" && !isDeniedToolName(tool.name)) {
      return tool;
    }
  }
  return undefined;
}

function toolParameters(schema: ZodType): Record<string, unknown> {
  const converted: unknown = toJSONSchema(schema, { target: "draft-07" });
  if (!isRecord(converted)) {
    throw new Error("tool parameters schema is invalid");
  }
  const parameters: Record<string, unknown> = {};
  if (Object.hasOwn(converted, "type")) {
    parameters.type = converted.type;
  }
  if (Object.hasOwn(converted, "properties")) {
    parameters.properties = converted.properties;
  }
  if (Object.hasOwn(converted, "required")) {
    parameters.required = converted.required;
  }
  if (Object.hasOwn(converted, "additionalProperties")) {
    parameters.additionalProperties = converted.additionalProperties;
  }
  return parameters;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
