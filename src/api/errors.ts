/** Код ответа, который можно отдать клиенту. Стек и текст исключения сюда не входят. */
export type ClientStatus = 400 | 401 | 404 | 413 | 500;

export type ClientCode =
  | "unauthorized"
  | "invalid_body"
  | "invalid_id"
  | "invalid_request"
  | "payload_too_large"
  | "unknown_agent"
  | "not_found"
  | "internal_error";

export class ApiError extends Error {
  readonly code: ClientCode;

  constructor(code: ClientCode) {
    super(code);
    this.name = "ApiError";
    this.code = code;
  }
}

export class ApiConfigError extends Error {
  readonly code = "config_invalid";

  constructor(message: string) {
    super(message);
    this.name = "ApiConfigError";
  }
}

/** В ответ попадает только код из списка. Чужой текст исключения клиент не видит. */
export function clientFailure(error: unknown): { status: ClientStatus; reason: ClientCode } {
  if (error instanceof ApiError) {
    return { status: statusFor(error.code), reason: error.code };
  }
  return { status: 500, reason: "internal_error" };
}

function statusFor(code: ClientCode): ClientStatus {
  switch (code) {
    case "unauthorized":
      return 401;
    case "invalid_body":
    case "invalid_id":
    case "invalid_request":
      return 400;
    case "payload_too_large":
      return 413;
    case "unknown_agent":
    case "not_found":
      return 404;
    case "internal_error":
      return 500;
  }
}
