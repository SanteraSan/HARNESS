export class SecretError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SecretError";
    this.code = code;
  }
}

export function postgresCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && code.length > 0 && code.length <= 8) {
      return code;
    }
  }
  return null;
}
