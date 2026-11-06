import { describe, expect, it } from "vitest";

import { interpretModelOutput } from "../../src/contracts/interpret.js";
import type { ModelOutput, ToolCall } from "../../src/contracts/types.js";

function model(content: string | null, toolCalls: readonly ToolCall[] = []): ModelOutput {
  return {
    content,
    toolCalls,
    promptTokens: null,
    completionTokens: null,
    model: "agent",
  };
}

const readFileCall: ToolCall = {
  id: "call-1",
  name: "read_file",
  arguments: '{"path":"note.txt"}',
};

describe("interpretModelOutput", () => {
  it("должен вернуть tools, если в toolCalls есть вызов", () => {
    const result = interpretModelOutput(
      model('{"tool_calls":[{"name":"read_file"}]}', [readFileCall]),
    );
    expect(result).toEqual({ type: "tools", calls: [readFileCall] });
  });

  it("должен вернуть parse_error empty, если текста нет", () => {
    expect(interpretModelOutput(model(null))).toEqual({ type: "parse_error", reason: "empty" });
    expect(interpretModelOutput(model("  \n"))).toEqual({ type: "parse_error", reason: "empty" });
  });

  it("должен вернуть parse_error json_in_text, если весь текст — JSON вызова", () => {
    expect(interpretModelOutput(model('{"tool_calls":[]}'))).toEqual({
      type: "parse_error",
      reason: "json_in_text",
    });
    expect(
      interpretModelOutput(model('  {"name":"read_file","arguments":{"path":"a.txt"}}  ')),
    ).toEqual({
      type: "parse_error",
      reason: "json_in_text",
    });
  });

  it("должен вернуть final и сохранить исходный текст, если это не JSON вызова", () => {
    expect(interpretModelOutput(model("  файл пуст  "))).toEqual({
      type: "final",
      text: "  файл пуст  ",
    });
    expect(interpretModelOutput(model('{"message":"просто ответ"}'))).toEqual({
      type: "final",
      text: '{"message":"просто ответ"}',
    });
    expect(interpretModelOutput(model('смотри {"name":"read_file","arguments":{}}'))).toEqual({
      type: "final",
      text: 'смотри {"name":"read_file","arguments":{}}',
    });
    expect(interpretModelOutput(model('{"name":"read_file"}'))).toEqual({
      type: "final",
      text: '{"name":"read_file"}',
    });
  });
});
