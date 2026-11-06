import type { Provider } from "../contracts/types.js";

export interface ResolvedModel {
  modelAlias: string;
  provider: Provider;
}

/** M1 не переключает алиас: возвращаются поля строки агента. */
export function resolveModel(agent: { modelAlias: string; provider: Provider }): ResolvedModel {
  return {
    modelAlias: agent.modelAlias,
    provider: agent.provider,
  };
}
