export const CONTRACT_VERSION = "harness.tool.v1";

export const SERVICES_VERSION = "harness.services.v1";

export const CONTRACT_REASONS = [
  "invalid_body",
  "unknown_field",
  "unsupported_version",
  "unauthorized",
  "unknown_tool",
  "idempotency_conflict",
  "idempotency_in_progress",
  "payload_too_large",
] as const;

export type ContractReason = (typeof CONTRACT_REASONS)[number];

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: ContractReason };

/** Нарушение внутреннего инварианта. Вход клиента сюда не превращается: он даёт reason. */
export class ContractError extends Error {
  readonly code = "contract_invariant";

  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}
