import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineTask, defineTool, type ConversationId, type Task, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import { type CalendarOptions, dedupe } from "./calendar/tools.ts";
import { addDays, isoDay, parseWhen } from "./calendar/time.ts";
import type { Locations } from "./channel.ts";
import { StateDoc } from "./docs.ts";
import type { Log } from "./log.ts";
import { OwnerDoc } from "./owner.ts";
import type { Fetch } from "./places.ts";
import { RemindersDoc } from "./reminders.ts";
import type { ReplyInput, ReplyState } from "./reply.ts";
import { text } from "./tool.ts";

export type Brief = {
  time: string | null;
  gen: number;
};

export type BriefInput = { gen: number; at: number };

export type BriefState = { phase: "wait"; at: number };

export const DEFAULT_BRIEF_TIME = "08:00";
export const LATE_MS = 3 * 3_600_000;
export const WEATHER_HOST = "api.open-meteo.com";
export const WEATHER_URL = `https://${WEATHER_HOST}/v1/forecast`;
export const WEATHER_TIMEOUT_MS = 10000;
export const TIME_PATTERN = "^([01]\\d|2[0-3]):[0-5]\\d$";

export const BriefDoc = defineDoc<Brief>({
  kind: "tether.brief",
  version: 1,
  scope: "session",
  initial: () => ({ time: DEFAULT_BRIEF_TIME, gen: 0 }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

export type BriefTask = Task<BriefInput, BriefState, null, object>;

export type BriefOptions = {
  readonly reply: Task<ReplyInput, ReplyState, null, object>;
  readonly timeZone: string;
  readonly fetch: Fetch;
  readonly userAgent: string;
  readonly log: Log;
  readonly calendar: CalendarOptions | undefined;
  readonly locations: Locations | undefined;
};

export function nextBriefAt(after: number, time: string, zone: string): number {
  for (const offset of [0, 1]) {
    const day = isoDay(addDays(new Date(after), zone, offset), zone);
    const at = parseWhen(`${day}T${time}`, zone)?.date.getTime();
    if (at !== undefined && at > after) return at;
  }
  throw new Error(`no brief time after ${after} for ${time}`);
}

const clock = (ms: number, zone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

const flat = (value: string, limit: number) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, limit);

async function calendarLine(options: BriefOptions, from: Date, to: Date): Promise<string | undefined> {
  const backends = options.calendar?.backends.calendar ?? [];
  if (backends.length === 0) return undefined;
  const settled = await Promise.allSettled(backends.map((backend) => backend.list(from, to)));
  const events = settled.flatMap((outcome, index) => {
    if (outcome.status === "fulfilled") return outcome.value;
    options.log("brief_source_failed", { source: backends[index]?.source ?? "calendar", error: outcome.reason instanceof Error ? outcome.reason.name : "unknown" });
    return [];
  });
  if (settled.every((outcome) => outcome.status === "rejected")) return undefined;
  if (events.length === 0) return "Calendar: nothing today.";
  const items = dedupe(events).map((event) => `${event.allDay ? "all day" : clock(event.start.getTime(), options.timeZone)} ${flat(event.title, 120)}`);
  return `Calendar: ${items.join("; ")}.`;
}

async function weatherLine(options: BriefOptions, place: { latitude: number; longitude: number }): Promise<string | undefined> {
  const url = new URL(WEATHER_URL);
  url.searchParams.set("latitude", String(place.latitude));
  url.searchParams.set("longitude", String(place.longitude));
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("timezone", options.timeZone);
  try {
    const response = await options.fetch(url.toString(), {
      headers: { "user-agent": options.userAgent, accept: "application/json" },
      signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`weather status ${response.status}`);
    const body = (await response.json()) as { daily?: Record<string, unknown> };
    const first = (key: string) => (Array.isArray(body.daily?.[key]) ? (body.daily[key] as unknown[])[0] : undefined);
    const high = first("temperature_2m_max");
    const low = first("temperature_2m_min");
    const rain = first("precipitation_probability_max");
    if (typeof high !== "number" || typeof low !== "number") throw new Error("weather reply has no temperatures");
    const chance = typeof rain === "number" ? `, ${Math.round(rain)}% chance of rain` : "";
    return `Weather where you last were: ${Math.round(low)} to ${Math.round(high)} C${chance}.`;
  } catch (error) {
    options.log("brief_source_failed", { source: "weather", error: error instanceof Error ? error.name : "unknown" });
    return undefined;
  }
}

async function weatherHere(options: BriefOptions): Promise<string | undefined> {
  if (!options.locations) return undefined;
  try {
    const place = await options.locations.current();
    return place ? await weatherLine(options, place) : undefined;
  } catch (error) {
    options.log("brief_source_failed", { source: "location", error: error instanceof Error ? error.name : "unknown" });
    return undefined;
  }
}

type Runtime = TaskRuntime<BriefInput, BriefState, null, object>;

async function compose(options: BriefOptions, runtime: Runtime, context: Context): Promise<string> {
  const { timeZone } = options;
  const now = runtime.now();
  const start = addDays(new Date(now), timeZone, 0);
  const end = addDays(new Date(now), timeZone, 1);
  const reminders = await runtime.snapshot(RemindersDoc, context);
  const due = (reminders?.items ?? [])
    .filter((item) => item.at >= start.getTime() && item.at < end.getTime())
    .sort((a, b) => a.at - b.at)
    .map((item) => `${clock(item.at, timeZone)} ${item.text}`);
  const lines = [
    await calendarLine(options, start, end),
    due.length > 0 ? `Reminders: ${due.join("; ")}.` : undefined,
    await weatherHere(options),
  ].filter((line) => line !== undefined);
  return ["Good morning.", ...(lines.length > 0 ? lines : ["Nothing scheduled today."])].join("\n");
}

export function createBriefTask(options: BriefOptions): BriefTask {
  const { reply, timeZone, log } = options;
  return defineTask<BriefInput, BriefState, null>({
    name: "tether.brief",
    version: 1,
    initial: (input) => ({ phase: "wait", at: input.at }),
    phases: {
      wait: async (task, runtime, context) => {
        const { gen } = task.input;
        const { at } = task.state.checkpoint;
        const live = await runtime.snapshot(BriefDoc, context);
        if (live?.gen !== gen) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "superseded" } }), context);
          return;
        }
        if (runtime.now() < at) {
          await runtime.sleepUntil(at, { phase: "wait", at }, context);
          return;
        }
        const body = runtime.now() - at > LATE_MS ? undefined : await compose(options, runtime, context);
        await runtime.commit(async (tx) => {
          const brief = await tx.doc(BriefDoc);
          if (brief.gen !== gen || brief.time === null) return { status: "terminal", outcome: { status: "aborted", reason: "superseded" } };
          const owner = await tx.doc(OwnerDoc);
          if (body === undefined) log("brief_skipped", { reason: "late" });
          else if (owner.space === null) log("brief_skipped", { reason: "no_space" });
          else if ((await tx.doc(StateDoc)).stopped) log("brief_skipped", { reason: "stopped" });
          else {
            const notice: ReplyInput = { space: owner.space, inbound: null, prompt: null, notice: body, run: 0 };
            await tx.createTask(reply, notice, { ownership: { kind: "conversation" }, conversationId: runtime.conversationId });
          }
          const until = nextBriefAt(runtime.now(), brief.time, timeZone);
          return { status: "sleeping", until, checkpoint: { phase: "wait", at: until } };
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
}

async function schedule(tx: Tx, task: BriefTask, conversationId: ConversationId, now: number, timeZone: string, time: string | null): Promise<void> {
  const brief = await tx.doc(BriefDoc);
  brief.time = time;
  brief.gen += 1;
  if (time === null) return;
  await tx.createTask(task, { gen: brief.gen, at: nextBriefAt(now, time, timeZone) }, { ownership: { kind: "conversation" }, conversationId, background: true });
}

export async function startBrief(tx: Tx, task: BriefTask, conversationId: ConversationId, now: number, timeZone: string): Promise<void> {
  const brief = await tx.doc(BriefDoc);
  if (brief.gen === 0) await schedule(tx, task, conversationId, now, timeZone, brief.time);
}

export function briefTools(options: { task: BriefTask; timeZone: string }) {
  const { task, timeZone } = options;

  const set = defineTool({
    name: "brief_set",
    description: `Change when Tether texts the daily morning brief (today's calendar, reminders and weather). It is on by default at ${DEFAULT_BRIEF_TIME}. Give the time as 24-hour HH:MM in the owner's time zone (${timeZone}).`,
    parameters: Type.Object({ time: Type.String({ pattern: TIME_PATTERN }) }),
    replay: "safe",
    execute: async (args, api, context) => {
      const at = api.now();
      await api.commit((tx) => schedule(tx, task, api.conversationId, at, timeZone, args.time), context);
      return text(`The brief will come every day at ${args.time} (${timeZone}).`);
    },
  });

  const off = defineTool({
    name: "brief_off",
    description: "Stop the daily morning brief. brief_set turns it on again.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      await api.commit((tx) => schedule(tx, task, api.conversationId, api.now(), timeZone, null), context);
      return text("The morning brief is off.");
    },
  });

  return [set, off];
}
