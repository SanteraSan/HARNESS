import { DENIED_TOOL_NAMES } from "../contracts/tool-policy.js";
import type { ModelToolSpec } from "../contracts/types.js";
import type { Sql } from "../db/client.js";
import { selectToolsForModel, type ListedTool } from "../../contract/select.js";
import type { ServiceEntry, ServicesManifest, ServiceTool } from "../../contract/manifest.js";
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
}

export function createServiceCatalog(options: {
  sql: Sql;
  manifest: ServicesManifest;
  secretsByEnv: ReadonlyMap<string, string>;
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
    execute(input): Promise<ServiceCallOutcome> {
      const binding = findBinding(options.manifest, input.name);
      if (binding === undefined) {
        return Promise.resolve({
          lockLost: false,
          text: "invalid arguments",
          error: "invalid arguments",
          requestExcerpt: input.name,
        });
      }
      const secret = secretFor(binding.service, options.secretsByEnv);
      return executeServiceCall({
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
        secrets: options.redactSecrets,
        timeoutMs: input.timeoutMs,
        retryDelayMs: input.retryDelayMs,
      });
    },
  };
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

function secretFor(service: ServiceEntry, secretsByEnv: ReadonlyMap<string, string>): string | null {
  if (service.auth.type === "none") {
    return null;
  }
  return secretsByEnv.get(service.auth.env) ?? null;
}
