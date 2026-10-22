import { loadPhotonConfig } from "./config.ts";
import { stdoutLog } from "./log.ts";
import { run } from "./main.ts";
import { spectrumChannel } from "./spectrum.ts";

const tether = await run(process.env, (env, log) => spectrumChannel(loadPhotonConfig(env), log), stdoutLog);
let stopped: Promise<void> | undefined;
const stop = () => void (stopped ??= tether.stop());
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
await tether.done;
await stopped;
process.exit(0);
