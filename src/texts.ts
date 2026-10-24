import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { Channel } from "./channel.ts";
import { StateDoc } from "./docs.ts";
import type { Log } from "./log.ts";
import { OwnerDoc } from "./owner.ts";
import { failure, text } from "./tool.ts";

export const TEXT_CHARS = 3500;

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
      const clear = await api.commit(async (tx) => !(await tx.doc(StateDoc)).stopped, context);
      if (!clear) return failure("Stopped. Nothing was sent.");
      try {
        await channel.send(space, args.text);
      } catch (error) {
        log("owner_text_failed", { error: error instanceof Error ? error.name : "unknown" });
        return failure("The text could not be sent. Put it in your final answer instead.");
      }
      return text("Sent.");
    },
  });
}
