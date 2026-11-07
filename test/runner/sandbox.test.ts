import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DENIED_TOOL_NAMES } from "../../src/contracts/tool-policy.js";
import {
  admitNetworkTarget,
  buildSandboxPolicy,
  SandboxPolicyError,
  type NetworkEffect,
  type SandboxPolicy,
  type SandboxPolicyInput,
} from "../../src/runner/sandbox.js";

const GATEWAY = "http://127.0.0.1:4000/v1";
const MCP = "http://127.0.0.1:8765/mcp";
const GATEWAY_ORIGIN = "http://127.0.0.1:4000";
const MCP_ORIGIN = "http://127.0.0.1:8765";

describe("sandbox policy", () => {
  it("должен не включать в политику SDK Bash, Read, Write, Edit и имена запрета M1", () => {
    const policy = policyWithTools([
      "read_file",
      "Bash",
      "ReAd",
      "Write",
      "Edit",
      "reading",
      ...DENIED_TOOL_NAMES,
      "list_dir",
      "bAsH",
    ]);

    expect(policy.allowedTools).toEqual(["read_file", "reading", "list_dir"]);
    expect(policy.allowedTools).not.toContain("Bash");
    expect(policy.allowedTools).not.toContain("Read");
    expect(policy.allowedTools).not.toContain("Write");
    expect(policy.allowedTools).not.toContain("Edit");
    for (const name of DENIED_TOOL_NAMES) {
      expect(policy.allowedTools).not.toContain(name);
      expect(policy.allowedTools).not.toContain(name.toLowerCase());
    }
    expect(policy.disallowedTools).toBe(DENIED_TOOL_NAMES);
    expect(policy.homeDirectory).toBeNull();
  });

  it("должен оставить процесс запуска без домашнего каталога пользователя", () => {
    const policy = buildSandboxPolicy({
      modelGateway: GATEWAY,
      mcpOrigins: [MCP],
    });

    expect(policy.homeDirectory).toBeNull();
  });

  it("должен открыть сеть только шлюзу модели и явно перечисленным MCP", () => {
    const policy = buildSandboxPolicy({
      modelGateway: GATEWAY,
      mcpOrigins: [MCP, MCP, GATEWAY],
    });

    expect(policy.networkOrigins).toEqual([GATEWAY_ORIGIN, MCP_ORIGIN]);
    expect(policy.allowedTools).toEqual([]);
  });

  it("должен отказать, если шлюз или MCP не являются http(s) origin", () => {
    expect(policyError({ modelGateway: "file:///tmp/gateway", mcpOrigins: [] }).code).toBe(
      "invalid_gateway",
    );
    expect(policyError({ modelGateway: "not-a-url", mcpOrigins: [] }).code).toBe("invalid_gateway");
    expect(
      policyError({
        modelGateway: "http://user:test-secret-value@127.0.0.1:4000",
        mcpOrigins: [],
      }).code,
    ).toBe("invalid_gateway");
    expect(policyError(notAnArray("mcpOrigins")).code).toBe("invalid_mcp");
    expect(policyError(notAnArray("requestedTools")).code).toBe("invalid_tools");
    expect(policyError({ modelGateway: GATEWAY, mcpOrigins: ["ws://127.0.0.1:8765"] }).code).toBe(
      "invalid_mcp",
    );
    expect(
      policyError({ modelGateway: GATEWAY, mcpOrigins: ["http://192.0.2.10\\evil"] }).code,
    ).toBe("invalid_mcp");
  });

  it("должен допустить цель шлюза и перечисленного MCP и вызвать только её", () => {
    const policy = networkPolicy();
    const calls: string[] = [];
    const effect = recordingEffect(calls);
    const gatewayTarget = "http://127.0.0.1:4000/v1/chat/completions";
    const mcpTarget = "http://127.0.0.1:8765/mcp";

    expect(admitNetworkTarget(policy, gatewayTarget, effect)).toEqual({ admitted: true });
    expect(admitNetworkTarget(policy, "http://192.0.2.10/secret", effect)).toEqual({
      admitted: false,
      reason: "network_denied",
    });
    expect(admitNetworkTarget(policy, mcpTarget, effect)).toEqual({ admitted: true });
    expect(admitNetworkTarget(policy, "HTTP://127.0.0.1:4000/v1", effect)).toEqual({
      admitted: true,
    });
    expect(admitNetworkTarget(policy, "http://2130706433:4000/v1", effect)).toEqual({
      admitted: true,
    });

    expect(calls).toEqual([
      gatewayTarget,
      mcpTarget,
      "http://127.0.0.1:4000/v1",
      "http://127.0.0.1:4000/v1",
    ]);
  });

  it("должен отклонить цель сети вне шлюза и перечисленного MCP без вызова", () => {
    const policy = networkPolicy();
    const effect = forbiddenEffect();
    const blocked = [
      "http://192.0.2.10/secret",
      "http://203.0.113.5/?next=http://127.0.0.1:4000",
      "http://127.0.0.1:40000/v1",
      "http://127.0.0.1:4000.example/v1",
      "http://127.0.0.1.example:4000/v1",
      "http://2130706434:4000/v1",
      "https://127.0.0.1:4000/v1",
      "http://127.0.0.1:8766/mcp",
      "http://user:pass@127.0.0.1:4000/v1",
      "http://127.0.0.1:4000@192.0.2.10/",
      "file:///tmp/not-opened",
      "../etc/passwd",
      "/tmp/not-opened",
      "",
      `http://192.0.2.20/${"a".repeat(MAX_URL_FOR_TEST)}`,
    ];

    for (const target of blocked) {
      expect(admitNetworkTarget(policy, target, effect)).toEqual({
        admitted: false,
        reason: "network_denied",
      });
    }
  });

  it("должен не читать домашний каталог и не открывать сеть из модуля политики", async () => {
    const source = await readSandboxSource();
    const markers = [
      "node:os",
      "node:net",
      "node:http",
      "node:https",
      "node:dns",
      "child_process",
      "homedir",
      "process.env",
      "fetch(",
      "TodoRead",
      "web_search",
      "Bash",
      "claude-agent-sdk",
      "@anthropic-ai",
    ];
    const found = markers.filter((marker) => source.includes(marker));
    expect(found).toEqual([]);
    expect(source.includes("DENIED_TOOL_NAMES")).toBe(true);
    expect(source.includes("tool-policy.js")).toBe(true);
  });
});

const MAX_URL_FOR_TEST = 3000;

function policyWithTools(requestedTools: readonly string[]): SandboxPolicy {
  return buildSandboxPolicy({
    modelGateway: GATEWAY,
    mcpOrigins: [MCP],
    requestedTools,
  });
}

function networkPolicy(): SandboxPolicy {
  return buildSandboxPolicy({
    modelGateway: GATEWAY,
    mcpOrigins: [MCP],
  });
}

function notAnArray(field: "mcpOrigins" | "requestedTools"): SandboxPolicyInput {
  const input: SandboxPolicyInput = { modelGateway: GATEWAY, mcpOrigins: [] };
  if (field === "mcpOrigins") {
    return { ...input, mcpOrigins: "http://127.0.0.1:8765" } as unknown as SandboxPolicyInput;
  }
  return { ...input, requestedTools: "read_file" } as unknown as SandboxPolicyInput;
}

function policyError(input: SandboxPolicyInput): SandboxPolicyError {
  try {
    buildSandboxPolicy(input);
  } catch (error) {
    if (error instanceof SandboxPolicyError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected SandboxPolicyError");
}

function recordingEffect(calls: string[]): NetworkEffect {
  return {
    call(target: string): void {
      calls.push(target);
    },
  };
}

function forbiddenEffect(): NetworkEffect {
  return {
    call(): void {
      throw new Error("network must not be opened");
    },
  };
}

async function readSandboxSource(): Promise<string> {
  const filePath = fileURLToPath(new URL("../../src/runner/sandbox.ts", import.meta.url));
  // Фиксированный файл пакета, не путь из запуска и не домашний каталог.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- чтение src/runner/sandbox.ts
  return readFile(filePath, "utf8");
}
