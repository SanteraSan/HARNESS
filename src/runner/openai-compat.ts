import {
  interpretModelOutput,
  type ClaimedRun,
  type FinishOutcome,
  type ModelMessage,
  type ModelOutput,
  type NewRunStep,
  type Provider,
  type Runner,
  type RunnerContext,
  type Tool,
  type ToolCall,
  type ToolContext,
  type ToolEffect,
} from "../contracts/index.js";
import { logger } from "../config.js";
import type { Sql } from "../db/client.js";
import { redact } from "../model/redact.js";
import { resolveModel } from "../routing/resolve.js";
import { decideToolCall, modelToolsForAllowlist } from "../tools/index.js";

/**
 * Синхронный JSON.parse длиннее этого не запускаем:
 * ход модели не должен разбирать огромную строку аргументов.
 */
const ARGUMENT_PARSE_LIMIT = 32 * 1024;

const EXCEPTION_TEXT_LIMIT = 500;

/** Алиас выбора чата. Воркер читает строку и передаёт её сюда. Таблицу раннер не читает. */
export type ChatModelAlias = "agent" | "coder-cloud";

/** Поля агента, без которых не собрать промпт, потолок шагов и список инструментов. */
export interface RunnerAgent {
  id: string;
  systemPrompt: string;
  modelAlias: string;
  provider: Provider;
  maxSteps: number;
  toolAllowlist: readonly string[];
  /** Предел одного ответа. Берётся со строки агента. */
  maxCompletionTokens: number;
}

/**
 * Агент читается на каждый запуск: в ClaimedRun есть agentId.
 * Промпт, maxSteps и allowlist лежат на строке агента, их передаёт вызывающий.
 */
export interface OpenAICompatRunnerOptions {
  loadAgent: (agentId: string) => Promise<RunnerAgent>;
  fileRoot: string;
  secrets: readonly string[];
  /** Пул процесса. Без него алиас остаётся полем агента: второго пула раннер не открывает. */
  sql?: Sql;
}

interface TokenTotals {
  promptTokens: number | null;
  completionTokens: number | null;
}

interface ResolvedAlias {
  modelAlias: string;
  provider: Provider;
}

export class RunnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
  }
}

/**
 * Цикл одного захваченного запуска.
 * Итог пишет только finish, и только пока лок ещё наш.
 */
export class OpenAICompatRunner implements Runner {
  private readonly loadAgent: (agentId: string) => Promise<RunnerAgent>;
  private readonly fileRoot: string;
  private readonly secrets: readonly string[];
  private readonly sql: Sql | undefined;
  /** Алиас текущего захвата. null — выбора нет, остаётся resolveModel. */
  private chatModelAlias: ChatModelAlias | null = null;

  constructor(options: OpenAICompatRunnerOptions) {
    if (options.fileRoot.trim().length === 0) {
      throw new RunnerError("invalid_file_root", "file root is empty");
    }
    this.loadAgent = options.loadAgent;
    this.fileRoot = options.fileRoot;
    this.secrets = [...options.secrets];
    this.sql = options.sql;
  }

  /**
   * Воркер передаёт алиас, прочитанный из chat_model_choices.
   * null — выбора нет или источник не Telegram.
   */
  assignChatModelAlias(alias: ChatModelAlias | null): void {
    this.chatModelAlias = alias;
  }

  async run(claimed: ClaimedRun, ctx: RunnerContext): Promise<void> {
    const chatAlias = this.chatModelAlias;
    this.chatModelAlias = null;
    const agent = await this.requireAgent(claimed.agentId);
    const allowlist = [...agent.toolAllowlist];
    const tools = modelToolsForAllowlist(allowlist, ctx.tools);
    const messages = initialMessages(agent.systemPrompt, claimed.payload.message);
    const totals: TokenTotals = { promptTokens: null, completionTokens: null };
    const toolContext: ToolContext = {
      runId: claimed.id,
      agentId: claimed.agentId,
      fileRoot: this.fileRoot,
    };
    const seenEffects: ToolEffect[] = [];
    let resolved: ResolvedAlias = {
      modelAlias: agent.modelAlias,
      provider: agent.provider,
    };

    for (let attempt = 1; attempt <= agent.maxSteps; attempt += 1) {
      const alive = await ctx.heartbeat(claimed.id, ctx.workerId, ctx.leaseSeconds);
      // I7: ноль строк heartbeat — лок потерян. Шаг этого хода не пишем и finish не зовём.
      if (!alive) {
        logger.warn({ run_id: claimed.id }, "lock lost");
        return;
      }

      resolved = await this.resolveAlias(agent, claimed.tenantId, seenEffects, chatAlias);
      let cost = costFor(resolved.provider, null);
      const requestStep = await this.writeStep(
        ctx,
        {
          ...baseStep(claimed.id, "model_request"),
          requestExcerpt: this.mask(`${resolved.modelAlias}\n${claimed.payload.message}`),
        },
        cost,
      );

      logger.info({ run_id: claimed.id, model: resolved.modelAlias, attempt }, "model request");
      const output = await ctx.model.complete({
        model: resolved.modelAlias,
        temperature: 0,
        messages,
        tools,
        maxTokens: agent.maxCompletionTokens,
      });
      totals.promptTokens = addTokens(totals.promptTokens, output.promptTokens);
      totals.completionTokens = addTokens(totals.completionTokens, output.completionTokens);
      cost = costFor(resolved.provider, output);
      if (requestStep.costUsd !== cost) {
        requestStep.costUsd = cost;
        await this.reviseModelRequestCost(ctx, claimed.id, cost);
      }

      const interpreted = interpretModelOutput(output);
      if (interpreted.type === "final") {
        await this.finishFinal(ctx, claimed.id, resolved, totals, interpreted.text, cost);
        return;
      }
      if (interpreted.type === "parse_error") {
        // I2: JSON в тексте и пустой ответ не исполняются. Ремонтную реплику модели не шлём.
        await this.finishParseError(
          ctx,
          claimed.id,
          resolved,
          totals,
          interpreted.reason,
          output.content,
          cost,
        );
        return;
      }

      await this.applyToolCalls(
        ctx,
        claimed.id,
        allowlist,
        toolContext,
        messages,
        output.content,
        interpreted.calls,
        cost,
        seenEffects,
      );
    }

    await commitOutcome(
      ctx,
      claimed.id,
      outcomeFor(resolved, totals, "failed", null, "step_budget_exhausted"),
    );
  }

  private async requireAgent(agentId: string): Promise<RunnerAgent> {
    const agent = await this.loadAgent(agentId);
    if (agent.id !== agentId) {
      throw new RunnerError("agent_mismatch", "agent does not match the run");
    }
    if (!Number.isSafeInteger(agent.maxSteps) || agent.maxSteps < 1) {
      throw new RunnerError("invalid_max_steps", "max steps is invalid");
    }
    return agent;
  }

  /** I4: секрет не попадает ни в шаг, ни в следующее сообщение модели. */
  private mask(text: string): string {
    return redact(text, this.secrets);
  }

  private async resolveAlias(
    agent: RunnerAgent,
    tenantId: string,
    toolEffects: readonly ToolEffect[],
    chatAlias: ChatModelAlias | null,
  ): Promise<ResolvedAlias> {
    const resolved = await this.resolveAgentAlias(agent, tenantId, toolEffects);
    // Выбор чата подменяет только алиас агента и не ставит provider external.
    // Правило маршрута, уже ушедшее с алиаса агента, остаётся: SDK из-за чата не открывается.
    if (
      chatAlias !== null &&
      resolved.modelAlias === agent.modelAlias &&
      resolved.provider === agent.provider
    ) {
      return { modelAlias: chatAlias, provider: agent.provider };
    }
    return resolved;
  }

  private async resolveAgentAlias(
    agent: RunnerAgent,
    tenantId: string,
    toolEffects: readonly ToolEffect[],
  ): Promise<ResolvedAlias> {
    if (this.sql === undefined) {
      return { modelAlias: agent.modelAlias, provider: agent.provider };
    }
    return resolveModel(
      this.sql,
      {
        id: agent.id,
        tenantId,
        modelAlias: agent.modelAlias,
        provider: agent.provider,
      },
      { toolEffects },
    );
  }

  private async finishFinal(
    ctx: RunnerContext,
    runId: string,
    resolved: ResolvedAlias,
    totals: TokenTotals,
    text: string,
    cost: number | null,
  ): Promise<void> {
    const visible = this.mask(text);
    await this.writeStep(
      ctx,
      {
        ...baseStep(runId, "final"),
        responseExcerpt: visible,
      },
      cost,
    );
    await commitOutcome(ctx, runId, outcomeFor(resolved, totals, "succeeded", visible, null));
  }

  private async finishParseError(
    ctx: RunnerContext,
    runId: string,
    resolved: ResolvedAlias,
    totals: TokenTotals,
    reason: "empty" | "json_in_text",
    content: string | null,
    cost: number | null,
  ): Promise<void> {
    const excerpt = content === null || content.trim() === "" ? null : this.mask(content);
    await this.writeStep(
      ctx,
      {
        ...baseStep(runId, "parse_error"),
        responseExcerpt: excerpt,
        error: reason,
      },
      cost,
    );
    await commitOutcome(ctx, runId, outcomeFor(resolved, totals, "failed", null, reason));
  }

  private async applyToolCalls(
    ctx: RunnerContext,
    runId: string,
    allowlist: readonly string[],
    toolContext: ToolContext,
    messages: ModelMessage[],
    content: string | null,
    calls: readonly ToolCall[],
    cost: number | null,
    seenEffects: ToolEffect[],
  ): Promise<void> {
    noteCalledEffects(calls, ctx.tools, seenEffects);
    messages.push({
      role: "assistant",
      content: content === null ? null : this.mask(content),
      toolCallId: null,
      toolCalls: calls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: this.mask(call.arguments),
      })),
    });

    for (const call of calls) {
      await this.writeStep(
        ctx,
        {
          ...baseStep(runId, "tool_call"),
          toolName: call.name,
          requestExcerpt: this.mask(call.arguments),
        },
        cost,
      );

      // I3: запрет сильнее allowlist. Имя вне списка тоже не доходит до execute.
      const decision = decideToolCall(call.name, allowlist, ctx.tools);
      if (!decision.ok) {
        const denial = this.mask(decision.error);
        await this.writeStep(
          ctx,
          {
            ...baseStep(runId, "policy_deny"),
            toolName: call.name,
            requestExcerpt: this.mask(call.arguments),
            responseExcerpt: denial,
            error: denial,
          },
          cost,
        );
        messages.push(toolMessage(call.id, denial));
        continue;
      }

      const visible = await this.executeAllowed(ctx, runId, decision.tool, call, toolContext, cost);
      messages.push(toolMessage(call.id, visible));
    }
  }

  private async executeAllowed(
    ctx: RunnerContext,
    runId: string,
    tool: Tool,
    call: ToolCall,
    toolContext: ToolContext,
    cost: number | null,
  ): Promise<string> {
    const parsed = parseArguments(call.arguments);
    if (!parsed.ok) {
      const visible = this.mask("invalid arguments");
      await this.appendToolResult(ctx, runId, call, visible, visible, cost);
      return visible;
    }

    try {
      const outcome = await tool.execute(parsed.value, toolContext);
      if (outcome.ok) {
        const visible = this.mask(outcome.text);
        await this.appendToolResult(ctx, runId, call, visible, null, cost);
        return visible;
      }
      const visible = this.mask(outcome.error);
      await this.appendToolResult(ctx, runId, call, visible, visible, cost);
      return visible;
    } catch (error) {
      logger.warn({ run_id: runId, err: error, tool: tool.name }, "tool failed");
      const visible = this.mask(exceptionText(error));
      await this.appendToolResult(ctx, runId, call, visible, visible, cost);
      return visible;
    }
  }

  private async appendToolResult(
    ctx: RunnerContext,
    runId: string,
    call: ToolCall,
    visible: string,
    error: string | null,
    cost: number | null,
  ): Promise<void> {
    await this.writeStep(
      ctx,
      {
        ...baseStep(runId, "tool_result"),
        toolName: call.name,
        requestExcerpt: this.mask(call.arguments),
        responseExcerpt: visible,
        error,
      },
      cost,
    );
  }

  private async writeStep(
    ctx: RunnerContext,
    step: NewRunStep,
    cost: number | null,
  ): Promise<NewRunStep> {
    const stored: NewRunStep = { ...step, costUsd: cost };
    await ctx.appendStep(stored);
    await this.persistStepCost(ctx, stored.runId, cost);
    return stored;
  }

  /**
   * Журнал вставляет шаг без cost_usd. Число дописывается отдельным update,
   * и только пока лок ещё наш: ноль строк значит, что строку запуска уже отпустили.
   */
  private async persistStepCost(
    ctx: RunnerContext,
    runId: string,
    cost: number | null,
  ): Promise<void> {
    const sql = this.sql;
    if (sql === undefined) {
      return;
    }
    const amount = numericCost(cost);
    await sql`
      update run_steps
      set cost_usd = ${amount}::numeric
      where id = (
        select step.id
        from run_steps as step
        join runs as owned on owned.id = step.run_id
        where step.run_id = ${runId}
          and owned.status = 'running'
          and owned.locked_by = ${ctx.workerId}
        order by step.step_index desc
        limit 1
      )
    `;
  }

  private async reviseModelRequestCost(
    ctx: RunnerContext,
    runId: string,
    cost: number | null,
  ): Promise<void> {
    const sql = this.sql;
    if (sql === undefined) {
      return;
    }
    const amount = numericCost(cost);
    await sql`
      update run_steps
      set cost_usd = ${amount}::numeric
      where id = (
        select step.id
        from run_steps as step
        join runs as owned on owned.id = step.run_id
        where step.run_id = ${runId}
          and step.kind = 'model_request'
          and owned.status = 'running'
          and owned.locked_by = ${ctx.workerId}
        order by step.step_index desc
        limit 1
      )
    `;
  }
}

function noteCalledEffects(
  calls: readonly ToolCall[],
  tools: readonly Tool[],
  seenEffects: ToolEffect[],
): void {
  for (const call of calls) {
    const tool = findNamedTool(call.name, tools);
    if (tool !== undefined) {
      seenEffects.push(tool.effect);
    }
  }
}

function findNamedTool(name: string, tools: readonly Tool[]): Tool | undefined {
  for (const tool of tools) {
    if (tool.name === name) {
      return tool;
    }
  }
  return undefined;
}

/** Локальный ход всегда 0. У внешнего хода число берётся из ответа, иначе null. */
function costFor(provider: Provider, output: ModelOutput | null): number | null {
  if (provider === "local") {
    return 0;
  }
  const cost = output?.costUsd;
  if (typeof cost === "number" && Number.isFinite(cost)) {
    return cost;
  }
  return null;
}

function numericCost(cost: number | null): string | null {
  if (cost === null) {
    return null;
  }
  return String(cost);
}

function initialMessages(systemPrompt: string, message: string): ModelMessage[] {
  return [
    { role: "system", content: systemPrompt, toolCallId: null, toolCalls: null },
    { role: "user", content: message, toolCallId: null, toolCalls: null },
  ];
}

function baseStep(runId: string, kind: NewRunStep["kind"]): NewRunStep {
  return {
    runId,
    kind,
    toolName: null,
    requestExcerpt: null,
    responseExcerpt: null,
    promptTokens: null,
    completionTokens: null,
    error: null,
  };
}

function outcomeFor(
  resolved: ResolvedAlias,
  totals: TokenTotals,
  status: "succeeded" | "failed",
  finalText: string | null,
  error: string | null,
): FinishOutcome {
  return {
    status,
    finalText,
    error,
    modelAlias: resolved.modelAlias,
    provider: resolved.provider,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
  };
}

async function commitOutcome(
  ctx: RunnerContext,
  runId: string,
  outcome: FinishOutcome,
): Promise<void> {
  const wrote = await ctx.finish(runId, ctx.workerId, outcome);
  if (!wrote) {
    logger.warn({ run_id: runId }, "finish lost lock");
    return;
  }
  logger.info({ run_id: runId, status: outcome.status, error: outcome.error }, "run finished");
}

function toolMessage(toolCallId: string, content: string): ModelMessage {
  return {
    role: "tool",
    content,
    toolCallId,
    toolCalls: null,
  };
}

function parseArguments(raw: string): { ok: true; value: unknown } | { ok: false } {
  if (raw.length > ARGUMENT_PARSE_LIMIT) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

function exceptionText(error: unknown): string {
  if (!(error instanceof Error)) {
    return "tool failed";
  }
  const message = error.message.trim();
  if (message.length === 0) {
    return "tool failed";
  }
  if (message.length > EXCEPTION_TEXT_LIMIT) {
    return message.slice(0, EXCEPTION_TEXT_LIMIT);
  }
  return message;
}

function addTokens(total: number | null, value: number | null): number | null {
  if (value === null || !Number.isSafeInteger(value) || value < 0) {
    return total;
  }
  if (total === null) {
    return value;
  }
  const next = total + value;
  if (!Number.isSafeInteger(next)) {
    return total;
  }
  return next;
}
