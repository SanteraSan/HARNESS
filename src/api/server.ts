import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { IncomingHttpHeaders } from "node:http";

import { logger } from "../config.js";
import { JSON_BODY_LIMIT_BYTES, contentLengthStatus } from "./body.js";
import { ApiConfigError, ApiError } from "./errors.js";

/** Адрес M1. Порт не в конфиге: снаружи слушать нельзя. */
export const API_LISTEN_HOST = "127.0.0.1";

/** Не занимает порты стека 3000, 5432, 5442, 4000 и 8765. */
export const API_LISTEN_PORT = 8787;

const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;

interface FetchApp {
  fetch(request: Request): Promise<Response> | Response;
}

/**
 * Слушаем 127.0.0.1.
 * requestTimeout и headersTimeout обрывают медленного клиента, сокет подписан на error.
 */
export function startHttpServer(app: FetchApp, port: number): Server {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new ApiConfigError("listen port is invalid");
  }

  const server = createServer((req, res) => {
    res.on("error", (error) => {
      logger.error({ err: error }, "response socket error");
    });
    void handleNodeRequest(app, req, res);
  });

  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  server.on("clientError", (error, socket) => {
    logger.error({ err: error }, "client socket error");
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    try {
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nContent-Length: 0\r\n\r\n",
      );
    } catch (endError) {
      logger.error({ err: endError }, "client socket close failed");
      socket.destroy();
    }
  });

  server.on("connection", (socket) => {
    socket.on("error", (error) => {
      logger.error({ err: error }, "socket error");
    });
  });

  server.listen(port, API_LISTEN_HOST);
  return server;
}

async function handleNodeRequest(
  app: FetchApp,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  req.on("error", (error) => {
    logger.error({ err: error }, "request socket error");
  });

  try {
    const prepared = await prepareRequest(req);
    if (prepared instanceof Response) {
      await writeFetchResponse(res, prepared);
      if (prepared.status === 413) {
        req.destroy();
      }
      return;
    }
    const response = await app.fetch(prepared);
    await writeFetchResponse(res, response);
  } catch (error) {
    logger.error({ err: error }, "http request failed");
    writeRawJson(res, 500, "internal_error");
  }
}

async function prepareRequest(req: IncomingMessage): Promise<Request | Response> {
  const method = req.method ?? "GET";
  const url = requestUrl(req.url ?? "");
  if (url === null) {
    return jsonResponse(400, "invalid_request");
  }

  const headers = copyHeaders(req.headers);
  if (headers === "invalid") {
    return jsonResponse(400, "invalid_request");
  }

  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  const declared = headerField(req.headers["content-length"]);
  if (declared.kind === "repeated") {
    return jsonResponse(400, "invalid_request");
  }
  if (declared.kind === "value") {
    const status = contentLengthStatus(declared.value);
    if (status === "invalid") {
      return jsonResponse(400, "invalid_request");
    }
    if (status === "too_large") {
      return jsonResponse(413, "payload_too_large");
    }
  }

  const body = await readLimited(req);
  if (body === "too_large") {
    return jsonResponse(413, "payload_too_large");
  }
  if (body.byteLength === 0) {
    return new Request(url, { method, headers });
  }
  return new Request(url, { method, headers, body });
}

function requestUrl(rawUrl: string): URL | null {
  if (
    rawUrl.length === 0 ||
    rawUrl.length > 2048 ||
    !rawUrl.startsWith("/") ||
    rawUrl.startsWith("//")
  ) {
    return null;
  }
  if (rawUrl.includes("\\") || rawUrl.includes("\u0000")) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(rawUrl, `http://${API_LISTEN_HOST}`);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.hostname !== API_LISTEN_HOST) {
    return null;
  }
  return url;
}

function copyHeaders(incoming: IncomingHttpHeaders): Headers | "invalid" {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      // Повтор authorization и content-length не склеиваем.
      if (key.toLowerCase() === "authorization" || key.toLowerCase() === "content-length") {
        continue;
      }
      for (const item of value) {
        if (!appendHeader(headers, key, item)) {
          return "invalid";
        }
      }
      continue;
    }
    if (!appendHeader(headers, key, value)) {
      return "invalid";
    }
  }
  return headers;
}

function appendHeader(headers: Headers, key: string, value: string): boolean {
  try {
    headers.append(key, value);
    return true;
  } catch {
    return false;
  }
}

function headerField(value: string | string[] | undefined): HeaderField {
  if (value === undefined) {
    return { kind: "absent" };
  }
  if (Array.isArray(value)) {
    return { kind: "repeated" };
  }
  return { kind: "value", value };
}

type HeaderField = { kind: "absent" } | { kind: "repeated" } | { kind: "value"; value: string };

async function readLimited(req: IncomingMessage): Promise<Uint8Array | "too_large"> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = copyChunk(chunk as unknown);
    total += bytes.byteLength;
    if (total > JSON_BODY_LIMIT_BYTES) {
      return "too_large";
    }
    chunks.push(bytes);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Поток запроса в типах Node отдаёт any. Наружу выходит только байтовый срез. */
function copyChunk(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new ApiError("invalid_request");
}

function jsonResponse(status: number, reason: string): Response {
  return new Response(JSON.stringify({ reason }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  const bytes = Buffer.from(await response.arrayBuffer());
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  if (!res.hasHeader("x-content-type-options")) {
    res.setHeader("x-content-type-options", "nosniff");
  }
  await endResponse(res, response.status, bytes);
}

function endResponse(res: ServerResponse, status: number, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      res.off("error", onError);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    const onError = (error: Error): void => {
      finish(error);
    };
    res.once("error", onError);
    res.writeHead(status);
    res.end(bytes, () => {
      finish();
    });
  });
}

function writeRawJson(res: ServerResponse, status: number, reason: string): void {
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  const payload = JSON.stringify({ reason });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
