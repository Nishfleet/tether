import { readFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  console.log(manifest.version);
  process.exit(0);
}

const { loadPhotonConfig } = await import("./config.ts");
const { stdoutLog } = await import("./log.ts");
const { run } = await import("./main.ts");
const { spectrumChannel } = await import("./spectrum.ts");

const tether = await run(process.env, (env, log) => spectrumChannel(loadPhotonConfig(env), log), stdoutLog);
let stopped: Promise<void> | undefined;
const stop = () => void (stopped ??= tether.stop());
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
await tether.done;
await stopped;
process.exit(0);
