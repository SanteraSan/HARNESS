import { randomUUID } from "node:crypto";

import { canonicalBody } from "../../contract/canonical.js";
import { codePointLength } from "../../contract/data.js";
import { omitIdempotencyArgument, parseToolArguments } from "../../contract/tools.js";
import { TOOL_CALL_ID_RE } from "../../contract/limits.js";
import type { ServiceEntry, ServiceTool } from "../../contract/manifest.js";
import { JSON_BODY_LIMIT_BYTES } from "../../contract/limits.js";
import { redact } from "../model/redact.js";
import type { Sql } from "../db/client.js";
import { prepareToolResultForModel, MODEL_TOOL_TEXT_CHARS } from "../runner/tool-result-text.js";
import { parseServiceEnvelope, SERVICE_CONTRACT } from "./envelope.js";
import { decideReport } from "./report.js";
import {
  findInvocation,
  finishInvocation,
  insertPending,
  loadStoredText,
  type ResultInput,
  type TransportCode,
} from "./store.js";

const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 60_000;
const RESPONSE_LIMIT = 393_627;

export interface ServiceCallInput {
  sql: Sql;
  workerId: string;
  runId: string;
  tenantId: string;
  agentId: string;
  toolCallId: string;
  service: ServiceEntry;
  tool: ServiceTool;
  args: unknown;
  secret: string | null;
  secrets: readonly string[];
  timeoutMs?: number;
  retryDelayMs?: number;
}

export interface ServiceCallOutcome {
  lockLost: boolean;
  text: string;
  error: string | null;
  requestExcerpt: string;
}

export async function executeServiceCall(input: ServiceCallInput): Promise<ServiceCallOutcome> {
  const fallback = `${input.tool.name} invalid`;
  if (!TOOL_CALL_ID_RE.test(input.toolCallId)) {
    return invalid(fallback);
  }
  const omitted = omitIdempotencyArgument(input.args);
  if (!omitted.ok) {
    return invalid(fallback);
  }
  const parsed = parseToolArguments(input.tool.name, omitted.value);
  if (!parsed.ok) {
    return invalid(fallback);
  }
  const existing = await findInvocation(input.sql, input.runId, input.toolCallId);
  if (existing?.status === "completed") {
    const stored = await loadStoredText(input.sql, existing.id);
    if (stored === null) {
      return invalid(fallback);
    }
    return {
      lockLost: false,
      text: stored.excerpt,
      error: stored.ok ? null : stored.excerpt,
      requestExcerpt: `${input.tool.name} stored`,
    };
  }
  const nonce = randomUUID();
  const body = {
    contract: SERVICE_CONTRACT,
    run_id: input.runId,
    tool_call_id: input.toolCallId,
    agent_id: input.agentId,
    service: input.service.id,
    name: input.tool.name,
    arguments: parsed.value,
    nonce,
  };
  const canonical = canonicalBody(body);
  if (!canonical.ok) {
    return invalid(fallback);
  }
  const bytes = Buffer.from(canonical.value.text, "utf8");
  if (bytes.byteLength > JSON_BODY_LIMIT_BYTES) {
    return invalid(fallback);
  }
  const hash = Buffer.from(canonical.value.sha256);
  const invocationId = randomUUID();
  await insertPending(input.sql, {
    id: invocationId,
    tenantId: input.tenantId,
    serviceId: input.service.id,
    runId: input.runId,
    toolCallId: input.toolCallId,
    requestSha256: hash,
    nonce,
    workerId: input.workerId,
  });
  const excerpt = `${input.tool.name} ${hash.toString("hex")}`;
  const timeoutMs = input.timeoutMs ?? (input.tool.effect === "write" ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS);
  const attempt = await send(input, bytes, timeoutMs);
  if (input.tool.effect === "write" && (attempt.kind === "retry" || attempt.kind === "timeout")) {
    if (attempt.kind === "retry") {
      await delay(input.retryDelayMs ?? 1000);
    }
    const second = await send(input, bytes, timeoutMs);
    return settle(input, invocationId, excerpt, second);
  }
  return settle(input, invocationId, excerpt, attempt);
}

async function settle(
  input: ServiceCallInput,
  invocationId: string,
  excerpt: string,
  attempt: Attempt,
): Promise<ServiceCallOutcome> {
  if (attempt.kind === "retry") {
    const updated = await finishInvocation(input.sql, {
      id: invocationId,
      workerId: input.workerId,
      status: "transport_error",
      transportCode: "http_error",
      httpStatus: 409,
      responseBytes: null,
      result: null,
    });
    if (!updated) {
      return { lockLost: true, text: "", error: null, requestExcerpt: excerpt };
    }
    return visible(input, "idempotency_in_progress", "idempotency_in_progress", excerpt);
  }
  if (attempt.kind === "timeout") {
    const updated = await finishInvocation(input.sql, {
      id: invocationId,
      workerId: input.workerId,
      status: "timeout",
      transportCode: "timeout",
      httpStatus: null,
      responseBytes: null,
      result: null,
    });
    if (!updated) {
      return { lockLost: true, text: "", error: null, requestExcerpt: excerpt };
    }
    return visible(input, "timeout", "timeout", excerpt);
  }
  if (attempt.kind === "transport") {
    const updated = await finishInvocation(input.sql, {
      id: invocationId,
      workerId: input.workerId,
      status: "transport_error",
      transportCode: attempt.code,
      httpStatus: attempt.httpStatus,
      responseBytes: attempt.bytes,
      result: null,
    });
    if (!updated) {
      return { lockLost: true, text: "", error: null, requestExcerpt: excerpt };
    }
    return visible(input, attempt.code, attempt.code, excerpt);
  }
  const envelope = attempt.envelope;
  if (
    envelope.nonce !== attempt.nonce ||
    envelope.runId !== input.runId ||
    envelope.toolCallId !== input.toolCallId
  ) {
    const updated = await finishInvocation(input.sql, {
      id: invocationId,
      workerId: input.workerId,
      status: "transport_error",
      transportCode: "echo_mismatch",
      httpStatus: 200,
      responseBytes: attempt.bytes,
      result: null,
    });
    if (!updated) {
      return { lockLost: true, text: "", error: null, requestExcerpt: excerpt };
    }
    return visible(input, "echo_mismatch", "echo_mismatch", excerpt);
  }
  const rawText = envelope.ok ? envelope.text : envelope.error;
  const prepared = prepareToolResultForModel({ source: "tool", text: rawText }, (value) =>
    redact(value, input.secrets),
  );
  const report = decideReport(envelope.reportPresent, envelope.report, input.secrets);
  const result: ResultInput = {
    ok: envelope.ok,
    errorCode: envelope.ok ? null : envelope.errorCode,
    excerpt: clip(prepared.text, 2000),
    truncated: envelope.truncated || codePointLength(rawText) > MODEL_TOOL_TEXT_CHARS,
    reportStatus: report.status,
    report: report.status === "valid" ? report.document : null,
    claimedDurationMs: envelope.durationMs,
    claimedPromptTokens: report.status === "valid" ? report.claimedPromptTokens : null,
    claimedCompletionTokens: report.status === "valid" ? report.claimedCompletionTokens : null,
    claimedCostUsd: report.status === "valid" ? report.claimedCostUsd : null,
    claimedFinishReason: report.status === "valid" ? report.claimedFinishReason : null,
    steps: report.status === "valid" ? report.steps : [],
  };
  const updated = await finishInvocation(input.sql, {
    id: invocationId,
    workerId: input.workerId,
    status: "completed",
    transportCode: null,
    httpStatus: 200,
    responseBytes: attempt.bytes,
    result,
  });
  if (!updated) {
    return { lockLost: true, text: "", error: null, requestExcerpt: excerpt };
  }
  return {
    lockLost: false,
    text: prepared.text,
    error: envelope.ok ? null : prepared.text,
    requestExcerpt: excerpt,
  };
}

type Attempt =
  | { kind: "timeout" }
  | { kind: "retry" }
  | { kind: "transport"; code: TransportCode; httpStatus: number | null; bytes: number | null }
  | {
      kind: "envelope";
      envelope: import("./envelope.js").ServiceEnvelope;
      nonce: string;
      bytes: number;
    };

async function send(input: ServiceCallInput, bytes: Buffer, timeoutMs: number): Promise<Attempt> {
  const nonce = nonceOf(bytes);
  let response: Response;
  try {
    response = await fetch(toolUrl(input.service.base_url, input.tool.name), {
      method: "POST",
      redirect: "error",
      headers: headers(input),
      body: bytes,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isTimeout(error)) {
      return { kind: "timeout" };
    }
    return { kind: "transport", code: "connection_error", httpStatus: null, bytes: null };
  }
  const received = await readLimited(response);
  if ("tooLarge" in received) {
    return { kind: "transport", code: "payload_too_large", httpStatus: response.status, bytes: null };
  }
  const text = received.text;
  if (response.status === 401) {
    return { kind: "transport", code: "unauthorized", httpStatus: 401, bytes: text.length };
  }
  if (response.status === 409) {
    const reason = reasonOf(text);
    if (reason === "idempotency_in_progress") {
      return { kind: "retry" };
    }
    return {
      kind: "transport",
      code: "idempotency_conflict",
      httpStatus: 409,
      bytes: text.length,
    };
  }
  if (response.status !== 200) {
    return { kind: "transport", code: "http_error", httpStatus: response.status, bytes: text.length };
  }
  const envelope = parseServiceEnvelope(text);
  if (!envelope.ok) {
    return { kind: "transport", code: envelope.reason, httpStatus: 200, bytes: text.length };
  }
  return { kind: "envelope", envelope: envelope.value, nonce, bytes: text.length };
}

function headers(input: ServiceCallInput): Record<string, string> {
  const result: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "x-contract-version": SERVICE_CONTRACT,
  };
  if (input.secret !== null && input.secret.length > 0) {
    result.authorization = `Bearer ${input.secret}`;
  }
  if (input.tool.effect === "write") {
    result["idempotency-key"] = `"${input.runId}:${input.toolCallId}"`;
  }
  return result;
}

function toolUrl(base: string, name: string): string {
  const root = base.endsWith("/") ? base : `${base}/`;
  return new URL(`v1/tools/${name}`, root).href;
}

function nonceOf(bytes: Buffer): string {
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (typeof parsed === "object" && parsed !== null && "nonce" in parsed) {
    const nonce = parsed.nonce;
    if (typeof nonce === "string") {
      return nonce;
    }
  }
  return "";
}

async function readLimited(response: Response): Promise<{ text: string } | { tooLarge: true }> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { text: "" };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    const bytes = next.value instanceof Uint8Array ? next.value : new Uint8Array();
    total += bytes.byteLength;
    if (total > RESPONSE_LIMIT) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(bytes);
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks)) };
}

function reasonOf(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "reason" in parsed && typeof parsed.reason === "string") {
      return parsed.reason;
    }
  } catch {
    return "";
  }
  return "";
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function visible(input: ServiceCallInput, text: string, error: string, excerpt: string): ServiceCallOutcome {
  const prepared = prepareToolResultForModel({ source: "tool", text }, (value) => redact(value, input.secrets));
  return { lockLost: false, text: prepared.text, error, requestExcerpt: excerpt };
}

function invalid(excerpt: string): ServiceCallOutcome {
  return { lockLost: false, text: "invalid arguments", error: "invalid arguments", requestExcerpt: excerpt };
}

function clip(text: string, limit: number): string {
  let count = 0;
  let index = 0;
  while (index < text.length && count < limit) {
    const code = text.codePointAt(index);
    index += code !== undefined && code > 0xffff ? 2 : 1;
    count += 1;
  }
  return text.slice(0, index);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
