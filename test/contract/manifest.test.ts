import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseServicesManifest, selectToolsForModel } from "../../contract/index.js";

const PATH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 4096 },
  },
};

const PIN = "a".repeat(64);

function tool(
  name: string,
  effect: "read" | "write" | undefined,
  parameters: unknown,
): Record<string, unknown> {
  const value: Record<string, unknown> = {
    name,
    description: "Читает файл.",
    accepts_blobs: false,
    parameters,
  };
  if (effect !== undefined) {
    value.effect = effect;
  }
  return value;
}

function manifest(tools: unknown[], baseUrl = "http://127.0.0.1/", pin?: string): unknown {
  const service: Record<string, unknown> = {
    id: "files",
    base_url: baseUrl,
    tools,
  };
  if (pin !== undefined) {
    service.tls_fingerprint256 = pin;
  }
  return {
    contract: "harness.services.v1",
    services: [service],
  };
}

describe("parseServicesManifest", () => {
  it("должен принять пример files на лупбэке", async () => {
    const raw = await readFile(
      fileURLToPath(new URL("../../contract/examples/services.json", import.meta.url)),
      "utf8",
    );
    const parsed = parseServicesManifest(JSON.parse(raw) as unknown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.services.map((service) => service.id)).toEqual(["files"]);
    expect(parsed.value.services[0]?.tools.map((item) => item.name)).toEqual([
      "read_file",
      "list_dir",
      "record_note",
    ]);
  });

  it("должен отвергнуть лишнее поле и чужую версию манифеста", () => {
    const extra = manifest([tool("read_file", "read", PATH_PARAMETERS)]);
    if (typeof extra !== "object" || extra === null) {
      throw new Error("manifest fixture is invalid");
    }
    Object.defineProperty(extra, "model_slots", { value: 4, enumerable: true });
    expect(parseServicesManifest(extra)).toEqual({ ok: false, reason: "unknown_field" });

    const wrong = manifest([tool("read_file", "read", PATH_PARAMETERS)]);
    if (typeof wrong !== "object" || wrong === null) {
      throw new Error("manifest fixture is invalid");
    }
    Object.defineProperty(wrong, "contract", { value: "harness.services.v2", enumerable: true });
    expect(parseServicesManifest(wrong)).toEqual({ ok: false, reason: "unsupported_version" });
  });

  it("должен отвергнуть pattern, $ref и $data в параметрах", () => {
    for (const keyword of ["pattern", "$ref", "$data"] as const) {
      const parameters = {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1, maxLength: 8, [keyword]: "a" },
        },
      };
      expect(parseServicesManifest(manifest([tool("read_file", "read", parameters)]))).toEqual({
        ok: false,
        reason: "invalid_manifest",
      });
    }
  });

  it("должен отвергнуть инструмент без effect и два сервиса на одно имя", () => {
    expect(
      parseServicesManifest(manifest([tool("read_file", undefined, PATH_PARAMETERS)])),
    ).toEqual({ ok: false, reason: "invalid_manifest" });
    const doubled = {
      contract: "harness.services.v1",
      services: [
        {
          id: "files",
          base_url: "http://127.0.0.1/",
          tools: [tool("read_file", "read", PATH_PARAMETERS)],
        },
        {
          id: "other",
          base_url: "http://127.0.0.1:9/",
          tools: [tool("read_file", "read", PATH_PARAMETERS)],
        },
      ],
    };
    expect(parseServicesManifest(doubled)).toEqual({ ok: false, reason: "invalid_manifest" });
  });

  it("должен отвергнуть описание длиннее 500 символов", () => {
    const longTool = tool("read_file", "read", PATH_PARAMETERS);
    longTool.description = "a".repeat(501);
    expect(parseServicesManifest(manifest([longTool]))).toEqual({
      ok: false,
      reason: "invalid_manifest",
    });
  });

  it("должен принять частный https с пином и отвергнуть чужой адрес", () => {
    expect(
      parseServicesManifest(
        manifest([tool("read_file", "read", PATH_PARAMETERS)], "https://10.1.2.3/", PIN),
      ).ok,
    ).toBe(true);
    expect(
      parseServicesManifest(
        manifest([tool("read_file", "read", PATH_PARAMETERS)], "https://172.16.5.1/", PIN),
      ).ok,
    ).toBe(true);
    expect(
      parseServicesManifest(
        manifest([tool("read_file", "read", PATH_PARAMETERS)], "https://192.168.1.1/", PIN),
      ).ok,
    ).toBe(true);
    expect(
      parseServicesManifest(
        manifest([tool("read_file", "read", PATH_PARAMETERS)], "https://10.1.2.3/"),
      ),
    ).toEqual({ ok: false, reason: "invalid_manifest" });
    for (const baseUrl of [
      "http://10.1.2.3/",
      "http://0.0.0.0/",
      "http://127.0.0.2/",
      "http://localhost/",
      "http://[::1]/",
      "https://8.8.8.8/",
      "https://172.15.0.1/",
      "http://127.0.0.1/notes",
    ]) {
      expect(
        parseServicesManifest(manifest([tool("read_file", "read", PATH_PARAMETERS)], baseUrl, PIN)),
      ).toEqual({ ok: false, reason: "invalid_manifest" });
    }
  });
});

describe("selectToolsForModel", () => {
  it("должен оставить read_file из пересечения манифеста и allowlist", () => {
    const tools = [
      {
        name: "read_file",
        description: "file",
        effect: "read" as const,
        parameters: PATH_PARAMETERS,
      },
      {
        name: "list_dir",
        description: "dir",
        effect: "read" as const,
        parameters: PATH_PARAMETERS,
      },
    ];
    expect(
      selectToolsForModel(tools, ["read_file", "list_dir"], []).map((item) => item.name),
    ).toEqual(["read_file", "list_dir"]);
    expect(selectToolsForModel(tools, ["read_file"], []).map((item) => item.name)).toEqual([
      "read_file",
    ]);
  });

  it("должен выбросить запрещённое имя, даже если оно есть в манифесте и allowlist", () => {
    const tools = [
      {
        name: "Bash",
        description: "shell",
        effect: "write" as const,
        parameters: PATH_PARAMETERS,
      },
      {
        name: "read_file",
        description: "file",
        effect: "read" as const,
        parameters: PATH_PARAMETERS,
      },
    ];
    const selected = selectToolsForModel(tools, ["Bash", "read_file", "bash"], ["Bash"]);
    expect(selected.map((item) => item.name)).toEqual(["read_file"]);
    expect(selected[0]?.parameters).toBe(tools[1]?.parameters);
  });
});
