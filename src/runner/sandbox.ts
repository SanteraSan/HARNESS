import { DENIED_TOOL_NAMES, filterToolNames } from "../contracts/tool-policy.js";

/**
 * Политика контейнера одного запуска. Решение принимается здесь и наружу
 * не выходит: домашний каталог пользователя не читается, сокет не открывается.
 * В выдачу SDK попадают только имена, которые пропустил запрет M1.
 * Встроенные инструменты этого запрета в выдачу не входят.
 */

const MAX_URL_LENGTH = 2048;

export type SandboxPolicyErrorCode = "invalid_gateway" | "invalid_mcp" | "invalid_tools";

export class SandboxPolicyError extends Error {
  readonly code: SandboxPolicyErrorCode;

  constructor(code: SandboxPolicyErrorCode) {
    super(code);
    this.name = "SandboxPolicyError";
    this.code = code;
  }
}

export interface SandboxPolicyInput {
  /** Origin или URL шлюза модели. В список сети попадает только origin. */
  modelGateway: string;
  /** Явно перечисленные MCP. Пустой список не открывает другие хосты. */
  mcpOrigins: readonly string[];
  /** Имена, которые просят включить в политику SDK. Запрет M1 их вырезает. */
  requestedTools?: readonly string[];
}

export interface SandboxPolicy {
  /** Домашнего каталога пользователя у процесса запуска нет. */
  readonly homeDirectory: null;
  /** Origin шлюза модели и явно перечисленных MCP. */
  readonly networkOrigins: readonly string[];
  /** Имена для политики SDK. Имён запрета M1 здесь нет. */
  readonly allowedTools: readonly string[];
  /** Тот же массив, что `DENIED_TOOL_NAMES`. Второй список здесь не заводится. */
  readonly disallowedTools: typeof DENIED_TOOL_NAMES;
}

export interface NetworkEffect {
  call(target: string): void;
}

export type NetworkDecision =
  { readonly admitted: true } | { readonly admitted: false; readonly reason: "network_denied" };

export function buildSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  if (!Array.isArray(input.mcpOrigins)) {
    throw new SandboxPolicyError("invalid_mcp");
  }
  if (input.requestedTools !== undefined && !Array.isArray(input.requestedTools)) {
    throw new SandboxPolicyError("invalid_tools");
  }

  const networkOrigins = uniqueOrigins(
    requireOrigin(input.modelGateway, "invalid_gateway"),
    input.mcpOrigins,
  );
  const requested = input.requestedTools ?? [];

  return Object.freeze({
    homeDirectory: null,
    networkOrigins: Object.freeze(networkOrigins),
    allowedTools: Object.freeze(filterToolNames(requested)),
    disallowedTools: DENIED_TOOL_NAMES,
  });
}

/**
 * Цель вне шлюза и перечисленного MCP отклоняется до `effect.call`.
 * Сам модуль сеть не открывает: вызов делает только переданный effect.
 */
export function admitNetworkTarget(
  policy: SandboxPolicy,
  target: string,
  effect: NetworkEffect,
): NetworkDecision {
  const parsed = parseHttp(target);
  if (parsed === null || !originListed(policy.networkOrigins, parsed.origin)) {
    return { admitted: false, reason: "network_denied" };
  }
  // Сырое написание не отдаём: десятичный и шестнадцатеричный адрес
  // разбираются в тот же origin, а effect должен получить уже его.
  effect.call(parsed.href);
  return { admitted: true };
}

function uniqueOrigins(gateway: string, mcpOrigins: readonly string[]): string[] {
  const seen = new Set<string>();
  const origins: string[] = [];
  appendOrigin(origins, seen, gateway);
  for (const entry of mcpOrigins) {
    appendOrigin(origins, seen, requireOrigin(entry, "invalid_mcp"));
  }
  return origins;
}

function appendOrigin(origins: string[], seen: Set<string>, origin: string): void {
  if (seen.has(origin)) {
    return;
  }
  seen.add(origin);
  origins.push(origin);
}

function requireOrigin(value: string, code: SandboxPolicyErrorCode): string {
  const parsed = parseHttp(value);
  if (parsed === null) {
    throw new SandboxPolicyError(code);
  }
  return parsed.origin;
}

function originListed(origins: readonly string[], origin: string): boolean {
  for (const allowed of origins) {
    if (allowed === origin) {
      return true;
    }
  }
  return false;
}

interface HttpTarget {
  origin: string;
  href: string;
}

/**
 * Сравнение origin, не префикса строки: порт и хост не угадываются по началу URL.
 * `@` и `\` отсекаются до разбора: userinfo и обратная косая обходят наивный префикс.
 * Кривой URL становится отказом. Текст исключения наружу не отдаётся: в нём может быть адрес.
 */
function parseHttp(value: string): HttpTarget | null {
  if (typeof value !== "string" || hasForbiddenUrlChar(value)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  if (url.username !== "" || url.password !== "") {
    return null;
  }
  if (url.host.length === 0 || url.origin === "null") {
    return null;
  }
  return { origin: url.origin, href: url.href };
}

function hasForbiddenUrlChar(value: string): boolean {
  if (value.length < 1 || value.length > MAX_URL_LENGTH) {
    return true;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 64 || code === 92 || code === 127) {
      return true;
    }
  }
  return false;
}
