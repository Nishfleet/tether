import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { startTether, type Tether } from "../../src/app.ts";
import { loadCalendarConfig } from "../../src/calendar/config.ts";
import { openCalendar } from "../../src/calendar/index.ts";
import { createModelAccess } from "../../src/model.ts";
import { ALLOWED, FakeChannel, FakeModel, KEY, call, flatten, inbound, say } from "../helpers.ts";
import { APP_PASSWORD, APPLE_ID, FakeDav } from "./fake-dav.ts";
import { CLIENT_ID, CLIENT_SECRET, FakeGoogle, REFRESH_TOKEN } from "./fake-google.ts";

const opts = { timeout: 30000 };

describe("calendar in the running app", () => {
  let dir: string;
  let model: FakeModel;
  let channel: FakeChannel;
  let google: FakeGoogle;
  let dav: FakeDav;
  let tether: Tether | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tether-cal-"));
    model = new FakeModel();
    await model.start();
    channel = new FakeChannel();
    google = new FakeGoogle();
    await google.start();
    dav = new FakeDav();
    await dav.start();
  });

  afterEach(async () => {
    await tether?.stop();
    tether = undefined;
    await model.stop();
    await google.stop();
    await dav.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(connected = true): Promise<void> {
    const { models, ref } = createModelAccess({ baseUrl: model.url, apiKey: KEY });
    const calendar = openCalendar(
      loadCalendarConfig(
        {
          TETHER_GOOGLE_CLIENT_ID: CLIENT_ID,
          TETHER_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
          TETHER_GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN,
          TETHER_ICLOUD_APPLE_ID: APPLE_ID,
          TETHER_ICLOUD_APP_PASSWORD: APP_PASSWORD,
        },
        "Asia/Kolkata",
      ),
      { google: { tokenUrl: `${google.url}token`, calendarRoot: google.url, peopleRoot: google.url }, icloud: { caldavUrl: dav.url, carddavUrl: dav.url } },
    );
    assert.ok(calendar);
    tether = await startTether({
      channel,
      models,
      model: ref,
      storage: await openNodeSqliteStorage(join(dir, "t.sqlite")),
      allowedSender: ALLOWED,
      log: () => undefined,
      retryBaseMs: 5,
      settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 5 }, stream: { maxRetries: 0 } },
      ...(connected ? { calendar: { ...calendar, now: () => new Date("2026-10-23T08:00:00Z") } } : {}),
    });
  }

  it("answers what is on the calendar tomorrow with events from both accounts, and offers all five tools", opts, async () => {
    google.calendars = [{ id: "primary", selected: true }];
    google.eventsByCalendar = { primary: [{ summary: "Standup", start: { dateTime: "2026-10-24T10:00:00+05:30" }, end: { dateTime: "2026-10-24T10:30:00+05:30" } }] };
    dav.calendarObjects.push({
      name: "a.ics",
      data: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Fake//EN\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTAMP:20261020T000000Z\r\nDTSTART:20261024T093000Z\r\nDTEND:20261024T103000Z\r\nSUMMARY:Dentist\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    });
    model.enqueue(call("calendar_list", { from: "2026-10-24", to: "2026-10-24" }), say("Tomorrow: Standup at 10:00 and Dentist at 15:00."));
    await boot();
    channel.push(inbound("m1", "what's on my calendar tomorrow"));
    await channel.sentCount(1);
    assert.deepEqual(channel.sent.map((entry) => entry.text), ["Tomorrow: Standup at 10:00 and Dentist at 15:00."]);
    const first = model.requests[0];
    const offered = (first?.tools ?? []).map((tool) => tool.function.name);
    for (const name of ["calendar_create", "calendar_invite", "calendar_list", "contacts_add", "contacts_find", "memory_save"]) assert.ok(offered.includes(name), name);
    assert.match(flatten(first as never), /Today is Friday, 23 October 2026/);
    const second = flatten(model.requests[1] as never);
    assert.match(second, /\[google\] Sat, 24 Oct 2026 10:00-10:30 \| Standup/);
    assert.match(second, /\[icloud\] Sat, 24 Oct 2026 15:00-16:00 \| Dentist/);
    assert.deepEqual(google.badAuth, []);
    assert.deepEqual(dav.badAuth, []);
  });

  it("offers no calendar tool and says nothing about one when no account is connected", opts, async () => {
    model.enqueue(say("Hi."));
    await boot(false);
    channel.push(inbound("m1", "hello"));
    await channel.sentCount(1);
    const first = model.requests[0];
    assert.ok(!(first?.tools ?? []).some((tool) => /^(calendar|contacts)_/.test(tool.function.name)));
    assert.doesNotMatch(JSON.stringify(first), /calendar_list|contacts_find|untrusted/);
  });

  it("creates an event in the account the model names", opts, async () => {
    model.enqueue(call("calendar_create", { title: "Lunch with Asha", start: "2026-10-30T13:00", calendar: "icloud" }), say("Added."));
    await boot();
    channel.push(inbound("m1", "add lunch with Asha Friday 1pm to my iCloud calendar"));
    await channel.sentCount(1);
    assert.equal(dav.calendarObjects.length, 1);
    assert.match(dav.calendarObjects[0]?.data ?? "", /SUMMARY:Lunch with Asha/);
    assert.equal(google.seen.filter((entry) => entry.method === "POST").length, 0);
  });

  it("finds a phone number from either contacts account", opts, async () => {
    google.contacts = [{ person: { names: [{ displayName: "Asha Rao" }], phoneNumbers: [{ value: "+91 98765 43210" }] } }];
    model.enqueue(call("contacts_find", { query: "Asha" }), say("Asha Rao: +91 98765 43210."));
    await boot();
    channel.push(inbound("m1", "find Asha's number"));
    await channel.sentCount(1);
    assert.match(flatten(model.requests[1] as never), /\[google\] Asha Rao \| phone: \+91 98765 43210/);
  });
});
