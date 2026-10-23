import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineTool, type Task } from "@earendil-works/pi-durable";
import type { InboundAttachment } from "./channel.ts";
import { OwnerDoc } from "./owner.ts";
import type { ReplyInput, ReplyState } from "./reply.ts";
import { failure, text } from "./tool.ts";

export type Coordinates = {
  latitude: number;
  longitude: number;
  label: string | null;
};

export type SavedLocation = Coordinates & { at: number };

export type LocationState = {
  latest: SavedLocation | null;
};

export const MAX_LOCATION_BYTES = 65536;
export const ASK_TEXT = "Where are you? In this chat tap +, choose Location, then tap Send Pin.";

export const LocationDoc = defineDoc<LocationState>({
  kind: "tether.location",
  version: 1,
  scope: "session",
  initial: () => ({ latest: null }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

const VCARD_TYPES = ["text/vcard", "text/x-vcard", "text/directory", "text/x-vlocation", "application/vcard", "application/x-vcard"];

export function isLocationAttachment(attachment: InboundAttachment): boolean {
  if (attachment.size > MAX_LOCATION_BYTES) return false;
  const type = (attachment.mimeType.split(";")[0] ?? "").trim().toLowerCase();
  return attachment.fileName.toLowerCase().endsWith(".vcf") || VCARD_TYPES.includes(type);
}

const PAIR = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
const COORDINATE_PARAMS = ["ll", "sll", "q", "center", "daddr", "saddr", "near"];
const AT_PATH = /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/;

function pair(value: string): { latitude: number; longitude: number } | undefined {
  const match = PAIR.exec(value);
  if (!match) return undefined;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  return { latitude, longitude };
}

function fromUrl(value: string): { latitude: number; longitude: number; name: string | null } | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const name = url.searchParams.get("q");
  for (const key of COORDINATE_PARAMS) {
    const found = pair(url.searchParams.get(key) ?? "");
    if (found) return { ...found, name: name !== null && pair(name) === undefined ? name : null };
  }
  const at = AT_PATH.exec(decodeURIComponent(url.pathname));
  const found = at ? pair(`${at[1]},${at[2]}`) : undefined;
  return found ? { ...found, name: null } : undefined;
}

const unescapeValue = (value: string) => value.replace(/\\([,;\\nN])/g, (_all, char: string) => (char === "n" || char === "N" ? " " : char));

export function parseLocation(vcard: string): Coordinates | undefined {
  const lines = vcard.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const label = lines.map((line) => /^FN(?:;[^:]*)?:(.*)$/i.exec(line)?.[1]?.trim()).find((value) => value);
  for (const line of lines) {
    const geo = /^GEO(?:;[^:]*)?:(.*)$/i.exec(line)?.[1];
    const found = geo === undefined ? undefined : pair(unescapeValue(geo));
    if (found) return { ...found, label: label ? unescapeValue(label) : null };
  }
  for (const line of lines) {
    const value = /^(?:[A-Za-z0-9-]+\.)?URL(?:;[^:]*)?:(\S.*)$/i.exec(line)?.[1];
    const found = value === undefined ? undefined : fromUrl(unescapeValue(value.trim()));
    if (found) return { latitude: found.latitude, longitude: found.longitude, label: found.name ?? (label ? unescapeValue(label) : null) };
  }
  return undefined;
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

export function locationPrompt(where: Coordinates): string {
  return `I shared my location: ${describeCoordinates(where)}. It is saved as my last location.`;
}

export function locationTools(options: { reply: Task<ReplyInput, ReplyState, null, object> }) {
  const { reply } = options;

  const request = defineTool({
    name: "location_request",
    description:
      "Text the owner asking them to share their location in this chat. Use it when you need to know where they are, for example before a nearby-places search with no saved location. The owner sends a pin, and it arrives as a new message. The text is already sent, so do not repeat the steps.",
    parameters: Type.Object({}),
    execute: async (_args, api, context) => {
      const outcome = await api.commit(async (tx) => {
        const owner = await tx.doc(OwnerDoc);
        if (owner.space === null) return false;
        const notice: ReplyInput = { space: owner.space, inbound: null, prompt: null, notice: ASK_TEXT, run: 0 };
        await tx.createTask(reply, notice, { ownership: { kind: "conversation" }, conversationId: api.conversationId });
        return true;
      }, context);
      return outcome ? text("Sent a text asking for the location. Tell the owner you asked, in one short line.") : failure("No chat to text yet.");
    },
  });

  const last = defineTool({
    name: "location_last",
    description: "Read the last location the owner shared, with how long ago it was shared.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const saved = (await api.snapshot(LocationDoc, context))?.latest;
      if (!saved) return failure("No location saved yet. Use location_request.");
      return text(`${describeCoordinates(saved)}, shared ${describeAge(api.now(), saved.at)}.`);
    },
  });

  return [request, last];
}
