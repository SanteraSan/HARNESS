/** Ожидаемый отказ инструмента. Сообщение короткое и без пути: его увидит модель. */
export class ToolFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
  }
}

/** Текст для ToolOutcome. Системное сообщение FS не отдаём: в нём бывает абсолютный путь. */
export function toolErrorText(error: unknown): string {
  if (error instanceof ToolFailure) {
    return error.message;
  }
  const code = errnoOf(error);
  if (code === "ENOENT") {
    return "not found";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "not allowed";
  }
  if (code === "ENOTDIR") {
    return "not a directory";
  }
  if (code === "EISDIR") {
    return "not a file";
  }
  if (code === "ELOOP" || code === "ENAMETOOLONG" || code === "EINVAL") {
    return "invalid path";
  }
  return "tool failed";
}

function errnoOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && code.length > 0 && code.length <= 32) {
      return code;
    }
  }
  return null;
}
