import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineTool } from "@earendil-works/pi-durable";
import type { Channel } from "./channel.ts";
import { StateDoc } from "./docs.ts";
import type { Log } from "./log.ts";
import { OwnerDoc } from "./owner.ts";
import { failure, text } from "./tool.ts";

export const TEXT_CHARS = 3500;
export const TEXT_LIMIT = 20;
export const TEXT_WINDOW_MS = 600000;

export type Outbox = {
  sent: number[];
};

export const OutboxDoc = defineDoc<Outbox>({
  kind: "tether.outbox",
  version: 1,
  scope: "session",
  initial: () => ({ sent: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

export function textOwnerTool(options: { channel: Channel; log: Log }) {
  const { channel, log } = options;
  return defineTool({
    name: "text_owner",
    description: `Text the owner one extra message right now, before your final answer. Use it to send a long answer in parts: call it once for each part in order, then write the last part as your final answer. At most ${TEXT_CHARS} characters each.`,
    parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: TEXT_CHARS }) }),
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const space = (await api.snapshot(OwnerDoc, context))?.space;
      if (!space) return failure("No chat to text yet.");
      const now = api.now();
      const recent = ((await api.snapshot(OutboxDoc, context))?.sent ?? []).filter((at) => now - at < TEXT_WINDOW_MS);
      if (recent.length >= TEXT_LIMIT) return failure(`Too many extra texts (${TEXT_LIMIT} in ${TEXT_WINDOW_MS / 60000} minutes). Put the rest in your final answer.`);
      const clear = await api.commit(async (tx) => !(await tx.doc(StateDoc)).stopped, context);
      if (!clear) return failure("Stopped. Nothing was sent.");
      try {
        await channel.send(space, args.text);
      } catch (error) {
        log("owner_text_failed", { error: error instanceof Error ? error.name : "unknown" });
        return failure("The text could not be sent. Put it in your final answer instead.");
      }
      await api.commit(async (tx) => {
        const outbox = await tx.doc(OutboxDoc);
        outbox.sent.splice(0, outbox.sent.length, ...outbox.sent.filter((at) => now - at < TEXT_WINDOW_MS), now);
      }, context);
      return text("Sent.");
    },
  });
}
