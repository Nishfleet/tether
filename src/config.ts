export type Env = Readonly<Record<string, string | undefined>>;

export type Config = {
  readonly allowedSender: string;
  readonly llmBaseUrl: string;
  readonly llmApiKey: string;
  readonly modelGroup: string;
  readonly stateDir: string;
};

export type PhotonConfig = {
  readonly projectId: string;
  readonly projectSecret: string;
};

export const DEFAULT_LLM_BASE_URL = "http://127.0.0.1:4000";
export const DEFAULT_MODEL_GROUP = "tether";

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
  return {
    allowedSender: TETHER_ALLOWED_SENDER as string,
    llmApiKey: TETHER_LLM_API_KEY as string,
    modelGroup: env.TETHER_MODEL_GROUP?.trim() || DEFAULT_MODEL_GROUP,
    llmBaseUrl: env.TETHER_LLM_BASE_URL?.trim() || DEFAULT_LLM_BASE_URL,
    stateDir,
  };
}

export function loadPhotonConfig(env: Env): PhotonConfig {
  const { PHOTON_PROJECT_ID, PHOTON_PROJECT_SECRET } = required(env, ["PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"]);
  return { projectId: PHOTON_PROJECT_ID as string, projectSecret: PHOTON_PROJECT_SECRET as string };
}
