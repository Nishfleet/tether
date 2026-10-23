import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export type Ask = (question: string, options?: { secret?: boolean }) => Promise<string>;

export function terminalAsk(): { ask: Ask; close: () => void } {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return {
    ask: async (question, options = {}) => {
      process.stdout.write(question);
      muted = options.secret === true;
      const answer = await rl.question("");
      muted = false;
      if (options.secret) process.stdout.write("\n");
      return answer.trim();
    },
    close: () => rl.close(),
  };
}
