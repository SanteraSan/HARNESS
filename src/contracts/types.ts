import type { ZodType } from "zod";

import type { RunPayload } from "./payload.js";

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_KINDS = [
  "model_request",
  "tool_call",
  "tool_result",
  "policy_deny",
  "parse_error",
  "final",
  "lock_lost",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const PROVIDERS = ["local", "external"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const TOOL_EFFECTS = ["read", "write"] as const;
export type ToolEffect = (typeof TOOL_EFFECTS)[number];

export const SOURCES = ["api", "telegram", "cron", "delegation"] as const;
export type Source = (typeof SOURCES)[number];

/** Источник постановки. Очередь пишет все четыре значения в колонку source. */
export type EnqueueSource = "api" | "telegram" | "cron" | "delegation";

export interface AgentRecord {
  id: string;
  tenantId: string;
  slug: string;
  displayName: string;
  systemPrompt: string;
  modelAlias: string;
  provider: Provider;
  maxSteps: number;
  toolAllowlist: readonly string[];
  createdAt: Date;
}

/**
 * Строка runs. chatId — bigint, не number: int8 не проходит через Number().
 * Драйвер отдаёт десятичный текст, очередь собирает bigint из этой строки.
 */
export interface RunRecord {
  id: string;
  tenantId: string;
  agentId: string;
  parentRunId: string | null;
  source: Source;
  status: RunStatus;
  priority: number;
  deadlineAt: Date | null;
  notBefore: Date | null;
  chatId: bigint | null;
  payload: RunPayload;
  idempotencyKey: string;
  attempt: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedUntil: Date | null;
  modelAlias: string | null;
  provider: Provider | null;
  promptTokens: number | null;
  completionTokens: number | null;
  error: string | null;
  finalText: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface ClaimedRun extends RunRecord {
  status: "running";
  lockedBy: string;
  lockedUntil: Date;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCallId: string | null;
  toolCalls: readonly ToolCall[] | null;
}

export interface ModelToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelInput {
  model: string;
  messages: readonly ModelMessage[];
  tools: readonly ModelToolSpec[];
  temperature: 0;
}

export interface ModelOutput {
  content: string | null;
  toolCalls: readonly ToolCall[];
  promptTokens: number | null;
  completionTokens: number | null;
  model: string;
  /**
   * Число стоимости из ответа, если оно было.
   * Поле можно не задавать: для раннера это то же самое, что null.
   */
  costUsd?: number | null;
}

export interface ChatModel {
  complete(input: ModelInput): Promise<ModelOutput>;
}

export interface ToolContext {
  runId: string;
  agentId: string;
  fileRoot: string;
}

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
}

export type ToolOutcome =
  | {
      ok: true;
      text: string;
      truncated: boolean;
      entries: readonly DirectoryEntry[] | null;
    }
  | {
      ok: false;
      error: string;
    };

export interface Tool {
  name: string;
  description: string;
  effect: ToolEffect;
  parameters: ZodType;
  execute(args: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

export interface FinishOutcome {
  status: "succeeded" | "failed";
  finalText: string | null;
  error: string | null;
  modelAlias: string | null;
  provider: Provider | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface NewRunStep {
  runId: string;
  kind: StepKind;
  toolName: string | null;
  requestExcerpt: string | null;
  responseExcerpt: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  error: string | null;
  /** cost_usd хода: local пишет 0, внешний ответ без числа — null. */
  costUsd?: number | null;
}

export interface RunnerContext {
  workerId: string;
  leaseSeconds: number;
  model: ChatModel;
  tools: readonly Tool[];
  heartbeat(runId: string, workerId: string, leaseSeconds: number): Promise<boolean>;
  finish(runId: string, workerId: string, outcome: FinishOutcome): Promise<boolean>;
  appendStep(step: NewRunStep): Promise<void>;
}

export interface Runner {
  run(claimed: ClaimedRun, ctx: RunnerContext): Promise<void>;
}

export interface EnqueueInput {
  tenantId: string;
  agentId: string;
  source: EnqueueSource;
  idempotencyKey: string;
  message: string;
  chatId: bigint | null;
  priority?: number;
  /** Родитель дочернего запуска. Нет поля — в parent_run_id пишется null. */
  parentRunId?: string;
}

export interface EnqueueResult {
  run: RunRecord;
  created: boolean;
  reason: "created" | "replay" | "dialog_busy";
}

export interface RunQueue {
  enqueue(input: EnqueueInput): Promise<EnqueueResult>;
  claimNext(workerId: string, leaseSeconds: number): Promise<ClaimedRun | null>;
  heartbeat(runId: string, workerId: string, leaseSeconds: number): Promise<boolean>;
  reapExpired(): Promise<number>;
  finish(runId: string, workerId: string, outcome: FinishOutcome): Promise<boolean>;
}
