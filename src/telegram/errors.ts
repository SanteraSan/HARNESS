export class TelegramError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TelegramError";
    this.code = code;
  }
}
