import type { ModelOutput, ToolCall } from "./types.js";

export type ModelInterpretation =
  | { type: "tools"; calls: readonly ToolCall[] }
  | { type: "parse_error"; reason: "empty" | "json_in_text" }
  | { type: "final"; text: string };

/**
 * Исполняются только native tool_calls.
 * Весь текст как JSON вызова — parse_error, в final_text он не попадает.
 */
export function interpretModelOutput(output: ModelOutput): ModelInterpretation {
  if (output.toolCalls.length > 0) {
    return { type: "tools", calls: output.toolCalls };
  }

  if (output.content === null || output.content.trim() === "") {
    return { type: "parse_error", reason: "empty" };
  }

  if (isToolJsonInText(output.content.trim())) {
    return { type: "parse_error", reason: "json_in_text" };
  }

  return { type: "final", text: output.content };
}

function isToolJsonInText(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }

  if (Object.hasOwn(parsed, "tool_calls")) {
    return true;
  }

  return Object.hasOwn(parsed, "name") && Object.hasOwn(parsed, "arguments");
}
