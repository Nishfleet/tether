import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ASK_TEXT } from "../src/location.ts";
import { PLACES_HOST, PLACES_URL } from "../src/places.ts";
import { REMINDER_PREFIX } from "../src/reminders.ts";
import { STOPPED_TEXT } from "../src/app.ts";
import { call, flatten, inbound, say } from "./helpers.ts";
import { Rig } from "./rig.ts";

const opts = { timeout: 30000 };

const here = { current: async () => ({ latitude: 12.9689, longitude: 77.5842, label: "Current Location", at: Date.now() }), request: async () => true };

type Seen = { url: string; init: { headers: Record<string, string>; redirect: string } };

const photon = (features: unknown[], seen: Seen[] = []) => async (url: string, init: Seen["init"]) => {
  seen.push({ url, init });
  return new Response(JSON.stringify({ type: "FeatureCollection", features }), { status: 200, headers: { "content-type": "application/json" } });
};

const feature = (name: string, lat: number, lon: number, extra: Record<string, unknown> = {}) => ({
  type: "Feature",
  properties: { name, osm_value: "cafe", street: "Test Road", city: "Testville", ...extra },
  geometry: { type: "Point", coordinates: [lon, lat] },
});

describe("reminders", () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = new Rig();
    await rig.open();
  });
  afterEach(() => rig.close());

  it("texts the reminder at the due time and clears it from the list", opts, async () => {
    rig.model.enqueue(call("reminder_set", { text: "call mum", inMinutes: 0.03 }), say("Set."));
    await rig.boot();
    rig.channel.push(inbound("m1", "remind me to call mum shortly"));
    await rig.channel.sentCount(1);
    assert.equal(rig.texts()[0], "Set.");
    assert.match(flatten(rig.model.requests[1] as never), /Reminder r1 set for/);
    await rig.channel.sentCount(2);
    assert.equal(rig.texts()[1], `${REMINDER_PREFIX}call mum`);
    rig.model.enqueue(call("reminder_list", {}), say("none"));
    rig.channel.push(inbound("m2", "what reminders do I have"));
    await rig.channel.sentCount(3);
    assert.match(flatten(rig.model.requests.at(-1) as never), /No pending reminders/);
  });

  it("lists a pending reminder in the owner's time zone and cancels it", opts, async () => {
    rig.model.enqueue(call("reminder_set", { text: "dentist", at: "2099-01-02T09:30:00+05:30" }), say("Set."));
    await rig.boot({ timeZone: "Asia/Kolkata" });
    rig.channel.push(inbound("m1", "remind me about the dentist"));
    await rig.channel.sentCount(1);
    rig.model.enqueue(call("reminder_list", {}), say("Listed."));
    rig.channel.push(inbound("m2", "list"));
    await rig.channel.sentCount(2);
    assert.match(flatten(rig.model.requests.at(-1) as never), /r1: Fri, 2 Jan 2099, 09:30 \(Asia\/Kolkata\) - dentist/);
    rig.model.enqueue(call("reminder_cancel", { id: "r1" }), say("Cancelled."), call("reminder_list", {}), say("Empty."));
    rig.channel.push(inbound("m3", "cancel r1"));
    await rig.channel.sentCount(3);
    rig.channel.push(inbound("m4", "list again"));
    await rig.channel.sentCount(4);
    assert.match(flatten(rig.model.requests.at(-1) as never), /No pending reminders/);
  });

  it("never texts a cancelled reminder", opts, async () => {
    rig.model.enqueue(call("reminder_set", { text: "ghost", inMinutes: 0.03 }), say("Set."), call("reminder_cancel", { id: "r1" }), say("Cancelled."));
    await rig.boot();
    rig.channel.push(inbound("m1", "set"));
    await rig.channel.sentCount(1);
    rig.channel.push(inbound("m2", "cancel"));
    await rig.channel.sentCount(2);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    assert.deepEqual(rig.texts(), ["Set.", "Cancelled."]);
  });

  it("rejects a time in the past, a missing time and an at without an offset", opts, async () => {
    rig.model.enqueue(
      call("reminder_set", { text: "a", at: "2001-01-01T00:00:00Z" }),
      call("reminder_set", { text: "b" }),
      call("reminder_set", { text: "c", at: "2099-01-01T10:00:00" }),
      say("done"),
    );
    await rig.boot();
    rig.channel.push(inbound("m1", "bad reminders"));
    await rig.channel.sentCount(1);
    const last = flatten(rig.model.requests.at(-1) as never);
    assert.match(last, /already passed/);
    assert.match(last, /exactly one of inMinutes or at/);
    assert.match(last, /UTC offset/);
  });

  it("drops a reminder that comes due while stopped, and logs it", opts, async () => {
    rig.model.enqueue(call("reminder_set", { text: "later", inMinutes: 0.03 }), say("Set."));
    await rig.boot();
    rig.channel.push(inbound("m1", "remind me"));
    await rig.channel.sentCount(1);
    rig.channel.push(inbound("m2", "STOP"));
    await rig.channel.sentCount(2);
    assert.equal(rig.texts()[1], STOPPED_TEXT);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    await rig.logged("reminder_dropped");
    assert.deepEqual(rig.texts(), ["Set.", STOPPED_TEXT]);
    rig.channel.push(inbound("m3", "RESUME"));
    await rig.channel.sentCount(3);
    assert.deepEqual(rig.texts(), ["Set.", STOPPED_TEXT, "Resumed."]);
  });

  it("answers time_now with the owner's zone", opts, async () => {
    rig.model.enqueue(call("time_now", {}), say("ok"));
    await rig.boot({ timeZone: "Asia/Kolkata" });
    rig.channel.push(inbound("m1", "what time is it"));
    await rig.channel.sentCount(1);
    assert.match(flatten(rig.model.requests[1] as never), /\(Asia\/Kolkata\)\. ISO 8601: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30/);
  });
});

describe("location and nearby places", () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = new Rig();
    await rig.open();
  });
  afterEach(() => rig.close());

  it("sends one text asking for the location, then tells the owner", opts, async () => {
    rig.model.enqueue(call("location_request", {}), say("I asked you to share it."));
    await rig.boot();
    rig.channel.push(inbound("m1", "coffee near me"));
    await rig.channel.sentCount(2);
    assert.deepEqual(rig.texts().sort(), [ASK_TEXT, "I asked you to share it."].sort());
  });

  it("asks with a Find My request card when it can, and falls back to a text when it cannot", opts, async () => {
    const requested: string[] = [];
    rig.model.enqueue(call("location_request", {}), say("I sent a request."), call("location_request", {}), say("I asked by text."));
    rig.channel.locations = {
      current: async () => undefined,
      request: async (space) => {
        requested.push(space);
        return requested.length === 1;
      },
    };
    await rig.boot();
    rig.channel.push(inbound("m1", "where am I"));
    await rig.channel.sentCount(1);
    assert.deepEqual(rig.texts(), ["I sent a request."]);
    assert.deepEqual(requested, ["space-1"]);
    rig.channel.push(inbound("m2", "again"));
    await rig.channel.sentCount(3);
    assert.deepEqual(rig.texts().slice(1).sort(), [ASK_TEXT, "I asked by text."].sort());
  });

  it("uses the Find My location for nearby places and says where it came from", opts, async () => {
    const seen: Seen[] = [];
    rig.channel.locations = { current: async () => ({ latitude: 12.9689, longitude: 77.5842, label: "Indiranagar", at: Date.now() - 60_000 }), request: async () => true };
    rig.model.enqueue(call("places_nearby", { query: "coffee" }), say("Here."));
    await rig.boot({ fetch: photon([feature("Near Coffee", 12.9692, 77.5843)], seen) });
    rig.channel.push(inbound("m1", "coffee near me"));
    await rig.channel.sentCount(1);
    const result = flatten(rig.model.requests.at(-1) as never);
    assert.match(result, /Find My location from 1 min ago/);
    assert.match(result, /Near Coffee/);
    assert.equal(new URL(seen[0]?.url ?? "").searchParams.get("lat"), "12.9689");
  });

  it("reads the Find My location with its age", opts, async () => {
    rig.channel.locations = here;
    rig.model.enqueue(call("location_last", {}), say("Seen."));
    await rig.boot();
    rig.channel.push(inbound("m1", "where am I"));
    await rig.channel.sentCount(1);
    assert.match(flatten(rig.model.requests.at(-1) as never), /12\.96890, 77\.58420 \(Current Location\), (just now|\d+ min ago)/);
  });

  it("says so when nobody is sharing a location", opts, async () => {
    rig.channel.locations = { current: async () => undefined, request: async () => true };
    rig.model.enqueue(call("location_last", {}), say("Nothing."));
    await rig.boot();
    rig.channel.push(inbound("m1", "where am I"));
    await rig.channel.sentCount(1);
    assert.match(flatten(rig.model.requests.at(-1) as never), /No location yet/);
  });

  it("answers 'coffee near me' with real-looking places sorted by distance, through the one lookup host", opts, async () => {
    const seen: Seen[] = [];
    rig.channel.locations = here;
    rig.model.enqueue(call("places_nearby", { query: "coffee" }), say("Here are some."));
    await rig.boot({
      fetch: photon(
        [feature("Far Coffee", 12.975, 77.5842), feature("Near Coffee", 12.9692, 77.5843), feature("Too Far Coffee", 13.5, 77.9), feature("Near Coffee", 12.9692, 77.5843)],
        seen,
      ),
    });
    rig.channel.push(inbound("m1", "coffee near me"));
    await rig.channel.sentCount(1);
    const toolResult = flatten(rig.model.requests.at(-1) as never);
    assert.match(toolResult, /2 result\(s\) for \\"coffee\\"/);
    assert.ok(toolResult.indexOf("Near Coffee") < toolResult.indexOf("Far Coffee"));
    assert.doesNotMatch(toolResult, /Too Far/);
    assert.match(toolResult, /OpenStreetMap contributors/);
    assert.equal(seen.length, 1);
    const url = new URL(seen[0]?.url ?? "");
    assert.equal(url.origin, new URL(PLACES_URL).origin);
    assert.equal(url.hostname, PLACES_HOST);
    assert.equal(url.searchParams.get("q"), "coffee");
    assert.equal(url.searchParams.get("lat"), "12.9689");
    assert.equal(seen[0]?.init.redirect, "error");
  });

  it("tells the model when no location is saved, and never calls the lookup", opts, async () => {
    const seen: Seen[] = [];
    rig.model.enqueue(call("places_nearby", { query: "coffee" }), say("Share your location."));
    await rig.boot({ fetch: photon([], seen) });
    rig.channel.push(inbound("m1", "coffee near me"));
    await rig.channel.sentCount(1);
    assert.match(flatten(rig.model.requests[1] as never), /No known location/);
    assert.equal(seen.length, 0);
  });

  it("searches around a named place without a saved location", opts, async () => {
    const seen: Seen[] = [];
    let call_ = 0;
    const fetcher = async (url: string, init: Seen["init"]) => {
      call_ += 1;
      return call_ === 1 ? photon([feature("Indiranagar", 12.9784, 77.6408, { city: "Bengaluru" })], seen)(url, init) : photon([feature("Blue Tokai", 12.9786, 77.6409)], seen)(url, init);
    };
    rig.model.enqueue(call("places_nearby", { query: "cafe", near: "Indiranagar" }), say("Found one."));
    await rig.boot({ fetch: fetcher });
    rig.channel.push(inbound("m1", "cafe near Indiranagar"));
    await rig.channel.sentCount(1);
    assert.match(flatten(rig.model.requests[1] as never), /Blue Tokai/);
    assert.equal(seen.length, 2);
    for (const entry of seen) assert.equal(new URL(entry.url).hostname, PLACES_HOST);
  });

  it("says so when a named place is not found", opts, async () => {
    rig.model.enqueue(call("places_nearby", { query: "cafe", near: "Nowhereville" }), say("No such place."));
    await rig.boot({ fetch: photon([]) });
    rig.channel.push(inbound("m1", "cafe near Nowhereville"));
    await rig.channel.sentCount(1);
    assert.match(flatten(rig.model.requests[1] as never), /Could not find a place called Nowhereville/);
  });

  it("reports a failed lookup to the model without crashing", opts, async () => {
    rig.channel.locations = here;
    rig.model.enqueue(call("places_nearby", { query: "coffee" }), say("Lookup failed, sorry."));
    await rig.boot({
      fetch: async () => {
        throw new Error("network down");
      },
    });
    rig.channel.push(inbound("m1", "coffee near me"));
    await rig.channel.sentCount(1);
    assert.match(flatten(rig.model.requests.at(-1) as never), /places lookup failed/i);
    assert.ok(rig.logs.some((entry) => entry.event === "places_failed"));
  });
});
