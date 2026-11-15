import { describe, expect, it } from "vitest";

import { canonicalBody } from "../../contract/canonical.js";
import { sql } from "../helpers/db.js";

describe("report canonical bytes", () => {
  it("должен считать те же байты, что канонический JSON хаба", async () => {
    const samples = [
      { has_model: false, note: "привет", items: [1, null, 'a"b'] },
      { nested: { b: true, a: "x" }, empty: {}, flag: false },
    ];
    for (const sample of samples) {
      const canonical = canonicalBody(sample);
      expect(canonical.ok).toBe(true);
      if (!canonical.ok) {
        throw new Error("canonical sample");
      }
      const rows = await sql<{ bytes: number }[]>`
        select harness_canonical_json_bytes(${sql.json(sample)}) as bytes
      `;
      expect(rows[0]?.bytes).toBe(Buffer.byteLength(canonical.value.text, "utf8"));
    }
  });
});
