import { describe, expect, it } from "vitest";

import { assertTestDatabase, cleanTestDatabase, sql, TestDatabaseError } from "../helpers/db.js";

describe("assertTestDatabase", () => {
  it("должен принять имя, которое кончается на _test", () => {
    expect(assertTestDatabase("postgres://devai@127.0.0.1:5442/harness_test")).toBe("harness_test");
    expect(assertTestDatabase("postgres://devai@127.0.0.1:5442/harness_test?sslmode=disable")).toBe(
      "harness_test",
    );
  });

  it("должен упасть до очистки, если имя базы не кончается на _test", async () => {
    const before = await sql<{ count: number }[]>`select count(*)::int as count from agents`;
    expect(() =>
      assertTestDatabase("postgres://devai:test-secret-value@127.0.0.1:5442/harness"),
    ).toThrow(TestDatabaseError);
    expect(() => assertTestDatabase("postgres://devai@127.0.0.1:5442/harness_test_evil")).toThrow(
      TestDatabaseError,
    );

    try {
      assertTestDatabase("postgres://devai:test-secret-value@127.0.0.1:5442/harness");
    } catch (error) {
      expect(error).toBeInstanceOf(TestDatabaseError);
      if (error instanceof Error) {
        expect(error.message).not.toContain("test-secret-value");
      }
    }

    await expect(
      cleanTestDatabase(sql, "postgres://devai@127.0.0.1:5442/other_test", "unused.sql"),
    ).rejects.toThrow(TestDatabaseError);

    const after = await sql<{ count: number }[]>`select count(*)::int as count from agents`;
    expect(after[0]?.count).toBe(before[0]?.count);
    expect(after[0]?.count).toBe(1);
  });
});
