import { logger } from "../config.js";
import type { ToolContext, ToolOutcome } from "../contracts/types.js";
import { toolErrorText } from "./failure.js";

/** Ошибка инструмента остаётся результатом вызова и не роняет процесс. */
export async function runTool(
  ctx: ToolContext,
  toolName: string,
  action: () => Promise<ToolOutcome>,
): Promise<ToolOutcome> {
  try {
    return await action();
  } catch (error) {
    logger.warn({ run_id: ctx.runId, err: error, tool: toolName }, "tool failed");
    return { ok: false, error: toolErrorText(error) };
  }
}
