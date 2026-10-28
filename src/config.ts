import { join } from "node:path";
import { DEFAULT_TIME_ZONE, isTimeZone } from "./clock.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export type ComputerConfig = {
  readonly url: string;
  readonly token: string;
  readonly home: string;
};

export type TincanConfig = {
  readonly bin: string;
  readonly config: string;
};

export type Config = {
  readonly allowedSender: string;
  readonly llmBaseUrl: string;
  readonly llmApiKey: string;
  readonly modelGroup: string;
  readonly stateDir: string;
  readonly timeZone: string;
  readonly computer: ComputerConfig | undefined;
  readonly searchApiKey: string | undefined;
  readonly tincan: TincanConfig | undefined;
};

export type PhotonConfig = {
  readonly projectId: string;
  readonly projectSecret: string;
};

export const DEFAULT_LLM_BASE_URL = "http://127.0.0.1:4000";
export const DEFAULT_MODEL_GROUP = "tether";

const SPACE_URL = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/;

function spaceUrl(value: string): string {
  const port = SPACE_URL.exec(value)?.[1];
  if (port !== undefined && Number(port) >= 1 && Number(port) <= 65535) return value;
  throw new Error("invalid environment: TETHER_SPACE_URL must be http://127.0.0.1:<port>");
}

export function loadComputerConfig(env: Env, stateDir: string): ComputerConfig | undefined {
  const url = env.TETHER_SPACE_URL?.trim() ?? "";
  const token = env.TETHER_SPACE_TOKEN?.trim() ?? "";
  if (!url || !token) return undefined;
  return { url: spaceUrl(url), token, home: join(stateDir, "cua") };
}

export function loadTincanConfig(env: Env): TincanConfig | undefined {
  const bin = env.TETHER_TINCAN_BIN?.trim() ?? "";
  const config = env.TETHER_TINCAN_CONFIG?.trim() ?? "";
  if (!bin || !config) return undefined;
  return { bin, config };
}

function required(env: Env, names: readonly string[]): Record<string, string> {
  const found: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) found[name] = value;
    else missing.push(name);
  }
  if (missing.length > 0) throw new Error(`missing environment: ${missing.join(", ")}`);
  return found;
}

export function loadConfig(env: Env): Config {
  const { TETHER_ALLOWED_SENDER, TETHER_LLM_API_KEY } = required(env, ["TETHER_ALLOWED_SENDER", "TETHER_LLM_API_KEY"]);
  const stateDir = env.TETHER_STATE_DIR?.trim() || env.STATE_DIRECTORY?.trim();
  if (!stateDir) throw new Error("missing environment: TETHER_STATE_DIR or STATE_DIRECTORY");
  const timeZone = env.TETHER_TIMEZONE?.trim() || DEFAULT_TIME_ZONE;
  if (!isTimeZone(timeZone)) throw new Error("invalid environment: TETHER_TIMEZONE");
  return {
    allowedSender: TETHER_ALLOWED_SENDER as string,
    llmApiKey: TETHER_LLM_API_KEY as string,
    modelGroup: env.TETHER_MODEL_GROUP?.trim() || DEFAULT_MODEL_GROUP,
    llmBaseUrl: env.TETHER_LLM_BASE_URL?.trim() || DEFAULT_LLM_BASE_URL,
    stateDir,
    timeZone,
    computer: loadComputerConfig(env, stateDir),
    searchApiKey: env.TETHER_SEARCH_API_KEY?.trim() || undefined,
    tincan: loadTincanConfig(env),
  };
}

export function loadPhotonConfig(env: Env): PhotonConfig {
  const { PHOTON_PROJECT_ID, PHOTON_PROJECT_SECRET } = required(env, ["PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]);
  return { projectId: PHOTON_PROJECT_ID as string, projectSecret: PHOTON_PROJECT_SECRET as string };
}
