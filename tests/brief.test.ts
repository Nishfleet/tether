import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CalendarOptions } from "../src/calendar/tools.ts";
import type { CalendarEvent } from "../src/calendar/types.ts";
import { nextBriefAt, WEATHER_HOST } from "../src/brief.ts";
import { RESUMED_TEXT, STOPPED_TEXT } from "../src/app.ts";
import { FakeClock } from "./clock.ts";
import { FakeChannel, call, inbound, say } from "./helpers.ts";
import { Rig } from "./rig.ts";

const opts = { timeout: 30000 };
const ZONE = "Asia/Kolkata";
const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);

const event = (title: string, start: string, end: string, allDay = false): CalendarEvent => ({
  sources: ["google"],
  title,
  start: new Date(start),
  end: new Date(end),
  allDay,
  location: "",
  attendees: 0,
});

const calendarOf = (list: () => Promise<CalendarEvent[]>): CalendarOptions => ({
  timezone: ZONE,
  backends: { calendar: [{ source: "google", list, create: async () => undefined }], contacts: [] },
});

type WeatherCall = { url: string; init: { headers: Record<string, string>; signal: AbortSignal; redirect: "error" } };

const forecast = (seen: WeatherCall[] = []) => async (url: string, init: WeatherCall["init"]) => {
  seen.push({ url, init });
  return new Response(JSON.stringify({ daily: { temperature_2m_max: [31.2], temperature_2m_min: [22.4], precipitation_probability_max: [40] } }), { status: 200 });
};

const here = (at: number) => ({
  current: async () => ({ latitude: 12.9689, longitude: 77.5842, label: "Indiranagar", at }),
  request: async () => true,
});

describe("morning brief", () => {
  let rig: Rig;
  let clock: FakeClock;
  beforeEach(async () => {
    rig = new Rig();
    clock = new FakeClock(at("2026-10-24T06:30:00+05:30"));
    await rig.open();
  });
  afterEach(() => rig.close());

  const boot = (extra: Parameters<Rig["boot"]>[0] = {}) => rig.boot({ now: clock.now, setTimer: clock.setTimer, ...extra });

  const briefs = () => rig.texts().filter((text) => text.startsWith("Good morning."));

  const until = async (check: () => boolean, limit = 5000) => {
    for (let waited = 0; !check(); waited += 20) {
      if (waited > limit) assert.fail("timed out waiting");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const textOnce = async () => {
    rig.model.enqueue(say("Hi."));
    rig.channel.push(inbound("hello", "hi"));
    await rig.channel.sentCount(1);
  };

  const restart = async (down: number, extra: Parameters<Rig["boot"]>[0] = {}) => {
    await rig.tether?.stop();
    rig.channel.restart();
    await clock.restart(down);
    await boot(extra);
  };

  it("computes the next brief time in the owner's zone", () => {
    assert.equal(nextBriefAt(at("2026-10-24T06:30:00+05:30"), "08:00", ZONE), at("2026-10-24T08:00:00+05:30"));
    assert.equal(nextBriefAt(at("2026-10-24T08:00:00+05:30"), "08:00", ZONE), at("2026-10-25T08:00:00+05:30"));
    assert.equal(nextBriefAt(at("2026-10-24T23:59:00+05:30"), "00:30", ZONE), at("2026-10-25T00:30:00+05:30"));
  });

  it("keeps the brief time across a daylight-saving change", () => {
    const gap = nextBriefAt(at("2026-03-28T20:00:00Z"), "01:30", "Europe/London");
    assert.equal(gap, at("2026-03-29T01:30:00Z"), "01:30 does not exist on 29 March, so the brief moves to 02:30 local");
    assert.ok(nextBriefAt(gap, "01:30", "Europe/London") > gap);
    assert.equal(nextBriefAt(at("2026-10-24T00:35:00Z"), "01:30", "Europe/London"), at("2026-10-25T01:30:00Z"));
  });

  it("texts the calendar, reminders due today and weather at 08:00, then again the next day", opts, async () => {
    const seen: WeatherCall[] = [];
    rig.model.enqueue(call("reminder_set", { text: "call mum", at: "2026-10-24T10:00:00+05:30" }), say("Set."));
    rig.channel.locations = here(clock.now() - 30 * MIN);
    await boot({
      fetch: forecast(seen),
      calendar: calendarOf(async () => [
        event("Standup", "2026-10-24T09:00:00+05:30", "2026-10-24T09:30:00+05:30"),
        event("Holiday", "2026-10-24T00:00:00+05:30", "2026-10-25T00:00:00+05:30", true),
      ]),
    });
    rig.channel.push(inbound("m1", "remind me to call mum at 10"));
    await rig.channel.sentCount(1);
    await clock.advance(89 * MIN);
    assert.equal(rig.texts().length, 1, "not before 08:00");
    await clock.advance(1 * MIN);
    await until(() => briefs().length === 1);
    assert.equal(
      briefs()[0],
      "Good morning.\nCalendar: all day Holiday; 09:00 Standup.\nReminders: 10:00 call mum.\nWeather where you are: 22 to 31 C, 40% chance of rain.",
    );
    const sent = seen[0];
    assert.ok(sent, "the weather was looked up");
    const url = new URL(sent.url);
    assert.equal(url.host, WEATHER_HOST);
    assert.equal(url.searchParams.get("latitude"), "12.97");
    assert.equal(url.searchParams.get("longitude"), "77.58");
    assert.deepEqual([...url.searchParams.keys()].sort(), ["daily", "forecast_days", "latitude", "longitude", "timezone"]);
    assert.equal(sent.init.redirect, "error");
    assert.ok(sent.init.signal instanceof AbortSignal);
    assert.match(sent.init.headers["user-agent"] ?? "", /tether/);
    await clock.advance(24 * 60 * MIN);
    await until(() => briefs().length === 2);
  });

  it("survives a restart: one brief at the set time, none repeated", opts, async () => {
    await boot();
    await textOnce();
    await restart(88 * MIN);
    assert.deepEqual(briefs(), [], "nothing before 08:00");
    await clock.advance(2 * MIN);
    await until(() => briefs().length === 1);
    assert.equal(briefs()[0], "Good morning.\nNothing scheduled today.");
    await restart(5 * MIN);
    await clock.advance(1 * MIN);
    assert.equal(briefs().length, 1, "a sent brief is not sent again after a restart");
  });

  it("still sends a brief that came due while the process was down, but not one that is hours late", opts, async () => {
    await boot();
    await textOnce();
    await restart(100 * MIN);
    await until(() => briefs().length === 1);
    await restart(24 * 60 * MIN + 4 * 60 * MIN);
    await clock.advance(1 * MIN);
    assert.equal(briefs().length, 1, "noon is too late for a morning brief");
    assert.ok(rig.logs.some((entry) => entry.event === "brief_skipped" && entry.fields.reason === "late"));
  });

  it("skips a source that is missing or failing and still sends the rest", opts, async () => {
    await boot({ calendar: calendarOf(() => Promise.reject(new Error("calendar down"))), fetch: forecast() });
    await textOnce();
    await clock.advance(90 * MIN);
    await until(() => briefs().length === 1);
    assert.equal(briefs()[0], "Good morning.\nNothing scheduled today.");
    assert.ok(rig.logs.some((entry) => entry.event === "brief_source_failed" && entry.fields.source === "google"));
  });

  it("skips weather when the lookup fails", opts, async () => {
    rig.channel.locations = here(clock.now());
    await boot({ fetch: async () => new Response("no", { status: 500 }), calendar: calendarOf(async () => []) });
    await textOnce();
    await clock.advance(90 * MIN);
    await until(() => briefs().length === 1);
    assert.equal(briefs()[0], "Good morning.\nCalendar: nothing today.");
    assert.ok(rig.logs.some((entry) => entry.event === "brief_source_failed" && entry.fields.source === "weather"));
  });

  it("leaves out the weather when the owner is not sharing a location", opts, async () => {
    rig.channel.locations = { current: async () => undefined, request: async () => true };
    await boot({ fetch: forecast(), calendar: calendarOf(async () => []) });
    await textOnce();
    await clock.advance(90 * MIN);
    await until(() => briefs().length === 1);
    assert.equal(briefs()[0], "Good morning.\nCalendar: nothing today.");
  });

  it("cuts off a calendar backend that hangs and still sends the rest", opts, async () => {
    rig.channel.locations = here(clock.now());
    await boot({ fetch: forecast(), calendar: calendarOf(() => new Promise<CalendarEvent[]>(() => undefined)) });
    await textOnce();
    await clock.advance(90 * MIN);
    await until(() => briefs().length === 1, 20000);
    assert.equal(briefs()[0], "Good morning.\nWeather where you are: 22 to 31 C, 40% chance of rain.");
    assert.ok(rig.logs.some((entry) => entry.event === "brief_source_failed" && entry.fields.source === "google"));
  });

  it("does not send a brief before the owner has written once", opts, async () => {
    rig.channel.locations = here(clock.now());
    await boot({ fetch: forecast(), calendar: calendarOf(async () => []) });
    await clock.advance(90 * MIN);
    await until(() => rig.logs.some((entry) => entry.event === "brief_skipped" && entry.fields.reason === "no_space"));
    assert.deepEqual(briefs(), []);
    await clock.advance(24 * 60 * MIN);
    assert.deepEqual(briefs(), [], "and not later the same day");
  });

  it("sends one more brief the same day when the time is moved after it", opts, async () => {
    await boot({ fetch: forecast(), calendar: calendarOf(async () => []) });
    await textOnce();
    rig.model.enqueue(call("brief_set", { time: "20:00" }), say("Moved."));
    await clock.advance(90 * MIN);
    await until(() => briefs().length === 1);
    rig.channel.push(inbound("m1", "brief at 8pm"));
    await until(() => rig.texts().includes("Moved."));
    await clock.advance(12 * 60 * MIN);
    await until(() => briefs().length === 2);
    await clock.advance(24 * 60 * MIN);
    await until(() => briefs().length === 3);
  });

  it("texts a stale location less confidently than a fresh one", opts, async () => {
    rig.channel.locations = here(clock.now() - 5 * 60 * MIN);
    await boot({ fetch: forecast(), calendar: calendarOf(async () => []) });
    await textOnce();
    await clock.advance(90 * MIN);
    await until(() => briefs().length === 1);
    assert.equal(briefs()[0], "Good morning.\nCalendar: nothing today.\nWeather where you last were: 22 to 31 C, 40% chance of rain.");
  });

  it("brief_set moves the time, brief_status reads it, and brief_off stops it", opts, async () => {
    rig.model.enqueue(
      call("brief_set", { time: "07:30" }),
      say("Moved."),
      call("brief_status", {}),
      say("At 7:30."),
      call("brief_off", {}),
      say("Off."),
    );
    await boot();
    rig.channel.push(inbound("m1", "brief at 7:30"));
    await rig.channel.sentCount(1);
    rig.channel.push(inbound("m2", "when is my brief"));
    await until(() => rig.texts().includes("At 7:30."));
    assert.match(JSON.stringify(rig.model.requests.at(-1) ?? {}), /The morning brief comes every day at 07:30/);
    await clock.advance(60 * MIN);
    await until(() => briefs().length === 1);
    await clock.advance(60 * MIN);
    assert.equal(briefs().length, 1, "the old 08:00 brief does not also fire");
    rig.channel.push(inbound("m3", "stop the brief"));
    await until(() => rig.texts().includes("Off."));
    await clock.advance(48 * 60 * MIN);
    assert.equal(briefs().length, 1, "no brief after brief_off");
  });

  it("keeps the set time and the off switch across a restart", opts, async () => {
    rig.model.enqueue(call("brief_set", { time: "07:30" }), say("Moved."), call("brief_off", {}), say("Off."));
    await boot();
    rig.channel.push(inbound("m1", "brief at 7:30"));
    await rig.channel.sentCount(1);
    await restart(20 * MIN);
    await clock.advance(40 * MIN);
    await until(() => briefs().length === 1);
    rig.channel.push(inbound("m2", "stop the brief"));
    await until(() => rig.texts().includes("Off."));
    await restart(24 * 60 * MIN);
    await clock.advance(48 * 60 * MIN);
    assert.equal(briefs().length, 1, "no brief after brief_off, across a restart");
  });

  it("sends nothing while STOP is on, and looks nothing up", opts, async () => {
    let lookups = 0;
    rig.channel.locations = here(clock.now());
    await boot({
      fetch: async (url, init) => {
        lookups += 1;
        return forecast()(url, init);
      },
    });
    await textOnce();
    rig.channel.push(inbound("m1", "STOP"));
    await until(() => rig.texts().includes(STOPPED_TEXT));
    await clock.advance(90 * MIN);
    assert.deepEqual(briefs(), []);
    assert.equal(lookups, 0, "no weather lookup while stopped");
    assert.ok(rig.logs.some((entry) => entry.event === "brief_skipped" && entry.fields.reason === "stopped"));
    rig.channel.push(inbound("m2", "RESUME"));
    await until(() => rig.texts().includes(RESUMED_TEXT));
    await clock.advance(24 * 60 * MIN);
    await until(() => briefs().length === 1);
  });
});
