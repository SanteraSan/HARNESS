import { describe, expect, it } from "vitest";

import { DENIED_TOOL_NAMES, filterToolNames } from "../../src/contracts/tool-policy.js";

describe("filterToolNames", () => {
  it("должен сохранить read_file и list_dir", () => {
    expect(filterToolNames(["read_file", "list_dir"])).toEqual(["read_file", "list_dir"]);
  });

  it("должен убрать запрещённое имя, даже если оно есть в allowlist", () => {
    expect(filterToolNames([...DENIED_TOOL_NAMES, "read_file", "list_dir"])).toEqual([
      "read_file",
      "list_dir",
    ]);
  });

  it("должен убрать запрещённое имя без учёта регистра и не задеть read_file", () => {
    expect(filterToolNames(["BASH", "ReAd", "read_file", "reading", "list_dir"])).toEqual([
      "read_file",
      "reading",
      "list_dir",
    ]);
  });
});
