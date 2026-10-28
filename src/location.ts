import { Type } from "@earendil-works/pi-ai";
import { defineTool, type Task } from "@earendil-works/pi-durable";
import type { Locations } from "./channel.ts";
import { OwnerDoc } from "./owner.ts";
import type { ReplyInput, ReplyState } from "./reply.ts";
import { failure, text } from "./tool.ts";

export type Coordinates = {
  latitude: number;
  longitude: number;
  label: string | null;
};

export const ASK_TEXT = "Where are you? Share your location with me from Find My, or tell me an area name.";

export const LABEL_CHARS = 60;

export function cleanLabel(value: string | null | undefined): string | null {
  const cleaned = (value ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}"]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LABEL_CHARS)
    .trim();
  return cleaned === "" ? null : cleaned;
}

export function describeAge(now: number, at: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

export function describeCoordinates(where: Coordinates): string {
  const base = `${where.latitude.toFixed(5)}, ${where.longitude.toFixed(5)}`;
  return where.label ? `${base} (${where.label})` : base;
}

export function locationTools(options: { reply: Task<ReplyInput, ReplyState, null, object>; locations: Locations | undefined }) {
  const { reply, locations } = options;

  const request = defineTool({
    name: "location_request",
    description:
      "Ask the owner to share their location. It sends a Find My request card in the chat, and the owner taps Share. Use it when you need to know where they are, for example before a nearby-places search with no known location. The request is already sent, so do not repeat the steps. Their location is readable only after they accept.",
    parameters: Type.Object({}),
    execute: async (_args, api, context) => {
      const space = (await api.snapshot(OwnerDoc, context))?.space;
      if (!space) return failure("No chat to text yet.");
      if (locations && (await locations.request(space))) {
        return text("Sent a Find My request card. Tell the owner to tap Share on it, in one short line.");
      }
      await api.commit(async (tx) => {
        const notice: ReplyInput = { space, inbound: null, prompt: null, notice: ASK_TEXT, run: 0 };
        await tx.createTask(reply, notice, { ownership: { kind: "conversation" }, conversationId: api.conversationId });
      }, context);
      return text("Sent a text asking for the location. Tell the owner you asked, in one short line.");
    },
  });

  const last = defineTool({
    name: "location_last",
    description: "Read where the owner is from Find My, with how long ago it was. Nothing comes back unless they are sharing.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api) => {
      const found = await locations?.current();
      if (!found) return failure("No location yet. Use location_request.");
      return text(`${describeCoordinates(found)}, ${describeAge(api.now(), found.at)}.`);
    },
  });

  return [request, last];
}
