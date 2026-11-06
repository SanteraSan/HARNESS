import { describe, expect, it } from "vitest";

import { runPayloadSchema } from "../../src/contracts/payload.js";

describe("runPayloadSchema", () => {
  it("должен оставить message и отбросить неизвестное поле", () => {
    expect(runPayloadSchema.parse({ message: "привет", extra: true })).toEqual({
      message: "привет",
    });
  });

  it("должен отказать, если message длиннее 8000 символов", () => {
    expect(() => runPayloadSchema.parse({ message: "а".repeat(8001) })).toThrow();
  });
});
