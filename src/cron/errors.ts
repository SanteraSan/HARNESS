export class CronError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CronError";
    this.code = code;
  }
}
