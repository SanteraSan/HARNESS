import { z } from "zod";

import { parseJsonBody } from "../../contract/canonical.js";
import { codePointLength, isPlainObject } from "../../contract/data.js";
import {
  DURATION_MS_MAX,
  ERROR_TEXT_MAX_CODE_POINTS,
  RESPONSE_BODY_LIMIT_BYTES,
  RESPONSE_TEXT_MAX_CODE_POINTS,
  TOOL_ERROR_CODES,
  UUID_RE,
} from "../../contract/limits.js";

export const SERVICE_CONTRACT = "harness.tool.v2";

const uuidSchema = z.string().regex(UUID_RE);

const errorCodeSchema = z.string().refine((value): value is (typeof TOOL_ERROR_CODES)[number] => {
  return (TOOL_ERROR_CODES as readonly string[]).includes(value);
});

const successSchema = z
  .object({
    contract: z.literal(SERVICE_CONTRACT),
    ok: z.literal(true),
    text: z.string().refine((value) => codePointLength(value) <= RESPONSE_TEXT_MAX_CODE_POINTS),
    truncated: z.boolean(),
    duration_ms: z.number().int().min(0).max(DURATION_MS_MAX),
    blobs: z.array(uuidSchema).max(8),
    nonce: uuidSchema,
    run_id: uuidSchema,
    tool_call_id: z.string().min(1).max(128),
    report: z.unknown().optional(),
  })
  .strict();

const failureSchema = z
  .object({
    contract: z.literal(SERVICE_CONTRACT),
    ok: z.literal(false),
    error: z.string().refine((value) => isErrorText(value)),
    error_code: z.string(),
    truncated: z.boolean(),
    duration_ms: z.number().int().min(0).max(DURATION_MS_MAX),
    blobs: z.array(uuidSchema).max(0),
    nonce: uuidSchema,
    run_id: uuidSchema,
    tool_call_id: z.string().min(1).max(128),
    report: z.unknown().optional(),
  })
  .strict();

export interface ServiceSuccess {
  ok: true;
  text: string;
  truncated: boolean;
  durationMs: number;
  nonce: string;
  runId: string;
  toolCallId: string;
  report: unknown;
  reportPresent: boolean;
}

export interface ServiceFailure {
  ok: false;
  error: string;
  errorCode: string;
  truncated: boolean;
  durationMs: number;
  nonce: string;
  runId: string;
  toolCallId: string;
  report: unknown;
  reportPresent: boolean;
}

export type ServiceEnvelope = ServiceSuccess | ServiceFailure;

export type EnvelopeProblem = "unknown_field" | "invalid_envelope" | "payload_too_large";

export function parseServiceEnvelope(
  raw: string,
): { ok: true; value: ServiceEnvelope } | { ok: false; reason: EnvelopeProblem } {
  if (Buffer.byteLength(raw, "utf8") > RESPONSE_BODY_LIMIT_BYTES) {
    return { ok: false, reason: "payload_too_large" };
  }
  const parsed = parseJsonBody(raw, RESPONSE_BODY_LIMIT_BYTES);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason === "payload_too_large" ? "payload_too_large" : parsed.reason === "unknown_field" ? "unknown_field" : "invalid_envelope" };
  }
  if (!isPlainObject(parsed.value)) {
    return { ok: false, reason: "invalid_envelope" };
  }
  if (Object.hasOwn(parsed.value, "contract") && parsed.value.contract !== SERVICE_CONTRACT) {
    return { ok: false, reason: "invalid_envelope" };
  }
  const schema = parsed.value.ok === false ? failureSchema : successSchema;
  const checked = schema.safeParse(parsed.value);
  if (!checked.success) {
    return { ok: false, reason: issueReason(checked.error.issues) };
  }
  const reportPresent = Object.hasOwn(parsed.value, "report");
  if (checked.data.ok === false) {
    if (!errorCodeSchema.safeParse(checked.data.error_code).success && typeof checked.data.error_code !== "string") {
      return { ok: false, reason: "invalid_envelope" };
    }
    if (typeof checked.data.error_code !== "string") {
      return { ok: false, reason: "invalid_envelope" };
    }
    const errorCode = (TOOL_ERROR_CODES as readonly string[]).includes(checked.data.error_code)
      ? checked.data.error_code
      : "internal";
    return {
      ok: true,
      value: {
        ok: false,
        error: checked.data.error,
        errorCode,
        truncated: checked.data.truncated,
        durationMs: checked.data.duration_ms,
        nonce: checked.data.nonce,
        runId: checked.data.run_id,
        toolCallId: checked.data.tool_call_id,
        report: reportPresent ? checked.data.report : undefined,
        reportPresent,
      },
    };
  }
  return {
    ok: true,
    value: {
      ok: true,
      text: checked.data.text,
      truncated: checked.data.truncated,
      durationMs: checked.data.duration_ms,
      nonce: checked.data.nonce,
      runId: checked.data.run_id,
      toolCallId: checked.data.tool_call_id,
      report: reportPresent ? checked.data.report : undefined,
      reportPresent,
    },
  };
}

function issueReason(issues: readonly { code: string }[]): EnvelopeProblem {
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      return "unknown_field";
    }
  }
  return "invalid_envelope";
}

function isErrorText(value: string): boolean {
  const length = codePointLength(value);
  if (length < 1 || length > ERROR_TEXT_MAX_CODE_POINTS) {
    return false;
  }
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) {
      return false;
    }
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return false;
    }
  }
  return true;
}
