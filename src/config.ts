import { isAbsolute } from "node:path";
import { DEFAULT_TIME_ZONE, isTimeZone } from "./clock.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export type ComputerConfig = {
  readonly url: string;
  readonly token: string;
  readonly spaceName: string;
  readonly hostRef: string;
  readonly jobSlots: number;
  readonly hostSlots: number;
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
export const JOB_PREFIX = "tether-job-";
export const DEFAULT_JOB_SLOTS = 2;
export const MAX_JOB_SLOTS = 4;
export const DEFAULT_HOST_SLOTS = 4;
export const MAX_HOST_SLOTS = 64;

function slots(env: Env, name: string, fallback: number, max: number): number {
  const text = env[name]?.trim();
  if (!text) return fallback;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) throw new Error(`invalid environment: ${name} must be a whole number from 0 to ${max}`);
  return parsed;
}

function daemonAddress(value: string): string {
  if (isAbsolute(value)) return value;
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return value;
  } catch {}
  throw new Error("invalid environment: TETHER_CUA_URL must be an absolute socket path or an http(s) loopback URL");
}

export function loadComputerConfig(env: Env): ComputerConfig | undefined {
  const url = env.TETHER_CUA_URL?.trim() ?? "";
  if (!url) return undefined;
  const spaceName = env.TETHER_CUA_SPACE?.trim() || DEFAULT_SPACE_NAME;
  if (spaceName.startsWith(JOB_PREFIX)) throw new Error(`invalid environment: TETHER_CUA_SPACE must not start with ${JOB_PREFIX}`);
  return {
    url: daemonAddress(url),
    token: env.TETHER_CUA_TOKEN?.trim() ?? "",
    spaceName,
    hostRef: env.TETHER_CUA_HOST?.trim() ?? "",
    jobSlots: slots(env, "TETHER_CUA_JOB_SLOTS", DEFAULT_JOB_SLOTS, MAX_JOB_SLOTS),
    hostSlots: slots(env, "TETHER_CUA_HOST_SLOTS", DEFAULT_HOST_SLOTS, MAX_HOST_SLOTS),
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
    computer: loadComputerConfig(env),
  };
}

export function loadPhotonConfig(env: Env): PhotonConfig {
  const { PHOTON_PROJECT_ID, PHOTON_PROJECT_SECRET } = required(env, ["PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]);
  return { projectId: PHOTON_PROJECT_ID as string, projectSecret: PHOTON_PROJECT_SECRET as string };
}
