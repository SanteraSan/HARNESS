import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { z } from "zod";

import type {
  ChatModel,
  ModelInput,
  ModelMessage,
  ModelOutput,
  ModelToolSpec,
} from "../contracts/index.js";

import { MAX_COMPLETION_TOKENS } from "./limits.js";
import { containsListedSecret, redact } from "./redact.js";

/** Ответ длиннее этого не отдаётся в JSON.parse. */
const RESPONSE_BODY_LIMIT = 1_048_576;

/** Префикс тела ошибки для поиска секрета и для короткой причины. */
const ERROR_BODY_LIMIT = 8_192;

/** Короткая причина в тексте исключения, если в теле нет секрета из списка. */
const ERROR_REASON_LIMIT = 200;

const DEFAULT_TIMEOUT_MS = 60_000;

const toolCallSchema = z.object({
  id: z.string(),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const completionSchema = z.object({
  model: z.string().optional(),
  response_cost: z.unknown().optional(),
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.string().nullable().optional(),
            tool_calls: z.array(toolCallSchema).nullable().optional(),
          })
          .nullable()
          .optional(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().nullable().optional(),
      completion_tokens: z.number().int().nonnegative().nullable().optional(),
      cost: z.unknown().optional(),
    })
    .nullable()
    .optional(),
});

type CompletionBody = z.infer<typeof completionSchema>;

interface WireToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface WireMessage {
  role: ModelMessage["role"];
  content: string | null;
  tool_call_id?: string;
  tool_calls?: WireToolCall[];
}

interface WireTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface WireRequest {
  model: string;
  temperature: 0;
  max_tokens: number;
  messages: WireMessage[];
  tools: WireTool[];
}

interface CappedText {
  text: string;
  overflow: boolean;
}

export interface LiteLLMChatModelOptions {
  baseUrl: string;
  apiKey: string;
  secrets?: readonly string[];
  timeoutMs?: number;
}

export class ModelError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "ModelError";
    this.code = code;
    this.status = status;
  }
}

/** Клиент OpenAI-совместимого шлюза. Цикл раннера и журнал сюда не входят. */
export class LiteLLMChatModel implements ChatModel {
  private readonly completionsUrl: URL;
  private readonly apiKey: string;
  private readonly secrets: readonly string[];
  private readonly timeoutMs: number;

  constructor(options: LiteLLMChatModelOptions) {
    this.completionsUrl = resolveCompletionsUrl(options.baseUrl);
    if (options.apiKey.includes("\r") || options.apiKey.includes("\n")) {
      throw new ModelError("model_config_invalid", "model api key is invalid");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new ModelError("model_config_invalid", "model timeout is invalid");
    }
    this.apiKey = options.apiKey;
    this.timeoutMs = timeoutMs;
    this.secrets = mergeSecrets(options.apiKey, options.secrets ?? []);
  }

  async complete(input: ModelInput): Promise<ModelOutput> {
    let serialized: string;
    try {
      serialized = JSON.stringify(buildPayload(input));
    } catch {
      throw new ModelError("model_request_invalid", "model request invalid");
    }

    let response: Response;
    try {
      // fetch здесь нельзя: undici обрывает ожидание заголовков через 300 секунд,
      // раньше нашего сигнала. Медленный ответ Gemini тогда теряется.
      response = await postJson(
        this.completionsUrl,
        serialized,
        {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        this.timeoutMs,
      );
    } catch (error) {
      throw transportError(error, this.secrets);
    }

    if (!response.ok) {
      await throwHttpError(response, this.secrets);
    }

    let received: CappedText;
    try {
      received = await readText(response, RESPONSE_BODY_LIMIT);
    } catch (error) {
      throw transportError(error, this.secrets);
    }
    if (received.overflow) {
      throw new ModelError("model_response_invalid", "model response invalid", response.status);
    }
    return parseCompletion(input, received.text, response.status);
  }
}

function mergeSecrets(apiKey: string, extra: readonly string[]): readonly string[] {
  const secrets: string[] = [];
  if (apiKey.length > 0) {
    secrets.push(apiKey);
  }
  for (const secret of extra) {
    secrets.push(secret);
  }
  return secrets;
}

function resolveCompletionsUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ModelError("model_config_invalid", "model base url is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ModelError("model_config_invalid", "model base url is invalid");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ModelError("model_config_invalid", "model base url is invalid");
  }

  let path = url.pathname;
  while (path.endsWith("/") && path.length > 1) {
    path = path.slice(0, -1);
  }
  if (path === "/") {
    path = "";
  }
  url.pathname = `${path}/chat/completions`;
  url.search = "";
  url.hash = "";
  return url;
}

function buildPayload(input: ModelInput): WireRequest {
  return {
    model: input.model,
    temperature: 0,
    max_tokens: requireCompletionTokens(input.maxTokens),
    messages: input.messages.map(toWireMessage),
    tools: input.tools.map(toWireTool),
  };
}

/** Вне диапазона миграции запрос не уходит: иначе шлюз снова пишет без предела. */
function requireCompletionTokens(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_COMPLETION_TOKENS) {
    throw new ModelError("model_request_invalid", "model request invalid");
  }
  return value;
}

function toWireMessage(message: ModelMessage): WireMessage {
  const wire: WireMessage = {
    role: message.role,
    content: message.content,
  };
  if (message.toolCallId !== null) {
    wire.tool_call_id = message.toolCallId;
  }
  if (message.toolCalls !== null) {
    wire.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: call.arguments,
      },
    }));
  }
  return wire;
}

function toWireTool(tool: ModelToolSpec): WireTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

async function throwHttpError(response: Response, secrets: readonly string[]): Promise<never> {
  let body = "";
  try {
    const received = await readText(response, ERROR_BODY_LIMIT);
    body = received.text;
  } catch (error) {
    throw transportError(error, secrets);
  }

  const status = response.status;
  if (containsListedSecret(body, secrets)) {
    throw new ModelError(String(status), redact(`model http ${status}`, secrets), status);
  }

  const reason = body.slice(0, ERROR_REASON_LIMIT);
  throw new ModelError(String(status), redact(`model http ${status}: ${reason}`, secrets), status);
}

function parseCompletion(input: ModelInput, text: string, status: number): ModelOutput {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new ModelError("model_response_invalid", "model response invalid", status);
  }

  const parsed = completionSchema.safeParse(json);
  if (!parsed.success) {
    throw new ModelError("model_response_invalid", "model response invalid", status);
  }
  return toModelOutput(input, parsed.data);
}

function toModelOutput(input: ModelInput, body: CompletionBody): ModelOutput {
  const message = body.choices?.[0]?.message ?? undefined;
  const calls = message?.tool_calls ?? [];
  const reported = body.model;
  return {
    content: message?.content ?? null,
    toolCalls: calls.map((call) => ({
      id: call.id,
      name: call.function.name,
      // Тело аргументов остаётся строкой: здесь его не разбираем.
      arguments: call.function.arguments,
    })),
    promptTokens: body.usage?.prompt_tokens ?? null,
    completionTokens: body.usage?.completion_tokens ?? null,
    model: reported !== undefined && reported.length > 0 ? reported : input.model,
    // Нет конечного числа — null, ход при этом уже разобран и не отбрасывается.
    costUsd: costFromBody(body),
  };
}

function costFromBody(body: CompletionBody): number | null {
  const usage = body.usage;
  if (usage != null && usage.cost !== undefined) {
    return finiteNumber(usage.cost);
  }
  if (body.response_cost !== undefined) {
    return finiteNumber(body.response_cost);
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

/**
 * Прямой POST без следования редиректу: заголовок bearer не уходит на другой хост.
 * Тишина сокета дольше timeoutMs — TimeoutError, как у AbortSignal.timeout.
 */
function postJson(
  url: URL,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
    const succeed = (response: Response): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(response);
    };

    const req = request(
      url,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-length": String(Buffer.byteLength(body)),
        },
        signal,
      },
      (incoming) => {
        // Редирект не читаем и не повторяем: цель могла бы получить bearer.
        if (isRedirect(incoming.statusCode)) {
          incoming.resume();
          fail(new Error("redirect refused"));
          return;
        }
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          const payload = Buffer.concat(chunks);
          succeed(new Response(payload, { status: incoming.statusCode ?? 0 }));
        });
        incoming.on("error", fail);
      },
    );
    req.setTimeout(timeoutMs, () => {
      const error = new Error("model timeout");
      error.name = "TimeoutError";
      req.destroy(error);
    });
    req.on("error", fail);
    req.end(body);
  });
}

function isRedirect(status: number | undefined): boolean {
  return status !== undefined && status >= 300 && status < 400;
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "TimeoutError") {
    return true;
  }
  return error.cause instanceof Error && error.cause.name === "TimeoutError";
}

function transportError(error: unknown, secrets: readonly string[]): ModelError {
  if (error instanceof ModelError) {
    return error;
  }
  if (isTimeout(error)) {
    return new ModelError("model_timeout", "model timeout");
  }
  const detail = error instanceof Error ? error.message : "model transport failed";
  return new ModelError("model_transport", redact(detail, secrets));
}

async function readText(response: Response, limit: number): Promise<CappedText> {
  const buffer = await response.arrayBuffer();
  const overflow = buffer.byteLength > limit;
  const bytes = overflow ? buffer.slice(0, limit) : buffer;
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    overflow,
  };
}
