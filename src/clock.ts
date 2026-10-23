import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { text } from "./tool.ts";

export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function offsetOf(ms: number, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date(ms))
    .find((entry) => entry.type === "timeZoneName")?.value;
  const match = /^GMT([+-]\d{2}:\d{2})$/.exec(part ?? "");
  return match?.[1] ?? "+00:00";
}

export function isoInZone(ms: number, timeZone: string): string {
  const local = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
  return `${local.replace(" ", "T")}${offsetOf(ms, timeZone)}`;
}

export function humanInZone(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

export function clockTool(timeZone: string) {
  return defineTool({
    name: "time_now",
    description: "Get the current date and time in the owner's time zone. Call it before you turn a clock time or a date into the `at` value of reminder_set.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api) => {
      const now = api.now();
      return text(`${humanInZone(now, timeZone)} (${timeZone}). ISO 8601: ${isoInZone(now, timeZone)}.`);
    },
  });
}
