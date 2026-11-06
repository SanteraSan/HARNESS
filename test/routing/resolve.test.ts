import { describe, expect, it } from "vitest";

import { resolveModel } from "../../src/routing/resolve.js";

describe("resolveModel", () => {
  it("должен вернуть modelAlias и provider строки агента", () => {
    expect(
      resolveModel({
        modelAlias: "agent",
        provider: "local",
      }),
    ).toEqual({
      modelAlias: "agent",
      provider: "local",
    });
  });

  it("должен вернуть внешний алиас как есть", () => {
    expect(
      resolveModel({
        modelAlias: "openrouter/other",
        provider: "external",
      }),
    ).toEqual({
      modelAlias: "openrouter/other",
      provider: "external",
    });
  });
});
