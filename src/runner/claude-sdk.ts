import type { ClaimedRun, Runner, RunnerContext } from "../contracts/index.js";

/**
 * Порт Claude Agent SDK.
 * Пакет SDK этот модуль не импортирует: объект с тем же `run`, что у Runner,
 * передаёт вызывающий. Очередь, API и Telegram этот файл не открывают.
 */
export interface ClaudeSdkClient {
  run(claimed: ClaimedRun, ctx: RunnerContext): Promise<void>;
}

export interface ClaudeSdkRunnerOptions {
  client: ClaudeSdkClient;
}

/**
 * Вторая реализация Runner. Ход целиком отдаётся подставному клиенту.
 * Пока план не разрешил зависимость SDK, процесс передаёт клиент, который отказывает.
 */
export class ClaudeSdkRunner implements Runner {
  private readonly client: ClaudeSdkClient;

  constructor(options: ClaudeSdkRunnerOptions) {
    this.client = options.client;
  }

  run(claimed: ClaimedRun, ctx: RunnerContext): Promise<void> {
    return this.client.run(claimed, ctx);
  }
}

export class ClaudeSdkError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ClaudeSdkError";
    this.code = code;
  }
}

/** Клиент процесса, пока пакета SDK нет в зависимостях. Ветка local его не вызывает. */
export function unavailableClaudeSdkClient(): ClaudeSdkClient {
  return {
    run(): Promise<void> {
      return Promise.reject(
        new ClaudeSdkError("sdk_not_installed", "claude sdk package is not installed"),
      );
    },
  };
}
