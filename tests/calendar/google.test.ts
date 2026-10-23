import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { googleBackends, GOOGLE_SCOPES } from "../../src/calendar/google.ts";
import { ACCESS_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeGoogle, REFRESH_TOKEN } from "./fake-google.ts";

const ZONE = "Asia/Kolkata";

describe("google backends against a fake API", () => {
  let google: FakeGoogle;

  beforeEach(async () => {
    google = new FakeGoogle();
    await google.start();
  });

  afterEach(async () => {
    await google.stop();
  });

  const open = () =>
    googleBackends({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN }, ZONE, {
      tokenUrl: `${google.url}token`,
      calendarRoot: google.url,
      peopleRoot: google.url,
    });

  it("trades the refresh token for an access token and uses it", async () => {
    await open().calendar[0]!.list(new Date("2026-10-23T18:30:00Z"), new Date("2026-10-24T18:30:00Z"));
    assert.equal(google.tokenForms[0]?.get("grant_type"), "refresh_token");
    assert.equal(google.tokenForms[0]?.get("refresh_token"), REFRESH_TOKEN);
    assert.equal(google.tokenForms[0]?.get("client_id"), CLIENT_ID);
    assert.deepEqual(google.badAuth, []);
  });

  it("lists events from every selected calendar and maps timed and all-day events", async () => {
    google.eventsByCalendar = {
      primary: [
        { summary: "Standup", start: { dateTime: "2026-10-24T13:00:00+05:30" }, end: { dateTime: "2026-10-24T14:00:00+05:30" }, location: "Room 4", attendees: [{ email: "me@example.test", self: true }, { email: "a@example.test" }] },
        { summary: "Dropped", status: "cancelled", start: { dateTime: "2026-10-24T13:00:00+05:30" }, end: { dateTime: "2026-10-24T14:00:00+05:30" } },
      ],
      family: [{ summary: "Holiday", start: { date: "2026-10-24" }, end: { date: "2026-10-25" } }],
      hidden: [{ summary: "Never", start: { date: "2026-10-24" }, end: { date: "2026-10-25" } }],
    };
    const events = await open().calendar[0]!.list(new Date("2026-10-23T18:30:00Z"), new Date("2026-10-24T18:30:00Z"));
    assert.deepEqual(
      events.map((event) => [event.title, event.allDay, event.start.toISOString(), event.end.toISOString(), event.location, event.attendees]),
      [
        ["Standup", false, "2026-10-24T07:30:00.000Z", "2026-10-24T08:30:00.000Z", "Room 4", 1],
        ["Holiday", true, "2026-10-23T18:30:00.000Z", "2026-10-24T18:30:00.000Z", "", 0],
      ],
    );
    const asked = google.seen.filter((entry) => entry.path.endsWith("/events")).map((entry) => entry.path);
    assert.deepEqual(asked, ["/calendar/v3/calendars/primary/events", "/calendar/v3/calendars/family/events"]);
    const first = google.seen.find((entry) => entry.path.endsWith("/events"));
    assert.equal(first?.query.get("singleEvents"), "true");
    assert.equal(first?.query.get("timeMin"), "2026-10-23T18:30:00.000Z");
  });

  it("creates an event with no invitations when nobody is invited", async () => {
    await open().calendar[0]!.create({ title: "Lunch", start: new Date("2026-10-30T07:30:00Z"), end: new Date("2026-10-30T08:30:00Z"), allDay: false, location: "Cafe", attendees: [] });
    const posted = google.seen.find((entry) => entry.method === "POST");
    assert.equal(posted?.path, "/calendar/v3/calendars/primary/events");
    assert.equal(posted?.query.get("sendUpdates"), "none");
    assert.deepEqual(posted?.body, {
      summary: "Lunch",
      location: "Cafe",
      start: { dateTime: "2026-10-30T07:30:00.000Z", timeZone: ZONE },
      end: { dateTime: "2026-10-30T08:30:00.000Z", timeZone: ZONE },
    });
  });

  it("sends invitations only when guests are named", async () => {
    await open().calendar[0]!.create({ title: "Trip", start: new Date("2026-10-31T18:30:00Z"), end: new Date("2026-11-01T18:30:00Z"), allDay: true, location: undefined, attendees: ["friend@example.test"] });
    const posted = google.seen.find((entry) => entry.method === "POST");
    assert.equal(posted?.query.get("sendUpdates"), "all");
    assert.deepEqual(posted?.body, { summary: "Trip", start: { date: "2026-11-01" }, end: { date: "2026-11-02" }, attendees: [{ email: "friend@example.test" }] });
  });

  it("finds contacts after warming the search index, and saves new ones", async () => {
    google.contacts = [{ person: { names: [{ displayName: "Asha Rao" }], phoneNumbers: [{ value: "+91 98765 43210" }], emailAddresses: [{ value: "asha@example.test" }] } }];
    const backend = open().contacts[0]!;
    assert.deepEqual(await backend.find("asha"), [{ sources: ["google"], name: "Asha Rao", phones: ["+91 98765 43210"], emails: ["asha@example.test"] }]);
    assert.deepEqual(
      google.seen.filter((entry) => entry.path === "/v1/people:searchContacts").map((entry) => entry.query.get("query")),
      ["", "asha"],
    );
    await backend.add({ name: "Ravi Kumar", phone: "+91 90000 11111", email: undefined });
    const created = google.seen.find((entry) => entry.path === "/v1/people:createContact");
    assert.deepEqual(created?.body, { names: [{ unstructuredName: "Ravi Kumar" }], phoneNumbers: [{ value: "+91 90000 11111" }] });
  });

  it("asks only for the narrow scopes", () => {
    assert.deepEqual([...GOOGLE_SCOPES], [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/contacts",
    ]);
    assert.ok(ACCESS_TOKEN);
  });
});
