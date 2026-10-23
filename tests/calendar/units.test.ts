import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadCalendarConfig } from "../../src/calendar/config.ts";
import { openCalendar } from "../../src/calendar/index.ts";
import { describeWhen, parseWhen } from "../../src/calendar/time.ts";
import { clean } from "../../src/calendar/untrusted.ts";

const GOOGLE = { TETHER_GOOGLE_CLIENT_ID: "a", TETHER_GOOGLE_CLIENT_SECRET: "b", TETHER_GOOGLE_REFRESH_TOKEN: "c" };
const ICLOUD = { TETHER_ICLOUD_APPLE_ID: "x", TETHER_ICLOUD_APP_PASSWORD: "y" };

describe("calendar config", () => {
  it("connects nothing when no calendar variable is set", () => {
    const config = loadCalendarConfig({});
    assert.equal(config.google, undefined);
    assert.equal(config.icloud, undefined);
    assert.equal(config.timezone, "Asia/Kolkata");
    assert.equal(openCalendar(config), undefined);
  });

  it("connects each account on its own", () => {
    assert.deepEqual(openCalendar(loadCalendarConfig(GOOGLE))?.backends.calendar.map((backend) => backend.source), ["google"]);
    assert.deepEqual(openCalendar(loadCalendarConfig(ICLOUD))?.backends.contacts.map((backend) => backend.source), ["icloud"]);
    assert.deepEqual(openCalendar(loadCalendarConfig({ ...GOOGLE, ...ICLOUD }))?.backends.calendar.map((backend) => backend.source), ["google", "icloud"]);
  });

  it("fails loudly when an account is half set up, naming only the missing variables", () => {
    assert.throws(() => loadCalendarConfig({ TETHER_GOOGLE_CLIENT_ID: "secret-value", TETHER_GOOGLE_CLIENT_SECRET: "b" }), (error: Error) => {
      assert.match(error.message, /TETHER_GOOGLE_REFRESH_TOKEN/);
      assert.ok(!error.message.includes("secret-value"));
      return true;
    });
    assert.throws(() => loadCalendarConfig({ TETHER_ICLOUD_APPLE_ID: "x" }), /TETHER_ICLOUD_APP_PASSWORD/);
  });

  it("rejects an unknown timezone", () => {
    assert.throws(() => loadCalendarConfig({ TETHER_TIMEZONE: "Mars/Base" }), /TETHER_TIMEZONE/);
    assert.equal(loadCalendarConfig({ TETHER_TIMEZONE: "Europe/London" }).timezone, "Europe/London");
  });
});

describe("times", () => {
  it("reads dates and wall-clock times in the person's timezone, and offsets as given", () => {
    assert.equal(parseWhen("2026-10-24", "Asia/Kolkata")?.date.toISOString(), "2026-10-23T18:30:00.000Z");
    assert.equal(parseWhen("2026-10-24T13:00", "Asia/Kolkata")?.date.toISOString(), "2026-10-24T07:30:00.000Z");
    assert.equal(parseWhen("2026-10-24 13:00", "Asia/Kolkata")?.dateOnly, false);
    assert.equal(parseWhen("2026-10-24T13:00:00-04:00", "Asia/Kolkata")?.date.toISOString(), "2026-10-24T17:00:00.000Z");
    assert.equal(parseWhen("2026-10-24T13:00:00Z", "Asia/Kolkata")?.date.toISOString(), "2026-10-24T13:00:00.000Z");
  });

  it("follows daylight saving in zones that use it", () => {
    assert.equal(parseWhen("2026-10-24T12:00", "America/New_York")?.date.toISOString(), "2026-10-24T16:00:00.000Z");
    assert.equal(parseWhen("2026-11-02T12:00", "America/New_York")?.date.toISOString(), "2026-11-02T17:00:00.000Z");
  });

  it("refuses text that is not a date", () => {
    for (const bad of ["tomorrow", "2026-13-40", "24/10/2026", "2026-10-24T25:00", ""]) assert.equal(parseWhen(bad, "Asia/Kolkata"), undefined, bad);
  });

  it("describes a span in the person's timezone", () => {
    const zone = "Asia/Kolkata";
    assert.equal(describeWhen(new Date("2026-10-24T07:30:00Z"), new Date("2026-10-24T08:30:00Z"), false, zone), "Sat, 24 Oct 2026 13:00-14:00");
    assert.equal(describeWhen(new Date("2026-10-24T17:30:00Z"), new Date("2026-10-25T01:30:00Z"), false, zone), "Sat, 24 Oct 2026 23:00 to Sun, 25 Oct 2026 07:00");
    assert.equal(describeWhen(new Date("2026-10-23T18:30:00Z"), new Date("2026-10-25T18:30:00Z"), true, zone), "Sat, 24 Oct 2026 to Sun, 25 Oct 2026, all day");
  });
});

describe("untrusted text", () => {
  it("flattens lines, drops tags and control characters, and shortens", () => {
    assert.equal(clean("a\n\n<b>b</b>\t\u0000c", 50), "a b b /b c");
    assert.equal(clean("x".repeat(30), 10), `${"x".repeat(10)}...`);
  });
});
