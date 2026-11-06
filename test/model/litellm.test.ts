import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import type { ModelInput, ModelOutput } from "../../src/contracts/index.js";
import { LiteLLMChatModel, ModelError } from "../../src/model/litellm.js";

interface CapturedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

interface FakeResponse {
  status: number;
  body: unknown;
}

const apiKey = "test-api-key";
const listedSecret = "test-secret-value";

function userInput(overrides: Partial<ModelInput> = {}): ModelInput {
  return {
    model: "agent",
    temperature: 0,
    messages: [{ role: "user", content: "привет", toolCallId: null, toolCalls: null }],
    tools: [],
    ...overrides,
  };
}

describe("LiteLLMChatModel", () => {
  it("должен отправить POST chat/completions и разобрать текст без tool_calls", async () => {
    const input: ModelInput = {
      model: "agent",
      temperature: 0,
      tools: [
        {
          name: "read_file",
          description: "Прочитать файл",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      messages: [
        { role: "system", content: "Ты клерк", toolCallId: null, toolCalls: null },
        { role: "user", content: "прочитай note.txt", toolCallId: null, toolCalls: null },
        {
          role: "assistant",
          content: null,
          toolCallId: null,
          toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"note.txt"}' }],
        },
        { role: "tool", content: "внутри", toolCallId: "call-1", toolCalls: null },
      ],
    };

    await withServer(
      { status: 200, body: textCompletion("готово") },
      async ({ baseUrl, requests }) => {
        const model = new LiteLLMChatModel({
          baseUrl: `${baseUrl}/`,
          apiKey,
          secrets: [listedSecret],
        });
        const output = await model.complete(input);

        expect(requests).toHaveLength(1);
        const request = requests[0];
        expect(request?.method).toBe("POST");
        expect(request?.url).toBe("/v1/chat/completions");
        expect(request?.authorization).toBe(`Bearer ${apiKey}`);
        expect(request?.contentType).toContain("application/json");
        expect(request?.body).toEqual({
          model: "agent",
          temperature: 0,
          messages: [
            { role: "system", content: "Ты клерк" },
            { role: "user", content: "прочитай note.txt" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"note.txt"}' },
                },
              ],
            },
            { role: "tool", content: "внутри", tool_call_id: "call-1" },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "read_file",
                description: "Прочитать файл",
                parameters: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
              },
            },
          ],
        });
        expect(output).toEqual({
          content: "готово",
          toolCalls: [],
          promptTokens: 11,
          completionTokens: 2,
          model: "agent",
        } satisfies ModelOutput);
      },
    );
  });

  it("должен оставить arguments строкой у одного tool call", async () => {
    await withServer(
      {
        status: 200,
        body: {
          model: "qwen-alias",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-7",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":"a.txt"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 0 },
        },
      },
      async ({ baseUrl }) => {
        const model = new LiteLLMChatModel({ baseUrl, apiKey });
        const output = await model.complete(userInput());
        expect(output).toEqual({
          content: null,
          toolCalls: [{ id: "call-7", name: "read_file", arguments: '{"path":"a.txt"}' }],
          promptTokens: 5,
          completionTokens: 0,
          model: "qwen-alias",
        } satisfies ModelOutput);
        expect(output.toolCalls[0]?.arguments).toBe('{"path":"a.txt"}');
      },
    );
  });

  it("должен вернуть пустые content и toolCalls при пустом choices", async () => {
    await withServer(
      { status: 200, body: { model: "agent", choices: [] } },
      async ({ baseUrl }) => {
        const model = new LiteLLMChatModel({ baseUrl, apiKey });
        const output = await model.complete(userInput());
        expect(output).toEqual({
          content: null,
          toolCalls: [],
          promptTokens: null,
          completionTokens: null,
          model: "agent",
        } satisfies ModelOutput);
      },
    );
  });

  it("должен выбросить статус без тела, если в теле секрет из списка", async () => {
    await withServer(
      {
        status: 401,
        body: { error: `marker-not-for-exception ${listedSecret}` },
      },
      async ({ baseUrl }) => {
        const model = new LiteLLMChatModel({
          baseUrl,
          apiKey,
          secrets: [listedSecret],
        });
        const caught = await capture(() => model.complete(userInput()));
        expect(caught).toBeInstanceOf(ModelError);
        if (!(caught instanceof ModelError)) {
          return;
        }
        expect(caught.status).toBe(401);
        expect(caught.code).toBe("401");
        expect(caught.message).toContain("401");
        expect(caught.message).not.toContain(listedSecret);
        expect(caught.message).not.toContain("marker-not-for-exception");
        expect(caught.message).not.toContain("error");
      },
    );
  });

  it("должен выбросить статус без тела, если секрет из списка короткий", async () => {
    const shortSecret = "short";
    await withServer(
      {
        status: 401,
        body: { error: `marker-not-for-exception ${shortSecret}` },
      },
      async ({ baseUrl }) => {
        const model = new LiteLLMChatModel({
          baseUrl,
          apiKey,
          secrets: [shortSecret],
        });
        const caught = await capture(() => model.complete(userInput()));
        expect(caught).toBeInstanceOf(ModelError);
        if (!(caught instanceof ModelError)) {
          return;
        }
        expect(caught.status).toBe(401);
        expect(caught.code).toBe("401");
        expect(caught.message).not.toContain(shortSecret);
        expect(caught.message).not.toContain("marker-not-for-exception");
      },
    );
  });

  it("должен оставить короткую причину и замаскировать шаблон ключа, если секрета из списка нет", async () => {
    await withServer(
      { status: 503, body: { error: "model busy sk-testsecretvalue" } },
      async ({ baseUrl }) => {
        const model = new LiteLLMChatModel({ baseUrl, apiKey });
        const caught = await capture(() => model.complete(userInput()));
        expect(caught).toBeInstanceOf(ModelError);
        if (!(caught instanceof ModelError)) {
          return;
        }
        expect(caught.status).toBe(503);
        expect(caught.code).toBe("503");
        expect(caught.message).toContain("model busy");
        expect(caught.message).toContain("[redacted]");
        expect(caught.message).not.toContain("sk-testsecretvalue");
        expect(caught.message).not.toContain(apiKey);
      },
    );
  });

  it("должен отказать, если arguments пришёл объектом, и не включить секрет в ошибку", async () => {
    await withServer(
      {
        status: 200,
        body: {
          model: "agent",
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-9",
                    type: "function",
                    function: { name: "read_file", arguments: { path: listedSecret } },
                  },
                ],
              },
            },
          ],
        },
      },
      async ({ baseUrl }) => {
        const model = new LiteLLMChatModel({ baseUrl, apiKey, secrets: [listedSecret] });
        const caught = await capture(() => model.complete(userInput()));
        expect(caught).toBeInstanceOf(ModelError);
        if (!(caught instanceof ModelError)) {
          return;
        }
        expect(caught.code).toBe("model_response_invalid");
        expect(caught.message).not.toContain(listedSecret);
      },
    );
  });

  it("должен отказать на baseUrl не http и на перевод строки в ключе", () => {
    expect(() => new LiteLLMChatModel({ baseUrl: "ftp://127.0.0.1/v1", apiKey })).toThrow(
      ModelError,
    );
    try {
      new LiteLLMChatModel({ baseUrl: "ftp://127.0.0.1/v1", apiKey });
    } catch (error) {
      expect(error).toBeInstanceOf(ModelError);
      if (error instanceof ModelError) {
        expect(error.code).toBe("model_config_invalid");
        expect(error.message).not.toContain("ftp://");
        expect(error.message).not.toContain(apiKey);
      }
    }

    expect(
      () =>
        new LiteLLMChatModel({
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: `${apiKey}\nInjected: 1`,
        }),
    ).toThrow(ModelError);
  });
});

function textCompletion(content: string): unknown {
  return {
    id: "cmpl-1",
    model: "agent",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
  };
}

async function capture(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected model error");
}

async function withServer(
  response: FakeResponse,
  run: (ctx: { baseUrl: string; requests: CapturedRequest[] }) => Promise<void>,
): Promise<void> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    void handle(req, res, requests, response);
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  await listen(server);
  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server address");
    }
    await run({ baseUrl: `http://127.0.0.1:${address.port}/v1`, requests });
  } finally {
    await closeServer(server);
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  requests: CapturedRequest[],
  response: FakeResponse,
): Promise<void> {
  try {
    const raw = await readIncoming(req);
    let body: unknown = raw;
    if (raw.length > 0) {
      body = JSON.parse(raw) as unknown;
    }
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization:
        typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
      contentType:
        typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined,
      body,
    });
    res.statusCode = response.status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(response.body));
  } catch {
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    res.end();
  }
}

async function readIncoming(req: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(copyChunk(chunk));
  }
  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

/** Поток запроса в типах Node отдаёт any. Наружу выходит только байтовый срез. */
function copyChunk(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new Error("unexpected request chunk");
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
