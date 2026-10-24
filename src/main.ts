import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { startTether, type Tether } from "./app.ts";
import type { AnyGuardedTool } from "./approval.ts";
import { loadCalendarConfig } from "./calendar/config.ts";
import { openCalendar } from "./calendar/index.ts";
import type { Channel } from "./channel.ts";
import { type Computer, createComputer } from "./computer.ts";
import { type Env, loadConfig } from "./config.ts";
import { openEmail } from "./email/index.ts";
import { createFleetTools } from "./fleet.ts";
import type { Log } from "./log.ts";
import { createModelAccess } from "./model.ts";
import { loadSalt } from "./salt.ts";

export const DATABASE_FILE = "tether.sqlite";

export async function run(
  env: Env,
  openChannel: (env: Env, log: Log) => Promise<Channel>,
  log: Log,
  overrides: { retryBaseMs?: number; tools?: readonly AnyGuardedTool[]; computer?: Computer } = {},
): Promise<Tether> {
  const config = loadConfig(env);
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(config.stateDir, 0o700);
  const storage = await openNodeSqliteStorage(join(config.stateDir, DATABASE_FILE));
  const { models, ref } = createModelAccess({ baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, group: config.modelGroup, log });
  const google = loadCalendarConfig(env, config.timeZone);
  const calendar = openCalendar(google);
  log("calendar", { sources: calendar ? calendar.backends.calendar.map((backend) => backend.source).join(",") : "" });
  const email = openEmail(google.google, config.timeZone);
  const channel = await openChannel(env, log);
  const computer = overrides.computer ?? (config.computer ? createComputer(config.computer, log) : undefined);
  const fleet = config.tincan ? createFleetTools(config.tincan, log) : [];
  const tools = [...(computer?.tools ?? []), ...fleet, ...(overrides.tools ?? [])];
  const tether = await startTether({
    channel,
    models,
    model: ref,
    storage,
    allowedSender: config.allowedSender,
    salt: loadSalt(config.stateDir),
    log,
    timeZone: config.timeZone,
    ...(calendar ? { calendar } : {}),
    ...(email ? { email } : {}),
    ...(overrides.retryBaseMs === undefined ? {} : { retryBaseMs: overrides.retryBaseMs }),
    ...(tools.length === 0 ? {} : { tools }),
  });
  void computer?.startup();
  return tether;
}
