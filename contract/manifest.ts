import { z } from "zod";

import { codePointLength, isCodePointBounded, isPlainObject, readOwn, scanData } from "./data.js";
import { issueReason } from "./envelope.js";
import {
  DESCRIPTION_MAX,
  ENV_NAME_RE,
  FINGERPRINT_RE,
  SERVICE_ID_RE,
  TOOL_NAME_RE,
  TOOL_VERSION,
} from "./limits.js";
import { SERVICES_VERSION } from "./result.js";

/** Имя localhost манифест не принимает. */
export const LOCALHOST_BASE_URL_MESSAGE = "нужен http://127.0.0.1, не localhost";

/** none не для https, не для частной сети и не для лупбэка без порта. */
export const AUTH_NONE_MESSAGE = "auth none только для http://127.0.0.1 с портом";

/** Неизвестная версия не игнорируется и не заменяется на последнюю. */
export const UNKNOWN_TOOL_VERSION_MESSAGE = "неизвестная версия инструмента";

export function duplicateModelNameMessage(name: string): string {
  return `два сервиса отдают одно имя для модели: ${name}`;
}

export type ServiceAuth = { type: "none" } | { type: "bearer"; env: string };

export interface ServiceTool {
  name: string;
  version: typeof TOOL_VERSION;
  effect: "read" | "write";
  description: string;
  accepts_blobs: boolean;
  parameters: Record<string, unknown>;
}

export interface ServiceEntry {
  id: string;
  base_url: string;
  auth: ServiceAuth;
  tls_fingerprint256?: string;
  tools: ServiceTool[];
}

export interface ServicesManifest {
  contract: typeof SERVICES_VERSION;
  services: ServiceEntry[];
}

export type ManifestResult =
  | { ok: true; value: ServicesManifest }
  | {
      ok: false;
      reason: "unknown_field" | "unsupported_version" | "invalid_manifest";
      message?: string;
    };

const PARAMETER_KEYS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "maxLength",
  "minLength",
  "enum",
]);

const PARAMETER_TYPES: ReadonlySet<string> = new Set([
  "object",
  "string",
  "integer",
  "number",
  "boolean",
]);

const manifestToolSchema = z
  .object({
    name: z.string().min(1).max(64).regex(TOOL_NAME_RE),
    version: z.string(),
    effect: z.enum(["read", "write"]),
    description: z.string().refine((value) => isCodePointBounded(value, 0, DESCRIPTION_MAX)),
    accepts_blobs: z.boolean(),
    parameters: z.unknown(),
  })
  .strict()
  .superRefine((tool, context) => {
    if (tool.version !== TOOL_VERSION) {
      context.addIssue({ code: "custom", message: UNKNOWN_TOOL_VERSION_MESSAGE });
    }
    if (!parametersAllowed(tool.parameters, 0)) {
      context.addIssue({ code: "custom", message: "parameters" });
    }
  });

const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("bearer"),
      env: z.string().regex(ENV_NAME_RE),
    })
    .strict(),
]);

const serviceSchema = z
  .object({
    id: z.string().regex(SERVICE_ID_RE),
    base_url: z.string().min(1).max(128),
    auth: authSchema,
    tls_fingerprint256: z.string().regex(FINGERPRINT_RE).optional(),
    tools: z.array(manifestToolSchema).min(1),
  })
  .strict()
  .superRefine((service, context) => {
    const base = inspectBaseUrl(service.base_url);
    if (!base.ok) {
      context.addIssue({ code: "custom", message: base.message });
      return;
    }
    if (base.tlsRequired && service.tls_fingerprint256 === undefined) {
      context.addIssue({ code: "custom", message: "tls_fingerprint256" });
    }
    if (service.auth.type === "none" && !base.httpLoopbackWithPort) {
      context.addIssue({ code: "custom", message: AUTH_NONE_MESSAGE });
    }
  });

const manifestSchema = z
  .object({
    contract: z.literal(SERVICES_VERSION),
    services: z.array(serviceSchema),
  })
  .strict();

/**
 * Локальный файл оператора. Схему по сети эта функция не скачивает.
 * Секрет в манифест не пишется: у bearer только имя переменной окружения.
 */
export function parseServicesManifest(value: unknown): ManifestResult {
  const scanned = scanData(value);
  if (!scanned.ok) {
    return {
      ok: false,
      reason: scanned.reason === "unknown_field" ? "unknown_field" : "invalid_manifest",
    };
  }
  if (foreignServicesContract(value)) {
    return { ok: false, reason: "unsupported_version" };
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    return manifestFailure(parsed.error.issues);
  }
  return materialize(parsed.data);
}

function manifestFailure(issues: readonly { code: string; message: string }[]): ManifestResult {
  if (issueReason(issues) === "unknown_field") {
    return { ok: false, reason: "unknown_field" };
  }
  for (const issue of issues) {
    if (issue.code === "custom" && publishedMessage(issue.message)) {
      return { ok: false, reason: "invalid_manifest", message: issue.message };
    }
  }
  return { ok: false, reason: "invalid_manifest" };
}

function publishedMessage(message: string): boolean {
  return (
    message === LOCALHOST_BASE_URL_MESSAGE ||
    message === AUTH_NONE_MESSAGE ||
    message === UNKNOWN_TOOL_VERSION_MESSAGE
  );
}

function foreignServicesContract(value: unknown): boolean {
  if (!isPlainObject(value) || !Object.hasOwn(value, "contract")) {
    return false;
  }
  return readOwn(value, "contract") !== SERVICES_VERSION;
}

function materialize(parsed: z.infer<typeof manifestSchema>): ManifestResult {
  const ids = new Set<string>();
  const modelNames = new Map<string, string>();
  const services: ServiceEntry[] = [];
  for (const service of parsed.services) {
    if (ids.has(service.id)) {
      return { ok: false, reason: "invalid_manifest" };
    }
    ids.add(service.id);
    const tools: ServiceTool[] = [];
    for (const tool of service.tools) {
      if (tool.version !== TOOL_VERSION) {
        return { ok: false, reason: "invalid_manifest", message: UNKNOWN_TOOL_VERSION_MESSAGE };
      }
      const owner = modelNames.get(tool.name);
      if (owner !== undefined) {
        return {
          ok: false,
          reason: "invalid_manifest",
          message:
            owner === service.id
              ? `имя для модели повторяется: ${tool.name}`
              : duplicateModelNameMessage(tool.name),
        };
      }
      modelNames.set(tool.name, service.id);
      if (!isPlainObject(tool.parameters)) {
        return { ok: false, reason: "invalid_manifest" };
      }
      tools.push({
        name: tool.name,
        version: TOOL_VERSION,
        effect: tool.effect,
        description: tool.description,
        accepts_blobs: tool.accepts_blobs,
        parameters: tool.parameters,
      });
    }
    const entry: ServiceEntry = {
      id: service.id,
      base_url: service.base_url,
      auth: service.auth,
      tools,
    };
    if (service.tls_fingerprint256 !== undefined) {
      entry.tls_fingerprint256 = service.tls_fingerprint256;
    }
    services.push(entry);
  }
  return { ok: true, value: { contract: SERVICES_VERSION, services } };
}

interface BaseUrlOk {
  ok: true;
  tlsRequired: boolean;
  httpLoopbackWithPort: boolean;
}

type BaseUrl = BaseUrlOk | { ok: false; message: string };

function inspectBaseUrl(value: string): BaseUrl {
  if (value.length === 0 || value.length > 128) {
    return { ok: false, message: "base_url" };
  }
  let protocol: "http" | "https";
  let rest: string;
  if (value.startsWith("https://")) {
    protocol = "https";
    rest = value.slice("https://".length);
  } else if (value.startsWith("http://")) {
    protocol = "http";
    rest = value.slice("http://".length);
  } else {
    return { ok: false, message: "base_url" };
  }
  if (
    rest.includes("@") ||
    rest.includes("?") ||
    rest.includes("#") ||
    rest.includes("[") ||
    rest.includes("]") ||
    rest.includes(" ") ||
    rest.includes("\\")
  ) {
    return { ok: false, message: "base_url" };
  }
  if (rest.endsWith("/")) {
    rest = rest.slice(0, -1);
  }
  if (rest.length === 0 || rest.includes("/")) {
    return { ok: false, message: "base_url" };
  }
  let host = rest;
  let hasPort = false;
  const colon = rest.lastIndexOf(":");
  if (colon !== -1) {
    host = rest.slice(0, colon);
    hasPort = true;
    if (!isPort(rest.slice(colon + 1))) {
      return { ok: false, message: "base_url" };
    }
  }
  if (host.toLowerCase() === "localhost") {
    return { ok: false, message: LOCALHOST_BASE_URL_MESSAGE };
  }
  const octets = parseIpv4(host);
  if (octets === null) {
    return { ok: false, message: "base_url" };
  }
  const loopback = octets[0] === 127 && octets[1] === 0 && octets[2] === 0 && octets[3] === 1;
  if (protocol === "http") {
    if (!loopback) {
      return { ok: false, message: "base_url" };
    }
    return { ok: true, tlsRequired: false, httpLoopbackWithPort: hasPort };
  }
  if (loopback) {
    return { ok: true, tlsRequired: false, httpLoopbackWithPort: false };
  }
  if (!isPrivate(octets)) {
    return { ok: false, message: "base_url" };
  }
  return { ok: true, tlsRequired: true, httpLoopbackWithPort: false };
}

function isPort(value: string): boolean {
  if (value.length === 0 || value.length > 5) {
    return false;
  }
  for (const char of value) {
    if (char < "0" || char > "9") {
      return false;
    }
  }
  if (value.length > 1 && value.startsWith("0")) {
    return false;
  }
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const first = octet(parts[0]);
  const second = octet(parts[1]);
  const third = octet(parts[2]);
  const fourth = octet(parts[3]);
  if (first === null || second === null || third === null || fourth === null) {
    return null;
  }
  return [first, second, third, fourth];
}

function octet(part: string | undefined): number | null {
  if (part === undefined || part.length === 0 || part.length > 3) {
    return null;
  }
  for (const char of part) {
    if (char < "0" || char > "9") {
      return null;
    }
  }
  if (part.length > 1 && part.startsWith("0")) {
    return null;
  }
  const value = Number(part);
  if (!Number.isInteger(value) || value > 255) {
    return null;
  }
  return value;
}

function isPrivate(octets: readonly [number, number, number, number]): boolean {
  const first = octets[0];
  const second = octets[1];
  if (first === 10) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  return first === 192 && second === 168;
}

/**
 * Слова pattern, $ref, $data, allOf, items, maxItems и любое иное схему бракуют.
 * Массива в параметрах нет: items запрещён, maxItems ничего не ограничивает.
 */
function parametersAllowed(value: unknown, depth: number): boolean {
  if (depth > 8 || !isPlainObject(value)) {
    return false;
  }
  const names = Object.getOwnPropertyNames(value);
  for (const key of names) {
    if (!PARAMETER_KEYS.has(key)) {
      return false;
    }
  }
  const type = readOwn(value, "type");
  if (typeof type !== "string" || !PARAMETER_TYPES.has(type)) {
    return false;
  }
  // Корень parameters — object: arguments вызова тоже объект, строка не вызывается.
  if (depth === 0 && type !== "object") {
    return false;
  }
  if (type === "object") {
    if (readOwn(value, "additionalProperties") !== false) {
      return false;
    }
    if (!propertiesAllowed(readOwn(value, "properties"), depth)) {
      return false;
    }
    if (!requiredAllowed(readOwn(value, "required"), value)) {
      return false;
    }
  } else if (
    Object.hasOwn(value, "properties") ||
    Object.hasOwn(value, "required") ||
    Object.hasOwn(value, "additionalProperties")
  ) {
    return false;
  }
  if (!lengthAllowed(value, type)) {
    return false;
  }
  return enumAllowed(readOwn(value, "enum"), type);
}

function propertiesAllowed(value: unknown, depth: number): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isPlainObject(value)) {
    return false;
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length > 32) {
    return false;
  }
  for (const name of names) {
    if (!isCodePointBounded(name, 1, 64)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !parametersAllowed(descriptor.value, depth + 1)) {
      return false;
    }
  }
  return true;
}

function requiredAllowed(value: unknown, owner: object): boolean {
  if (value === undefined) {
    return !Object.hasOwn(owner, "required");
  }
  if (!Array.isArray(value) || value.length > 32) {
    return false;
  }
  const properties = readOwn(owner, "properties");
  for (const item of value) {
    if (typeof item !== "string" || !isCodePointBounded(item, 1, 64)) {
      return false;
    }
    // Имени нет среди properties, а additionalProperties ложен: такого объекта не бывает.
    if (!isPlainObject(properties) || !Object.hasOwn(properties, item)) {
      return false;
    }
  }
  return true;
}

function lengthAllowed(value: object, type: string): boolean {
  const minLength = readOwn(value, "minLength");
  const maxLength = readOwn(value, "maxLength");
  if (minLength === undefined && maxLength === undefined) {
    return !Object.hasOwn(value, "minLength") && !Object.hasOwn(value, "maxLength");
  }
  if (type !== "string") {
    return false;
  }
  if (minLength !== undefined && !isBoundedInt(minLength, 65536)) {
    return false;
  }
  if (maxLength !== undefined && !isBoundedInt(maxLength, 65536)) {
    return false;
  }
  if (typeof minLength === "number" && typeof maxLength === "number" && minLength > maxLength) {
    return false;
  }
  return true;
}

function enumAllowed(value: unknown, type: string): boolean {
  if (value === undefined) {
    return true;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    return false;
  }
  for (const item of value) {
    if (!enumMemberMatchesType(item, type)) {
      return false;
    }
  }
  return true;
}

/** Член enum должен сам удовлетворять type, иначе ни одно значение не подходит. */
function enumMemberMatchesType(item: unknown, type: string): boolean {
  if (type === "string") {
    return typeof item === "string" && codePointLength(item) <= 64;
  }
  if (type === "boolean") {
    return typeof item === "boolean";
  }
  if (type === "integer") {
    return typeof item === "number" && Number.isInteger(item);
  }
  if (type === "number") {
    return typeof item === "number" && Number.isFinite(item);
  }
  return false;
}

function isBoundedInt(value: unknown, max: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
