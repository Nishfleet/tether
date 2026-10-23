import { DEFAULT_TIME_ZONE, isTimeZone } from "../clock.ts";
import { connectGoogle } from "./google.ts";
import { connectIcloud } from "./icloud.ts";
import { DEFAULT_ENV_FILE } from "./env-file.ts";
import { terminalAsk } from "./prompt.ts";

const target = process.argv[2];
if (target !== "google" && target !== "icloud") {
  process.stderr.write("usage: node setup/cli.js google|icloud\n");
  process.exit(2);
}

const { ask, close } = terminalAsk();
const setup = {
  ask,
  print: (line: string) => process.stdout.write(`${line}\n`),
  envFile: process.env.TETHER_CALENDAR_ENV?.trim() || DEFAULT_ENV_FILE,
  timezone: process.env.TETHER_TIMEZONE?.trim() || DEFAULT_TIME_ZONE,
};
if (!isTimeZone(setup.timezone)) {
  process.stderr.write("invalid environment: TETHER_TIMEZONE\n");
  process.exit(2);
}
try {
  await (target === "google" ? connectGoogle(setup) : connectIcloud(setup));
} catch (error) {
  process.stderr.write(`setup failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
} finally {
  close();
}
