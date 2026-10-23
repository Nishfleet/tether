import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { icloudBackends } from "../../src/calendar/icloud.ts";
import { APP_PASSWORD, APPLE_ID, FakeDav } from "./fake-dav.ts";

const ZONE = "Asia/Kolkata";

const ical = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Fake//EN\r\n${body}\r\nEND:VCALENDAR\r\n`;

describe("icloud backends against a fake DAV server", () => {
  let dav: FakeDav;

  beforeEach(async () => {
    dav = new FakeDav();
    await dav.start();
  });

  afterEach(async () => {
    await dav.stop();
  });

  const open = (password = APP_PASSWORD) =>
    icloudBackends({ appleId: APPLE_ID, appPassword: password }, ZONE, { caldavUrl: dav.url, carddavUrl: dav.url });

  it("lists timed and all-day events with the title, place and guest count", async () => {
    dav.calendarObjects.push(
      {
        name: "a.ics",
        data: ical(
          "BEGIN:VEVENT\r\nUID:a\r\nDTSTAMP:20261020T000000Z\r\nDTSTART:20261024T073000Z\r\nDTEND:20261024T083000Z\r\nSUMMARY:Standup\r\nLOCATION:Room 4\r\nATTENDEE:mailto:x@example.test\r\nEND:VEVENT",
        ),
      },
      { name: "b.ics", data: ical("BEGIN:VEVENT\r\nUID:b\r\nDTSTAMP:20261020T000000Z\r\nDTSTART;VALUE=DATE:20261024\r\nDTEND;VALUE=DATE:20261025\r\nSUMMARY:Holiday\r\nEND:VEVENT") },
    );
    const events = await open().calendar[0]!.list(new Date("2026-10-23T18:30:00Z"), new Date("2026-10-24T18:30:00Z"));
    assert.deepEqual(
      events.map((event) => [event.title, event.allDay, event.start.toISOString(), event.end.toISOString(), event.location, event.attendees]).sort(),
      [
        ["Holiday", true, "2026-10-23T18:30:00.000Z", "2026-10-24T18:30:00.000Z", "", 0],
        ["Standup", false, "2026-10-24T07:30:00.000Z", "2026-10-24T08:30:00.000Z", "Room 4", 1],
      ],
    );
    assert.deepEqual(dav.badAuth, []);
  });

  it("reads a floating time in the configured timezone, not the host's", async () => {
    dav.calendarObjects.push({ name: "f.ics", data: ical("BEGIN:VEVENT\r\nUID:f\r\nDTSTAMP:20261020T000000Z\r\nDTSTART:20261024T130000\r\nDTEND:20261024T140000\r\nSUMMARY:Floating\r\nEND:VEVENT") });
    const [event] = await open().calendar[0]!.list(new Date("2026-10-23T18:30:00Z"), new Date("2026-10-24T18:30:00Z"));
    assert.equal(event?.start.toISOString(), "2026-10-24T07:30:00.000Z");
    assert.equal(event?.end.toISOString(), "2026-10-24T08:30:00.000Z");
  });

  it("shows each expanded occurrence of a repeating event", async () => {
    const occurrence = (day: string) =>
      `BEGIN:VEVENT\r\nUID:r\r\nRECURRENCE-ID:${day}T043000Z\r\nDTSTAMP:20261020T000000Z\r\nDTSTART:${day}T043000Z\r\nDTEND:${day}T050000Z\r\nSUMMARY:Gym\r\nEND:VEVENT`;
    dav.calendarObjects.push({ name: "r.ics", data: ical(`${occurrence("20261024")}\r\n${occurrence("20261025")}`) });
    const events = await open().calendar[0]!.list(new Date("2026-10-23T18:30:00Z"), new Date("2026-10-26T18:30:00Z"));
    assert.deepEqual(events.map((entry) => entry.start.toISOString()), ["2026-10-24T04:30:00.000Z", "2026-10-25T04:30:00.000Z"]);
  });

  it("keeps an event with no end time that starts exactly at the window start", async () => {
    dav.calendarObjects.push({ name: "z.ics", data: ical("BEGIN:VEVENT\r\nUID:z\r\nDTSTAMP:20261020T000000Z\r\nDTSTART:20261023T183000Z\r\nSUMMARY:Ping\r\nEND:VEVENT") });
    const events = await open().calendar[0]!.list(new Date("2026-10-23T18:30:00Z"), new Date("2026-10-24T18:30:00Z"));
    assert.deepEqual(events.map((entry) => entry.title), ["Ping"]);
  });

  it("skips one broken object instead of losing the whole account", async () => {
    dav.calendarObjects.push(
      { name: "bad.ics", data: "this is not a calendar" },
      { name: "ok.ics", data: ical("BEGIN:VEVENT\r\nUID:o\r\nDTSTAMP:20261020T000000Z\r\nDTSTART:20261024T073000Z\r\nDTEND:20261024T083000Z\r\nSUMMARY:Fine\r\nEND:VEVENT") },
    );
    dav.cards.push({ name: "bad.vcf", data: "garbage" }, { name: "ok.vcf", data: "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Asha Rao\r\nN:Rao;Asha;;;\r\nEND:VCARD\r\n" });
    const backends = open();
    assert.deepEqual((await backends.calendar[0]!.list(new Date("2026-10-23T18:30:00Z"), new Date("2026-10-24T18:30:00Z"))).map((entry) => entry.title), ["Fine"]);
    assert.deepEqual((await backends.contacts[0]!.find("asha")).map((person) => person.name), ["Asha Rao"]);
  });

  it("skips calendars that hold no events, such as reminders", async () => {
    await open().calendar[0]!.list(new Date("2026-10-23T18:30:00Z"), new Date("2026-10-24T18:30:00Z"));
    assert.deepEqual(dav.requests.filter((line) => line.startsWith("REPORT")), ["REPORT /calendars/home/"]);
  });

  it("writes an event the server can read back, with guests when asked", async () => {
    const backend = open().calendar[0]!;
    await backend.create({
      title: "Lunch",
      start: new Date("2026-10-30T07:30:00Z"),
      end: new Date("2026-10-30T08:30:00Z"),
      allDay: false,
      location: "Cafe",
      attendees: ["friend@example.test"],
    });
    assert.equal(dav.calendarObjects.length, 1);
    const stored = dav.calendarObjects[0]!.data;
    assert.match(stored, /SUMMARY:Lunch/);
    assert.match(stored, /DTSTART:20261030T073000Z/);
    assert.match(stored, /ATTENDEE[^\r\n]*mailto:friend@example.test/);
    const events = await backend.list(new Date("2026-10-30T00:00:00Z"), new Date("2026-10-31T00:00:00Z"));
    assert.equal(events[0]?.title, "Lunch");
  });

  it("writes an all-day event as dates", async () => {
    await open().calendar[0]!.create({
      title: "Trip",
      start: new Date("2026-10-31T18:30:00Z"),
      end: new Date("2026-11-01T18:30:00Z"),
      allDay: true,
      location: undefined,
      attendees: [],
    });
    const stored = dav.calendarObjects[0]!.data;
    assert.match(stored, /DTSTART;VALUE=DATE:20261101/);
    assert.match(stored, /DTEND;VALUE=DATE:20261102/);
    assert.ok(!stored.includes("ATTENDEE"));
  });

  it("finds contacts by name, phone or email and saves new ones", async () => {
    dav.cards.push({ name: "a.vcf", data: "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Asha Rao\r\nN:Rao;Asha;;;\r\nTEL;TYPE=CELL:+91 98765 43210\r\nEMAIL:asha@example.test\r\nEND:VCARD\r\n" });
    const backend = open().contacts[0]!;
    assert.deepEqual(await backend.find("asha"), [{ sources: ["icloud"], name: "Asha Rao", phones: ["+91 98765 43210"], emails: ["asha@example.test"] }]);
    assert.equal((await backend.find("98765")).length, 1);
    assert.equal((await backend.find("nobody")).length, 0);
    await backend.add({ name: "Ravi Kumar", phone: "+91 90000 11111", email: undefined });
    assert.equal(dav.cards.length, 2);
    assert.match(dav.cards[1]!.data, /FN:Ravi Kumar/);
    assert.match(dav.cards[1]!.data, /\r\nN:Kumar;Ravi;;;\r\n/);
    assert.match(dav.cards[1]!.data, /TEL:\+91 90000 11111/);
  });

  it("fails loudly on a wrong app password and tries again on the next call", async () => {
    const backend = open("wrong").calendar[0]!;
    await assert.rejects(backend.list(new Date(), new Date()));
    await assert.rejects(backend.list(new Date(), new Date()));
    assert.ok(dav.badAuth.length >= 2);
  });
});
