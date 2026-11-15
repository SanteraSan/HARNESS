import { describe, expect, it } from "vitest";

import { parseServiceArguments } from "../../src/services/arguments.js";

const schema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: {
    mode: { type: "string", enum: ["fast", "slow"] },
    n: { type: "integer" },
    note: {
      type: "object",
      additionalProperties: false,
      properties: { text: { type: "string", minLength: 1, maxLength: 4 } },
    },
  },
};

describe("service arguments", () => {
  it("должен принять объект по схеме манифеста", () => {
    expect(parseServiceArguments(schema, { mode: "fast", n: 1, note: { text: "аб" } })).toEqual({
      mode: "fast",
      n: 1,
      note: { text: "аб" },
    });
  });

  it("должен отвергнуть лишнее поле, чужой enum и запретный ключ", () => {
    expect(parseServiceArguments(schema, { mode: "fast", extra: true })).toBeNull();
    expect(parseServiceArguments(schema, { mode: "other" })).toBeNull();
    expect(parseServiceArguments(schema, { mode: "fast", note: { text: "слишком" } })).toBeNull();
    expect(parseServiceArguments(schema, { mode: "fast", __proto__: { admin: true } })).toBeNull();
    expect(parseServiceArguments(schema, { n: 1 })).toBeNull();
  });
});
