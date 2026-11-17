import { describe, expect, it } from "vitest";

import { bearerMatches } from "../../src/api/auth.js";

describe("bearerMatches", () => {
  it("должен принять тот же токен и отказать пустому, короткому и другому", () => {
    const token = "test-secret-value";
    expect(bearerMatches(token, `Bearer ${token}`)).toBe(true);
    expect(bearerMatches("", `Bearer ${token}`)).toBe(false);
    expect(bearerMatches(token, undefined)).toBe(false);
    expect(bearerMatches(token, "Bearer ")).toBe(false);
    expect(bearerMatches(token, "Bearer no")).toBe(false);
    expect(bearerMatches(token, "Bearer test-secret-valuX")).toBe(false);
    expect(bearerMatches(token, token)).toBe(false);
  });
});
