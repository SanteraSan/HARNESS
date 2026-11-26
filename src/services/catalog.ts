import { DENIED_TOOL_NAMES } from "../contracts/tool-policy.js";
import type { ModelToolSpec } from "../contracts/types.js";
import type { Sql } from "../db/client.js";
import { selectToolsForModel, type ListedTool } from "../../contract/select.js";
import type { ServiceEntry, ServicesManifest, ServiceTool } from "../../contract/manifest.js";
import type { SecretVault } from "../secrets/index.js";
import { executeServiceCall, type ServiceCallOutcome } from "./call.js";

export interface ServiceCatalog {
  has(name: string): boolean;
  modelTools(allowlist: readonly string[]): ModelToolSpec[];
  execute(input: {
    runId: string;
    tenantId: string;
    agentId: string;
    workerId: string;
    toolCallId: string;
    name: string;
    args: unknown;
    timeoutMs?: number;
    retryDelayMs?: number;
  }): Promise<ServiceCallOutcome>;
  /** Эффект из манифеста. Нет метода — раннер берёт эффект локального инструмента. */
  effect?(name: string): ServiceTool["effect"] | undefined;
}

export function createServiceCatalog(options: {
  sql: Sql;
  manifest: ServicesManifest;
  /** null — в манифесте нет bearer. Вызов с bearer тогда сеть не открывает. */
  vault: SecretVault | null;
  redactSecrets: readonly string[];
}): ServiceCatalog {
  return {
    has(name: string): boolean {
      return findBinding(options.manifest, name) !== undefined;
    },
    modelTools(allowlist: readonly string[]): ModelToolSpec[] {
      const listed: ListedTool[] = [];
      for (const service of options.manifest.services) {
        for (const tool of service.tools) {
          listed.push({
            name: tool.name,
            description: tool.description,
            effect: tool.effect,
            parameters: tool.parameters,
          });
        }
      }
      return selectToolsForModel(listed, allowlist, DENIED_TOOL_NAMES).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    },
    effect(name: string): ServiceTool["effect"] | undefined {
      return findBinding(options.manifest, name)?.tool.effect;
    },
    execute(input): Promise<ServiceCallOutcome> {
      const binding = findBinding(options.manifest, input.name);
      if (binding === undefined) {
        return Promise.resolve(invalid(input.name));
      }
      if (binding.service.auth.type === "none") {
        return executeServiceCall(callInput(options, input, binding, null, options.redactSecrets));
      }
      return deliverBearer(options, input, binding);
    },
  };
}

/**
 * Bearer только из сейфа: secretName — auth.env, агент запуска, отдел null.
 * Нет связи — обратный вызов не идёт, fetch нет. Значение возвращается строкой delivered.
 */
async function deliverBearer(
  options: {
    sql: Sql;
    manifest: ServicesManifest;
    vault: SecretVault | null;
    redactSecrets: readonly string[];
  },
  input: {
    runId: string;
    tenantId: string;
    agentId: string;
    workerId: string;
    toolCallId: string;
    name: string;
    args: unknown;
    timeoutMs?: number;
    retryDelayMs?: number;
  },
  binding: { service: ServiceEntry; tool: ServiceTool },
): Promise<ServiceCallOutcome> {
  const vault = options.vault;
  if (vault === null || binding.service.auth.type !== "bearer") {
    return unavailable(input.name);
  }
  const held: { current: ServiceCallOutcome | null } = { current: null };
  const use = await vault.deliver(
    {
      tenantId: input.tenantId,
      secretName: binding.service.auth.env,
      agentId: input.agentId,
      department: null,
      runId: input.runId,
      toolName: input.name,
    },
    async (secret) => {
      held.current = await executeServiceCall(
        callInput(options, input, binding, secret, redactList(options.redactSecrets, secret)),
      );
      return "delivered";
    },
  );
  if (!use.received || held.current === null) {
    return unavailable(input.name);
  }
  return held.current;
}

function findBinding(
  manifest: ServicesManifest,
  name: string,
): { service: ServiceEntry; tool: ServiceTool } | undefined {
  for (const service of manifest.services) {
    for (const tool of service.tools) {
      if (tool.name === name) {
        return { service, tool };
      }
    }
  }
  return undefined;
}

type CatalogOptions = {
  sql: Sql;
  manifest: ServicesManifest;
  vault: SecretVault | null;
  redactSecrets: readonly string[];
};

type ExecuteInput = {
  runId: string;
  tenantId: string;
  agentId: string;
  workerId: string;
  toolCallId: string;
  name: string;
  args: unknown;
  timeoutMs?: number;
  retryDelayMs?: number;
};

function callInput(
  options: CatalogOptions,
  input: ExecuteInput,
  binding: { service: ServiceEntry; tool: ServiceTool },
  secret: string | null,
  secrets: readonly string[],
): Parameters<typeof executeServiceCall>[0] {
  return {
    sql: options.sql,
    workerId: input.workerId,
    runId: input.runId,
    tenantId: input.tenantId,
    agentId: input.agentId,
    toolCallId: input.toolCallId,
    service: binding.service,
    tool: binding.tool,
    args: input.args,
    secret,
    secrets,
    timeoutMs: input.timeoutMs,
    retryDelayMs: input.retryDelayMs,
  };
}

function redactList(base: readonly string[], secret: string): string[] {
  const list = [...base];
  if (!list.includes(secret)) {
    list.push(secret);
  }
  return list;
}

function invalid(name: string): ServiceCallOutcome {
  return {
    lockLost: false,
    text: "invalid arguments",
    error: "invalid arguments",
    requestExcerpt: name,
  };
}

function unavailable(name: string): ServiceCallOutcome {
  return {
    lockLost: false,
    text: "secret is not available",
    error: "secret is not available",
    requestExcerpt: name,
  };
}
