import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseServicesManifest, type ServicesManifest } from "../contract/manifest.js";
import pino from "pino";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  HARNESS_TEST_DATABASE_URL: z.string().min(1).optional(),
  LITELLM_BASE_URL: z.url().default("http://127.0.0.1:4000/v1"),
  LITELLM_API_KEY: z.string().default(""),
  HARNESS_API_TOKEN: z.string().default(""),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_ALLOWED_USER_IDS: z.string().default(""),
  AGENT_SLUG: z.string().min(1).default("clerk"),
  FILE_ROOT: z.string().min(1).default("./workspace"),
  WORKER_ID: z.string().min(1).optional(),
  LEASE_SECONDS: z.coerce.number().int().positive().default(120),
  HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(15),
  HARNESS_LIVE_MODEL: z.string().min(1).optional(),
  SERVICES_MANIFEST: z.string().min(1).optional(),
  SERVICES_MANIFEST_SHA256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export interface Config {
  databaseUrl: string;
  harnessTestDatabaseUrl: string | null;
  litellmBaseUrl: string;
  litellmApiKey: string;
  harnessApiToken: string;
  telegramBotToken: string;
  telegramAllowedUserIds: readonly string[];
  agentSlug: string;
  fileRoot: string;
  workerId: string;
  leaseSeconds: number;
  heartbeatSeconds: number;
  harnessLiveModel: string | null;
  servicesManifestPath: string | null;
  servicesManifestSha256: string | null;
}

export class ConfigError extends Error {
  readonly code = "config_invalid";

  constructor(fields: readonly string[]) {
    super(`invalid config: ${fields.join(", ")}`);
    this.name = "ConfigError";
  }
}

export const logger = pino({
  level: "info",
  redact: {
    paths: [
      "DATABASE_URL",
      "databaseUrl",
      "HARNESS_TEST_DATABASE_URL",
      "harnessTestDatabaseUrl",
      "LITELLM_API_KEY",
      "litellmApiKey",
      "HARNESS_API_TOKEN",
      "harnessApiToken",
      "TELEGRAM_BOT_TOKEN",
      "telegramBotToken",
      "password",
      "authorization",
      "Authorization",
    ],
    censor: "[redacted]",
  },
  serializers: {
    err(error: unknown): { type: string; code: string } {
      return {
        type: error instanceof Error ? error.name : "unknown",
        code: errorCode(error),
      };
    },
  },
});

/** Единственное чтение process.env. Ошибка — исключение, процесс завершает точка входа. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(pickEnv(env));
  if (!parsed.success) {
    throw new ConfigError(fieldNames(parsed.error.issues));
  }

  const data = parsed.data;
  return {
    databaseUrl: data.DATABASE_URL,
    harnessTestDatabaseUrl: data.HARNESS_TEST_DATABASE_URL ?? null,
    litellmBaseUrl: data.LITELLM_BASE_URL,
    litellmApiKey: data.LITELLM_API_KEY,
    harnessApiToken: data.HARNESS_API_TOKEN,
    telegramBotToken: data.TELEGRAM_BOT_TOKEN,
    telegramAllowedUserIds: parseIdList(data.TELEGRAM_ALLOWED_USER_IDS),
    agentSlug: data.AGENT_SLUG,
    fileRoot: data.FILE_ROOT,
    workerId: data.WORKER_ID ?? hostname(),
    leaseSeconds: data.LEASE_SECONDS,
    heartbeatSeconds: data.HEARTBEAT_SECONDS,
    harnessLiveModel: data.HARNESS_LIVE_MODEL ?? null,
    servicesManifestPath: data.SERVICES_MANIFEST ?? null,
    servicesManifestSha256: data.SERVICES_MANIFEST_SHA256 ?? null,
  };
}

export interface ServiceManifestLoad {
  manifest: ServicesManifest;
  secretsByEnv: ReadonlyMap<string, string>;
  redactSecrets: readonly string[];
}

/**
 * Пустой путь не включает HTTP. Битый файл или сумма останавливают процесс до захвата.
 * src/services само окружение не читает: секрет по имени забирается здесь.
 */
export async function readServiceManifest(config: Config): Promise<ServiceManifestLoad | null> {
  return readServiceManifestFrom(config, process.env);
}

async function readServiceManifestFrom(
  config: Config,
  env: NodeJS.ProcessEnv,
): Promise<ServiceManifestLoad | null> {
  if (config.servicesManifestPath === null && config.servicesManifestSha256 === null) {
    return null;
  }
  if (config.servicesManifestPath === null || config.servicesManifestSha256 === null) {
    throw new ConfigError(["SERVICES_MANIFEST"]);
  }
  let raw: string;
  try {
    // Путь манифеста задаёт оператор в конфигурации, не модель.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- путь из конфига процесса
    raw = await readFile(config.servicesManifestPath, "utf8");
  } catch {
    throw new ConfigError(["SERVICES_MANIFEST"]);
  }
  const actual = createHash("sha256").update(raw, "utf8").digest();
  const expected = Buffer.from(config.servicesManifestSha256, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ConfigError(["SERVICES_MANIFEST_SHA256"]);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    throw new ConfigError(["SERVICES_MANIFEST"]);
  }
  const parsed = parseServicesManifest(parsedJson);
  if (!parsed.ok) {
    throw new ConfigError(["SERVICES_MANIFEST"]);
  }
  const secretsByEnv = new Map<string, string>();
  const redactSecrets: string[] = [];
  for (const service of parsed.value.services) {
    if (service.auth.type !== "bearer") {
      continue;
    }
    const value = env[service.auth.env];
    if (typeof value !== "string" || value.length === 0) {
      throw new ConfigError([service.auth.env]);
    }
    secretsByEnv.set(service.auth.env, value);
    redactSecrets.push(value);
  }
  logger.info({ services: parsed.value.services.length }, "service manifest loaded");
  return { manifest: parsed.value, secretsByEnv, redactSecrets };
}

export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && code.length > 0 && code.length <= 64) {
      return code;
    }
  }
  return "unknown";
}

export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return path.resolve(entry) === fileURLToPath(moduleUrl);
}

function pickEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const raw: Record<string, string> = Object.create(null) as Record<string, string>;
  const databaseUrl = trimmed(env.DATABASE_URL);
  if (databaseUrl !== undefined) {
    raw.DATABASE_URL = databaseUrl;
  }
  const testDatabaseUrl = trimmed(env.HARNESS_TEST_DATABASE_URL);
  if (testDatabaseUrl !== undefined) {
    raw.HARNESS_TEST_DATABASE_URL = testDatabaseUrl;
  }
  const litellmBaseUrl = trimmed(env.LITELLM_BASE_URL);
  if (litellmBaseUrl !== undefined) {
    raw.LITELLM_BASE_URL = litellmBaseUrl;
  }
  if (env.LITELLM_API_KEY !== undefined) {
    raw.LITELLM_API_KEY = env.LITELLM_API_KEY;
  }
  if (env.HARNESS_API_TOKEN !== undefined) {
    raw.HARNESS_API_TOKEN = env.HARNESS_API_TOKEN;
  }
  if (env.TELEGRAM_BOT_TOKEN !== undefined) {
    raw.TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  }
  if (env.TELEGRAM_ALLOWED_USER_IDS !== undefined) {
    raw.TELEGRAM_ALLOWED_USER_IDS = env.TELEGRAM_ALLOWED_USER_IDS;
  }
  const agentSlug = trimmed(env.AGENT_SLUG);
  if (agentSlug !== undefined) {
    raw.AGENT_SLUG = agentSlug;
  }
  const fileRoot = trimmed(env.FILE_ROOT);
  if (fileRoot !== undefined) {
    raw.FILE_ROOT = fileRoot;
  }
  const workerId = trimmed(env.WORKER_ID);
  if (workerId !== undefined) {
    raw.WORKER_ID = workerId;
  }
  const leaseSeconds = trimmed(env.LEASE_SECONDS);
  if (leaseSeconds !== undefined) {
    raw.LEASE_SECONDS = leaseSeconds;
  }
  const heartbeatSeconds = trimmed(env.HEARTBEAT_SECONDS);
  if (heartbeatSeconds !== undefined) {
    raw.HEARTBEAT_SECONDS = heartbeatSeconds;
  }
  const liveModel = trimmed(env.HARNESS_LIVE_MODEL);
  if (liveModel !== undefined) {
    raw.HARNESS_LIVE_MODEL = liveModel;
  }
  const manifest = trimmed(env.SERVICES_MANIFEST);
  if (manifest !== undefined) {
    raw.SERVICES_MANIFEST = manifest;
  }
  const manifestSha = trimmed(env.SERVICES_MANIFEST_SHA256);
  if (manifestSha !== undefined) {
    raw.SERVICES_MANIFEST_SHA256 = manifestSha;
  }
  return raw;
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const next = value.trim();
  return next === "" ? undefined : next;
}

function parseIdList(value: string): readonly string[] {
  const ids: string[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      ids.push(trimmed);
    }
  }
  return ids;
}

function fieldNames(issues: readonly { path: readonly PropertyKey[] }[]): string[] {
  const fields: string[] = [];
  for (const issue of issues) {
    const parts: string[] = [];
    for (const part of issue.path) {
      parts.push(typeof part === "symbol" ? "invalid" : String(part));
    }
    const name = parts.length > 0 ? parts.join(".") : "config";
    if (!fields.includes(name)) {
      fields.push(name);
    }
  }
  return fields.length > 0 ? fields : ["config"];
}
