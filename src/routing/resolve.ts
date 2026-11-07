import type { Provider, ToolEffect } from "../contracts/types.js";
import type { Sql } from "../db/client.js";

export interface ResolvedModel {
  modelAlias: string;
  provider: Provider;
}

/** Поля агента, по которым выбирается алиас. Строка agents здесь не перечитывается. */
export interface ResolveModelAgent {
  id: string;
  tenantId: string;
  modelAlias: string;
  provider: Provider;
}

/** Эффекты инструментов, уже вызванных в этом запуске. Пустой список — ход чтения. */
export interface ResolveModelContext {
  toolEffects: readonly ToolEffect[];
}

const WRITE_KIND = "write_tool";
const PARSE_KIND = "second_parse_error";

interface RuleRow {
  kind: string;
  model_alias: string;
  provider: string;
}

export class RoutingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RoutingError";
    this.code = code;
  }
}

/**
 * Алиас агента, пока нет причины из route_rules.
 * write в уже случившемся вызове и второй parse_error за сутки (now() сервера)
 * берут внешний алиас из правила. Имя алиаса в коде не зашито.
 */
export async function resolveModel(
  sql: Sql,
  agent: ResolveModelAgent,
  context: ResolveModelContext,
): Promise<ResolvedModel> {
  const rules = await loadRules(sql, agent);
  const parseErrors = await countRecentParseErrors(sql, agent);
  return chooseAlias(agent, context.toolEffects, parseErrors, rules);
}

function chooseAlias(
  agent: ResolveModelAgent,
  toolEffects: readonly ToolEffect[],
  parseErrors: number,
  rules: readonly RuleRow[],
): ResolvedModel {
  if (toolEffects.includes("write")) {
    const writeRule = ruleFor(rules, WRITE_KIND);
    if (writeRule !== null) {
      return writeRule;
    }
  }

  // Уже есть хотя бы один parse_error за сутки: этот запуск — второй или следующий.
  if (parseErrors >= 1) {
    const parseRule = ruleFor(rules, PARSE_KIND);
    if (parseRule !== null) {
      return parseRule;
    }
  }

  return {
    modelAlias: agent.modelAlias,
    provider: agent.provider,
  };
}

function ruleFor(rules: readonly RuleRow[], kind: string): ResolvedModel | null {
  for (const rule of rules) {
    if (rule.kind !== kind || rule.provider !== "external") {
      continue;
    }
    const modelAlias = rule.model_alias.trim();
    if (modelAlias.length === 0) {
      continue;
    }
    return {
      modelAlias,
      provider: "external",
    };
  }
  return null;
}

async function loadRules(sql: Sql, agent: ResolveModelAgent): Promise<readonly RuleRow[]> {
  const rows = await sql<RuleRow[]>`
    select kind, model_alias, provider
    from route_rules
    where tenant_id = ${agent.tenantId}
      and agent_id = ${agent.id}
    order by id asc
  `;
  return rows;
}

async function countRecentParseErrors(sql: Sql, agent: ResolveModelAgent): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    select count(*)::int as count
    from run_steps as step
    join runs as owned on owned.id = step.run_id
    where owned.agent_id = ${agent.id}
      and owned.tenant_id = ${agent.tenantId}
      and step.kind = 'parse_error'
      and step.created_at >= now() - interval '1 day'
  `;
  const count = rows[0]?.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new RoutingError("parse_error_count", "parse error count is invalid");
  }
  return count;
}
