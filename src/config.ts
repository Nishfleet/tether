import { join } from "node:path";
import { DEFAULT_TIME_ZONE, isTimeZone } from "./clock.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export type ComputerConfig = {
  readonly cuaHome: string;
  readonly spaceName: string;
  readonly hostRef: string;
  readonly macRef: string;
  readonly jobSlots: number;
};

export type Config = {
  readonly allowedSender: string;
  readonly llmBaseUrl: string;
  readonly llmApiKey: string;
  readonly modelGroup: string;
  readonly stateDir: string;
  readonly timeZone: string;
  readonly computer: ComputerConfig | undefined;
};

export type PhotonConfig = {
  readonly projectId: string;
  readonly projectSecret: string;
};

export const DEFAULT_LLM_BASE_URL = "http://127.0.0.1:4000";
export const DEFAULT_MODEL_GROUP = "tether";
export const DEFAULT_SPACE_NAME = "tether";
export const DEFAULT_JOB_SLOTS = 2;
export const MAX_JOB_SLOTS = 4;

function jobSlots(value: string | undefined): number {
  const text = value?.trim();
  if (!text) return DEFAULT_JOB_SLOTS;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_JOB_SLOTS) throw new Error(`TETHER_CUA_JOB_SLOTS must be a whole number from 0 to ${MAX_JOB_SLOTS}`);
  return parsed;
}

export function loadComputerConfig(env: Env, stateDir: string): ComputerConfig | undefined {
  const hostRef = env.TETHER_CUA_HOST?.trim() ?? "";
  const macRef = env.TETHER_CUA_MAC?.trim() ?? "";
  if (!hostRef && !macRef) return undefined;
  return {
    cuaHome: env.TETHER_CUA_HOME?.trim() || join(stateDir, "cua"),
    spaceName: env.TETHER_CUA_SPACE?.trim() || DEFAULT_SPACE_NAME,
    hostRef,
    macRef,
    jobSlots: jobSlots(env.TETHER_CUA_JOB_SLOTS),
  };
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
  };
}

export function loadPhotonConfig(env: Env): PhotonConfig {
  const { PHOTON_PROJECT_ID, PHOTON_PROJECT_SECRET } = required(env, ["PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]);
  return { projectId: PHOTON_PROJECT_ID as string, projectSecret: PHOTON_PROJECT_SECRET as string };
}
