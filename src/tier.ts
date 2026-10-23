export type Tier = "primary" | "fallback";

export const PRIMARY_MODEL = /claude|anthropic/i;
export const ROUTER_DIAGNOSTIC = "router_response";
export const DEPLOYMENT_HEADER = "x-litellm-model-id";
export const FALLBACKS_HEADER = "x-litellm-attempted-fallbacks";
export const ROUTER_HEADERS: readonly string[] = [DEPLOYMENT_HEADER, FALLBACKS_HEADER];

export const DEFAULT_REASON = "Claude didn't answer";
export const BACK_TEXT = "Back on Claude.";

export type Served = {
  readonly model: string | undefined;
  readonly deployment: string | undefined;
  readonly fallbacks: string | undefined;
};

export const classifyTier = (model: string | undefined): Tier => (model !== undefined && PRIMARY_MODEL.test(model) ? "primary" : "fallback");

export const fallbackText = (reason: string): string => `Switched to the backup model: ${reason}.`;

export function switchNotice(previous: Tier | null, next: Tier): string | null {
  if (previous === next) return null;
  if (next === "fallback") return fallbackText(DEFAULT_REASON);
  return previous === null ? null : BACK_TEXT;
}
