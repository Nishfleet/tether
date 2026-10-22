import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { startTether, type Tether } from "./app.ts";
import type { Channel } from "./channel.ts";
import { type Env, loadConfig } from "./config.ts";
import type { Log } from "./log.ts";
import { createModelAccess } from "./model.ts";

export const DATABASE_FILE = "tether.sqlite";

export async function run(
  env: Env,
  openChannel: (env: Env) => Promise<Channel>,
  log: Log,
  overrides: { retryBaseMs?: number } = {},
): Promise<Tether> {
  const config = loadConfig(env);
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const storage = await openNodeSqliteStorage(join(config.stateDir, DATABASE_FILE));
  const { models, ref } = createModelAccess({ baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey });
  const channel = await openChannel(env);
  return startTether({
    channel,
    models,
    model: ref,
    storage,
    allowedSender: config.allowedSender,
    log,
    ...(overrides.retryBaseMs === undefined ? {} : { retryBaseMs: overrides.retryBaseMs }),
  });
}
