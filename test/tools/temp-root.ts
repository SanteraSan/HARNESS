import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ToolContext } from "../../src/contracts/types.js";

export interface JailFixture {
  root: string;
  ctx: ToolContext;
  track(dir: string): void;
  cleanup(): Promise<void>;
}

/** Корень инструмента в тесте — временный каталог, не FILE_ROOT процесса. */
export async function createJail(): Promise<JailFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "harness-tools-"));
  const extra: string[] = [];
  return {
    root,
    ctx: {
      runId: "00000000-0000-4000-8000-0000000000a1",
      agentId: "00000000-0000-4000-8000-0000000000a2",
      fileRoot: root,
    },
    track(dir: string): void {
      extra.push(dir);
    },
    async cleanup(): Promise<void> {
      await rm(root, { recursive: true, force: true });
      for (const dir of extra) {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
