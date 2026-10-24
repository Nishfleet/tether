import { createModels, createProvider, type Model, type Models } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ModelRef } from "@earendil-works/pi-durable";
import { DEFAULT_MODEL_GROUP } from "./config.ts";

const PROVIDER_ID = "router";

export function routerBaseUrl(base: string): string {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path.endsWith("/v1") ? path : `${path}/v1`}`;
}

export const DEFAULT_CONTEXT_WINDOW = 128000;
export const MAX_OUTPUT_TOKENS = 16384;

export function createModelAccess(options: { baseUrl: string; apiKey: string; group?: string; contextWindow?: number }): { models: Models; ref: ModelRef } {
  const baseUrl = routerBaseUrl(options.baseUrl);
  const group = options.group ?? DEFAULT_MODEL_GROUP;
  const model: Model<"openai-completions"> = {
    id: group,
    name: `LiteLLM ${group} group`,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
    },
  };
  const provider = createProvider({
    id: PROVIDER_ID,
    name: "LiteLLM router",
    baseUrl,
    auth: {
      apiKey: {
        name: "Tether router key",
        resolve: async () => ({ auth: { apiKey: options.apiKey }, source: "TETHER_LLM_API_KEY" }),
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, ref: { provider: PROVIDER_ID, modelId: group } };
}
