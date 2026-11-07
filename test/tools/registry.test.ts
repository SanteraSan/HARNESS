import { z } from "zod";

import { describe, expect, it } from "vitest";

import type { Tool, ToolEffect, ToolOutcome } from "../../src/contracts/types.js";
import { listDirTool } from "../../src/tools/list-dir.js";
import { readFileTool } from "../../src/tools/read-file.js";
import { recordNoteTool } from "../../src/tools/record-note.js";
import { decideToolCall, modelToolsForAllowlist, toolRegistry } from "../../src/tools/registry.js";

describe("tool registry", () => {
  it("должен объявить у read_file и list_dir effect read, а у record_note effect write", () => {
    expect(toolRegistry.map((tool) => [tool.name, tool.effect])).toEqual([
      ["read_file", "read"],
      ["list_dir", "read"],
      ["record_note", "write"],
    ]);
    expect(readFileTool.effect).toBe("read");
    expect(listDirTool.effect).toBe("read");
    expect(recordNoteTool.effect).toBe("write");
  });

  it("должен не включать Bash в список для модели", async () => {
    const bash = spyTool("Bash");
    const bashLower = spyTool("bash");
    const specs = modelToolsForAllowlist(
      ["Bash", "bash", "read_file", "list_dir"],
      [bash.tool, bashLower.tool, ...toolRegistry],
    );

    await Promise.resolve();

    expect(specs.map((spec) => spec.name)).toEqual(["read_file", "list_dir"]);
    expect(bash.executed()).toBe(false);
    expect(bashLower.executed()).toBe(false);
    const readSpec = specs[0];
    expect(readSpec?.parameters).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
    expect(readSpec?.parameters).not.toHaveProperty("$schema");
  });

  it("должен отклонить неизвестное имя без execute", async () => {
    const spy = spyTool("read_file");

    const decision = decideToolCall("unknown_tool", ["unknown_tool", "read_file"], [spy.tool]);
    await Promise.resolve();

    expect(decision).toEqual({ ok: false, error: "tool denied" });
    expect(spy.executed()).toBe(false);
  });

  it("должен вернуть разрешённый инструмент и не вызывать execute", async () => {
    const spy = spyTool("read_file");

    const decision = decideToolCall("read_file", ["read_file"], [spy.tool]);
    await Promise.resolve();

    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.tool).toBe(spy.tool);
    }
    expect(spy.executed()).toBe(false);
  });

  it("должен отклонить имя вне allowlist без execute", async () => {
    const spy = spyTool("read_file");

    const decision = decideToolCall("read_file", ["list_dir"], [spy.tool]);
    await Promise.resolve();

    expect(decision).toEqual({ ok: false, error: "tool denied" });
    expect(spy.executed()).toBe(false);
  });

  it("должен отдать модели allowlisted инструмент с effect write и не вызывать execute", async () => {
    const writing = spyTool("write_file", "write");

    const specs = modelToolsForAllowlist(["write_file", "read_file"], [writing.tool, readFileTool]);
    const decision = decideToolCall("write_file", ["write_file"], [writing.tool]);
    const denied = decideToolCall("write_file", ["read_file"], [writing.tool]);
    await Promise.resolve();

    expect(specs.map((spec) => spec.name)).toEqual(["write_file", "read_file"]);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.tool).toBe(writing.tool);
      expect(decision.tool.effect).toBe("write");
    }
    expect(denied).toEqual({ ok: false, error: "tool denied" });
    expect(writing.executed()).toBe(false);
  });
});

function spyTool(
  name: string,
  effect: ToolEffect = "read",
): { tool: Tool; executed: () => boolean } {
  let called = false;
  const tool: Tool = {
    name,
    description: "spy",
    effect,
    parameters: z.object({}),
    execute(): Promise<ToolOutcome> {
      called = true;
      return Promise.resolve({ ok: false, error: "execute must not run" });
    },
  };
  return {
    tool,
    executed(): boolean {
      return called;
    },
  };
}
