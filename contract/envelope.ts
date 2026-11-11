import { z } from "zod";

import { parseJsonBody } from "./canonical.js";
import { codePointLength, hasControlCharacter, isPlainObject, readOwn } from "./data.js";
import {
  BLOBS_MAX,
  DURATION_MS_MAX,
  ERROR_TEXT_MAX_CODE_POINTS,
  JSON_BODY_LIMIT_BYTES,
  RESPONSE_BODY_LIMIT_BYTES,
  RESPONSE_TEXT_MAX_CODE_POINTS,
  TOOL_CALL_ID_RE,
  TOOL_NAME_RE,
  UUID_RE,
} from "./limits.js";
import {
  CONTRACT_REASONS,
  CONTRACT_VERSION,
  type ContractReason,
  type ParseResult,
} from "./result.js";

const uuidSchema = z.string().length(36).regex(UUID_RE);

const requestShape = {
  contract: z.literal(CONTRACT_VERSION),
  run_id: uuidSchema,
  tool_call_id: z.string().min(1).max(128).regex(TOOL_CALL_ID_RE),
  agent_id: uuidSchema,
  name: z.string().min(1).max(64).regex(TOOL_NAME_RE),
  arguments: z.custom<Record<string, unknown>>((value) => isPlainObject(value)),
} satisfies Record<
  "agent_id" | "arguments" | "contract" | "name" | "run_id" | "tool_call_id",
  z.ZodType
>;

/** Лишнее поле не отбрасывается: strict отвергает его. */
export const toolRequestSchema = z.object(requestShape).strict();

export const REQUEST_FIELD_NAMES: readonly string[] = Object.keys(requestShape).sort();

const blobListSchema = z
  .array(uuidSchema)
  .max(BLOBS_MAX)
  .refine((values) => new Set(values).size === values.length);

const successResponseSchema = z
  .object({
    contract: z.literal(CONTRACT_VERSION),
    ok: z.literal(true),
    text: z.string().refine((value) => codePointLength(value) <= RESPONSE_TEXT_MAX_CODE_POINTS),
    truncated: z.boolean(),
    duration_ms: z.number().int().min(0).max(DURATION_MS_MAX),
    blobs: blobListSchema,
  })
  .strict();

const failureResponseSchema = z
  .object({
    contract: z.literal(CONTRACT_VERSION),
    ok: z.literal(false),
    error: z.string().refine((value) => isToolErrorText(value)),
    truncated: z.boolean(),
    duration_ms: z.number().int().min(0).max(DURATION_MS_MAX),
    blobs: z.array(uuidSchema).max(0),
  })
  .strict();

export const toolResponseSchema = z.discriminatedUnion("ok", [
  successResponseSchema,
  failureResponseSchema,
]);

export const RESPONSE_FIELD_NAMES: readonly string[] = [
  "blobs",
  "contract",
  "duration_ms",
  "error",
  "ok",
  "text",
  "truncated",
];

export const toolHttpErrorSchema = z
  .object({
    reason: z.enum(CONTRACT_REASONS),
  })
  .strict();

export const HTTP_ERROR_FIELD_NAMES: readonly string[] = ["reason"];

export type ToolRequest = z.infer<typeof toolRequestSchema>;
export type ToolResponse = z.infer<typeof toolResponseSchema>;
export type ToolHttpError = z.infer<typeof toolHttpErrorSchema>;

export function parseToolRequest(raw: string | Uint8Array): ParseResult<ToolRequest> {
  return parseWith(raw, toolRequestSchema, CONTRACT_VERSION);
}

/** Длинный text не отказ: в модель его готовит clipModelText, здесь только схема и потолок байтов. */
export function parseToolResponse(raw: string | Uint8Array): ParseResult<ToolResponse> {
  return parseWith(raw, toolResponseSchema, CONTRACT_VERSION, RESPONSE_BODY_LIMIT_BYTES);
}

export function parseHttpError(raw: string | Uint8Array): ParseResult<ToolHttpError> {
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    return parsed;
  }
  const result = toolHttpErrorSchema.safeParse(parsed.value);
  if (!result.success) {
    return { ok: false, reason: issueReason(result.error.issues) };
  }
  return { ok: true, value: result.data };
}

function parseWith<T>(
  raw: string | Uint8Array,
  schema: z.ZodType<T>,
  version: string,
  limitBytes = JSON_BODY_LIMIT_BYTES,
): ParseResult<T> {
  const parsed = parseJsonBody(raw, limitBytes);
  if (!parsed.ok) {
    return parsed;
  }
  if (foreignContract(parsed.value, version)) {
    return { ok: false, reason: "unsupported_version" };
  }
  const result = schema.safeParse(parsed.value);
  if (!result.success) {
    return { ok: false, reason: issueReason(result.error.issues) };
  }
  return { ok: true, value: result.data };
}

function foreignContract(value: unknown, version: string): boolean {
  if (!isPlainObject(value) || !Object.hasOwn(value, "contract")) {
    return false;
  }
  return readOwn(value, "contract") !== version;
}

export function issueReason(issues: readonly { code: string }[]): ContractReason {
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      return "unknown_field";
    }
  }
  return "invalid_body";
}

function isToolErrorText(value: string): boolean {
  const length = codePointLength(value);
  return length >= 1 && length <= ERROR_TEXT_MAX_CODE_POINTS && !hasControlCharacter(value);
}
