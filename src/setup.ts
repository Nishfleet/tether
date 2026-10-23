import { DEFAULT_TIMEZONE } from "./calendar/config.ts";
import { connectGoogle } from "./setup/google.ts";
import { connectIcloud } from "./setup/icloud.ts";
import { DEFAULT_ENV_FILE } from "./setup/env-file.ts";
import { terminalAsk } from "./setup/prompt.ts";

const target = process.argv[2];
if (target !== "google" && target !== "icloud") {
  process.stderr.write("usage: node setup.js google|icloud\n");
  process.exit(2);
}

const { ask, close } = terminalAsk();
const setup = {
  ask,
  print: (line: string) => process.stdout.write(`${line}\n`),
  envFile: process.env.TETHER_CALENDAR_ENV?.trim() || DEFAULT_ENV_FILE,
  timezone: process.env.TETHER_TIMEZONE?.trim() || DEFAULT_TIMEZONE,
};
try {
  await (target === "google" ? connectGoogle(setup) : connectIcloud(setup));
} catch (error) {
  process.stderr.write(`setup failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
} finally {
  close();
}
