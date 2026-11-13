import { canonicalBody } from "../../contract/canonical.js";
import { codePointLength, isPlainObject } from "../../contract/data.js";
import { redact } from "../model/redact.js";

const BAD = Symbol("invalid");
const FINISH = new Set(["stop", "length", "tool_calls", "content_filter", "error"]);
const REPORT_BYTES = 8192;

export interface ReportStep {
  stepIndex: number;
  excerpt: string;
  finishReason: string | null;
  claimedPromptTokens: number | null;
  claimedCompletionTokens: number | null;
  claimedCostUsd: string | null;
  toolCalls: { id: string; name: string }[] | null;
}

export interface ValidReport {
  status: "valid";
  document: unknown;
  claimedPromptTokens: number | null;
  claimedCompletionTokens: number | null;
  claimedCostUsd: string | null;
  claimedFinishReason: string | null;
  steps: ReportStep[];
}

export interface EmptyReport {
  status: "absent" | "invalid";
}

export type ReportDecision = ValidReport | EmptyReport;

/** Отчёт разбирается отдельно от текста. Битый блок не затирает годный text. */
export function decideReport(
  present: boolean,
  value: unknown,
  secrets: readonly string[],
): ReportDecision {
  if (!present) {
    return { status: "absent" };
  }
  if (!isPlainObject(value) || Array.isArray(value)) {
    return { status: "invalid" };
  }
  const masked = redactReport(value, secrets);
  if (masked === null) {
    return { status: "invalid" };
  }
  const parsed = readReport(masked);
  if (parsed === null) {
    return { status: "invalid" };
  }
  const canonical = canonicalBody(masked);
  if (!canonical.ok || Buffer.byteLength(canonical.value.text, "utf8") > REPORT_BYTES) {
    return { status: "invalid" };
  }
  return {
    status: "valid",
    document: masked,
    claimedPromptTokens: parsed.claimedPromptTokens,
    claimedCompletionTokens: parsed.claimedCompletionTokens,
    claimedCostUsd: parsed.claimedCostUsd,
    claimedFinishReason: parsed.claimedFinishReason,
    steps: parsed.steps,
  };
}

interface ReadReport {
  claimedPromptTokens: number | null;
  claimedCompletionTokens: number | null;
  claimedCostUsd: string | null;
  claimedFinishReason: string | null;
  steps: ReportStep[];
}

function readReport(value: Record<string, unknown>): ReadReport | null {
  const keys = Object.keys(value);
  const allowed = new Set([
    "has_model",
    "claimed_prompt_tokens",
    "claimed_completion_tokens",
    "claimed_cost_usd",
    "finish_reason",
    "steps",
  ]);
  for (const key of keys) {
    if (!allowed.has(key)) {
      return null;
    }
  }
  if (typeof value.has_model !== "boolean") {
    return null;
  }
  if (containsAddress(value)) {
    return null;
  }
  const claimedPromptTokens = optionalInt(value, "claimed_prompt_tokens");
  const claimedCompletionTokens = optionalInt(value, "claimed_completion_tokens");
  const claimedCostUsd = optionalCost(value, "claimed_cost_usd");
  const claimedFinishReason = optionalFinish(value, "finish_reason");
  if (
    claimedPromptTokens === BAD ||
    claimedCompletionTokens === BAD ||
    claimedCostUsd === BAD ||
    claimedFinishReason === BAD
  ) {
    return null;
  }
  const steps = readSteps(value.steps, value.has_model);
  if (steps === null) {
    return null;
  }
  return {
    claimedPromptTokens,
    claimedCompletionTokens,
    claimedCostUsd,
    claimedFinishReason,
    steps,
  };
}

function readSteps(value: unknown, hasModel: boolean): ReportStep[] | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  if (!hasModel && value.length > 0) {
    return null;
  }
  if (value.length > 16) {
    return null;
  }
  const steps: ReportStep[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const step = readStep(value[index], index);
    if (step === null) {
      return null;
    }
    steps.push(step);
  }
  return steps;
}

function readStep(value: unknown, index: number): ReportStep | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const allowed = new Set([
    "step_index",
    "excerpt",
    "finish_reason",
    "claimed_prompt_tokens",
    "claimed_completion_tokens",
    "claimed_cost_usd",
    "tool_calls",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return null;
    }
  }
  if (value.step_index !== index) {
    return null;
  }
  if (typeof value.excerpt !== "string" || codePointLength(value.excerpt) > 2000 || hasForbidden(value.excerpt)) {
    return null;
  }
  const finishReason = optionalFinish(value, "finish_reason");
  const claimedPromptTokens = optionalInt(value, "claimed_prompt_tokens");
  const claimedCompletionTokens = optionalInt(value, "claimed_completion_tokens");
  const claimedCostUsd = optionalCost(value, "claimed_cost_usd");
  const toolCalls = readToolCalls(value.tool_calls);
  if (
    finishReason === BAD ||
    claimedPromptTokens === BAD ||
    claimedCompletionTokens === BAD ||
    claimedCostUsd === BAD ||
    toolCalls === BAD
  ) {
    return null;
  }
  if (containsAddress(value)) {
    return null;
  }
  return {
    stepIndex: index,
    excerpt: value.excerpt,
    finishReason,
    claimedPromptTokens,
    claimedCompletionTokens,
    claimedCostUsd,
    toolCalls,
  };
}

function readToolCalls(value: unknown): { id: string; name: string }[] | null | typeof BAD {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.length > 8) {
    return BAD;
  }
  const calls: { id: string; name: string }[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || Object.keys(item).length !== 2) {
      return BAD;
    }
    if (typeof item.id !== "string" || typeof item.name !== "string") {
      return BAD;
    }
    if (!isToolId(item.id) || !isToolName(item.name)) {
      return BAD;
    }
    calls.push({ id: item.id, name: item.name });
  }
  return calls;
}

function optionalInt(value: Record<string, unknown>, key: string): number | null | typeof BAD {
  if (!Object.hasOwn(value, key) || readOwn(value, key) === null) {
    return null;
  }
  const inner = readOwn(value, key);
  if (typeof inner !== "number" || !Number.isInteger(inner) || inner < 0 || inner > 2_147_483_647) {
    return BAD;
  }
  return inner;
}

function optionalCost(value: Record<string, unknown>, key: string): string | null | typeof BAD {
  if (!Object.hasOwn(value, key) || readOwn(value, key) === null) {
    return null;
  }
  const inner = readOwn(value, key);
  if (typeof inner !== "string" || !isCost(inner)) {
    return BAD;
  }
  return inner;
}

function optionalFinish(value: Record<string, unknown>, key: string): string | null | typeof BAD {
  if (!Object.hasOwn(value, key) || readOwn(value, key) === null) {
    return null;
  }
  const inner = readOwn(value, key);
  if (typeof inner !== "string" || !FINISH.has(inner)) {
    return BAD;
  }
  return inner;
}

function readOwn(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

function isCost(value: string): boolean {
  const dot = value.indexOf(".");
  const whole = dot === -1 ? value : value.slice(0, dot);
  const fraction = dot === -1 ? "" : value.slice(dot + 1);
  if (!isDigits(whole) || whole.length === 0 || whole.length > 8) {
    return false;
  }
  if (whole.length > 1 && whole.startsWith("0")) {
    return false;
  }
  if (dot === -1) {
    return true;
  }
  return isDigits(fraction) && fraction.length >= 1 && fraction.length <= 6;
}

function isDigits(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (const character of value) {
    if (character < "0" || character > "9") {
      return false;
    }
  }
  return true;
}

function isToolId(value: string): boolean {
  return isToken(value, 128);
}

function isToolName(value: string): boolean {
  return isToken(value, 64);
}

function isToken(value: string, max: number): boolean {
  if (value.length === 0 || value.length > max) {
    return false;
  }
  for (const character of value) {
    const code = character.codePointAt(0);
    const digit = code !== undefined && code >= 48 && code <= 57;
    const upper = code !== undefined && code >= 65 && code <= 90;
    const lower = code !== undefined && code >= 97 && code <= 122;
    if (!digit && !upper && !lower && character !== "_" && character !== "-") {
      return false;
    }
  }
  return true;
}

function containsAddress(value: Record<string, unknown>): boolean {
  for (const key of Object.keys(value)) {
    const inner = value[key];
    if (typeof inner === "string" && hasAddress(inner)) {
      return true;
    }
    if (Array.isArray(inner)) {
      for (const item of inner) {
        if (isPlainObject(item) && containsAddress(item)) {
          return true;
        }
      }
    }
  }
  return false;
}

function hasAddress(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes("http://") || lower.includes("https://");
}

function hasForbidden(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || isHidden(code)) {
      return true;
    }
  }
  return false;
}

function isHidden(code: number): boolean {
  if (code === 0x09 || code === 0x0a) {
    return false;
  }
  if (code <= 0x1f) {
    return true;
  }
  if (code >= 0x200b && code <= 0x200f) {
    return true;
  }
  if (code >= 0x202a && code <= 0x202e) {
    return true;
  }
  if (code >= 0x2066 && code <= 0x2069) {
    return true;
  }
  return code === 0xfeff;
}

function redactReport(value: Record<string, unknown>, secrets: readonly string[]): Record<string, unknown> | null {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const masked = redactValue(descriptor?.value, secrets);
    if (masked === null) {
      return null;
    }
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: masked,
      writable: true,
    });
  }
  return copy;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    if (hasForbidden(value)) {
      return null;
    }
    return redact(value, secrets);
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const masked = redactValue(item, secrets);
      if (masked === null && item !== null) {
        return null;
      }
      items.push(masked);
    }
    return items;
  }
  if (isPlainObject(value)) {
    return redactReport(value, secrets);
  }
  return value;
}
