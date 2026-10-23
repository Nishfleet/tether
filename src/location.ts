import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineTool, type Task } from "@earendil-works/pi-durable";
import type { InboundAttachment, Locations } from "./channel.ts";
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
export const ASK_TEXT = "Where are you? Share your location with me from Find My, or tell me an area name.";

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
  const at = AT_PATH.exec(safeDecode(url.pathname));
  const found = at ? pair(`${at[1]},${at[2]}`) : undefined;
  return found ? { ...found, name: null } : undefined;
}

const unescapeValue = (value: string) => value.replace(/\\([,;\\nN])/g, (_all, char: string) => (char === "n" || char === "N" ? " " : char));

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

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

export function parseLocation(vcard: string): Coordinates | undefined {
  const lines = vcard.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const name = lines.map((line) => /^FN(?:;[^:]*)?:(.*)$/i.exec(line)?.[1]?.trim()).find((value) => value);
  const label = name ? cleanLabel(unescapeValue(name)) : null;
  for (const line of lines) {
    const geo = /^GEO(?:;[^:]*)?:(.*)$/i.exec(line)?.[1];
    const found = geo === undefined ? undefined : pair(unescapeValue(geo));
    if (found) return { ...found, label };
  }
  for (const line of lines) {
    const value = /^(?:[A-Za-z0-9-]+\.)?URL(?:;[^:]*)?:(\S.*)$/i.exec(line)?.[1];
    const found = value === undefined ? undefined : fromUrl(unescapeValue(value.trim()));
    if (found) return { latitude: found.latitude, longitude: found.longitude, label: cleanLabel(found.name) ?? label };
  }
  return undefined;
}

const MAPS_HOST = /^(?:maps\.apple\.com|maps\.google\.(?:com|co\.[a-z]{2}|[a-z]{2,3})|maps\.app\.goo\.gl)$/i;
const GOOGLE_HOST = /^(?:www\.)?google\.(?:com|co\.[a-z]{2}|[a-z]{2,3})$/i;
const LINK_IN_TEXT = /https?:\/\/[^\s<>"']+/gi;

function isMapsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return MAPS_HOST.test(url.hostname) || (GOOGLE_HOST.test(url.hostname) && url.pathname.startsWith("/maps"));
  } catch {
    return false;
  }
}

export function mapsLinks(...sources: readonly (string | undefined)[]): string[] {
  return sources.flatMap((source) => (typeof source === "string" ? source.match(LINK_IN_TEXT) : null) ?? []).filter(isMapsUrl);
}

export function isMapsLinkOnly(value: string): boolean {
  const trimmed = value.trim();
  return mapsLinks(trimmed).length === 1 && mapsLinks(trimmed)[0] === trimmed;
}

export function linkAttachment(...sources: readonly (string | undefined)[]): InboundAttachment | undefined {
  const body = mapsLinks(...sources)
    .map((link) => `URL:${link}`)
    .join("\r\n");
  if (body === "" || parseLocation(body) === undefined) return undefined;
  return { fileName: "shared-location.loc.vcf", mimeType: "text/x-vlocation", size: body.length, read: async () => Buffer.from(body, "utf8") };
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

export type Located = {
  readonly coordinates: Coordinates;
  readonly at: number;
  readonly source: "find_my" | "pin";
};

export async function resolveLocation(options: { locations: Locations | undefined; saved: SavedLocation | null }): Promise<Located | undefined> {
  const live = await options.locations?.current();
  const found: Located[] = [];
  if (live) found.push({ coordinates: { latitude: live.latitude, longitude: live.longitude, label: live.label }, at: live.at, source: "find_my" });
  if (options.saved) found.push({ coordinates: options.saved, at: options.saved.at, source: "pin" });
  return found.sort((a, b) => b.at - a.at)[0];
}

export const describeSource = (located: Located) => (located.source === "find_my" ? "Find My" : "shared pin");

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
    description: "Read where the owner is: their Find My location when they are sharing it, otherwise the last pin they sent, with how long ago it was.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const located = await resolveLocation({ locations, saved: (await api.snapshot(LocationDoc, context))?.latest ?? null });
      if (!located) return failure("No location yet. Use location_request.");
      return text(`${describeCoordinates(located.coordinates)} (${describeSource(located)}), ${describeAge(api.now(), located.at)}.`);
    },
  });

  return [request, last];
}
