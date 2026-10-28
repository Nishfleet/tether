import { createInterface } from "node:readline";
import type { Channel, Inbound } from "../../src/channel.ts";
import { run } from "../../src/main.ts";
import { createTestTools } from "../tools.ts";

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

const log = (event: string, fields?: Record<string, unknown>) => {
  const line = `${JSON.stringify({ event, ...fields })}\n`;
  process.stdout.write(`${JSON.stringify({ log: line })}\n`);
  process.stderr.write(line);
};
const tether = await run(process.env, async (_env, _log) => channel, log, {
  retryBaseMs: 5,
  tools: createTestTools({ push: (entry: string) => process.stdout.write(`${JSON.stringify({ ran: entry })}\n`) }),
});
process.once("SIGTERM", () => void tether.stop());
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
await tether.done;
