import { createInterface } from "node:readline";
import type { Channel, Inbound } from "../../src/channel.ts";
import { run } from "../../src/main.ts";

const hangSend = process.env.TEST_HANG_SEND === "1";
const pending: Inbound[] = [];
let wake: (() => void) | undefined;
let ended = false;

createInterface({ input: process.stdin }).on("line", (line) => {
  pending.push(JSON.parse(line) as Inbound);
  wake?.();
});

const channel: Channel = {
  async *messages() {
    while (true) {
      const next = pending.shift();
      if (next) {
        yield next;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  },
  send: async (space, text) => {
    if (hangSend) {
      process.stdout.write(`${JSON.stringify({ sending: text })}\n`);
      return new Promise<void>(() => undefined);
    }
    process.stdout.write(`${JSON.stringify({ sent: { space, text } })}\n`);
  },
  stop: async () => {
    ended = true;
    process.stdin.destroy();
    wake?.();
  },
};

const log = (event: string, fields?: Record<string, unknown>) => process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
const tether = await run(process.env, async (_env, _log) => channel, log, { retryBaseMs: 5 });
process.once("SIGTERM", () => void tether.stop());
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
await tether.done;
