import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import { createFindMy, type FindMyDeps, MIN_TOKEN_MS, SHARED_ADDRESS } from "../src/findmy.ts";

type Calls = { issued: number; opened: { address: string; token: string }[]; closed: number; gets: string[]; requests: { chat: string; address: string }[] };

function rig(overrides: { issueGate?: Promise<void>; type?: "shared" | "dedicated"; get?: () => Promise<unknown>; request?: () => Promise<unknown>; expiresIn?: number } = {}) {
  const calls: Calls = { issued: 0, opened: [], closed: 0, gets: [], requests: [] };
  let clock = 1_000_000;
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const deps: FindMyDeps = {
    now: () => clock,
    sharedAddress: SHARED_ADDRESS,
    issue: async () => {
      await overrides.issueGate;
      calls.issued += 1;
      const expiresIn = overrides.expiresIn ?? 3600;
      return overrides.type === "dedicated"
        ? { type: "dedicated", auth: { abc123: `tok-${calls.issued}` }, numbers: { abc123: "+10000000000" }, expiresIn }
        : { type: "shared", token: `tok-${calls.issued}`, expiresIn };
    },
    open: (address, token) => {
      calls.opened.push({ address, token });
      return {
        locations: {
          get: async (who: string) => {
            calls.gets.push(who);
            return (overrides.get ?? (async () => ({ latitude: 12.9689, longitude: 77.5842, locationType: "live", locationTimestamp: new Date(clock - 90_000), shortAddress: "Indiranagar" })))();
          },
          request: async (chat: string, address: string) => {
            calls.requests.push({ chat, address });
            return (overrides.request ?? (async () => ({ status: "sent", address })))();
          },
        },
        close: async () => {
          calls.closed += 1;
        },
      } as unknown as AdvancedIMessage;
    },
  };
  const find = createFindMy({ projectId: "p", projectSecret: "s", owner: "+10000000001", log: (event, fields) => logs.push({ event, fields: { ...fields } }), deps });
  return { find, calls, logs, tick: (ms: number) => (clock += ms) };
}

describe("Find My locations", () => {
  it("reads the owner's location and logs only flags, never coordinates", async () => {
    const { find, calls, logs } = rig();
    assert.deepEqual(await find.current(), { latitude: 12.9689, longitude: 77.5842, label: "Indiranagar", at: 1_000_000 - 90_000 });
    assert.deepEqual(calls.gets, ["+10000000001"]);
    assert.deepEqual(calls.opened, [{ address: SHARED_ADDRESS, token: "tok-1" }]);
    assert.deepEqual(logs, [{ event: "findmy_current", fields: { found: true, type: "live", ageSeconds: 90 } }]);
    assert.doesNotMatch(JSON.stringify(logs), /12\.96|77\.58/);
  });

  it("reuses the client until the token is close to expiring, then opens a new one and closes the old", async () => {
    const { find, calls, tick } = rig({ expiresIn: 100 });
    await find.current();
    await find.current();
    assert.equal(calls.issued, 1);
    tick(Math.max(MIN_TOKEN_MS, 100 * 1000 * 0.8) + 1);
    await find.current();
    assert.equal(calls.issued, 2);
    assert.deepEqual(calls.opened.map((entry) => entry.token), ["tok-1", "tok-2"]);
    assert.equal(calls.closed, 1);
  });

  it("uses the dedicated line address when the project has dedicated lines", async () => {
    const { find, calls } = rig({ type: "dedicated" });
    await find.current();
    assert.deepEqual(calls.opened, [{ address: "abc123.imsg.photon.codes:443", token: "tok-1" }]);
  });

  it("answers undefined when the owner is not sharing, has no coordinates, or the lookup fails", async () => {
    for (const get of [
      async () => {
        throw Object.assign(new Error("not sharing"), { name: "NotFoundError" });
      },
      async () => ({ locationType: "unknown" }),
    ]) {
      const { find, logs } = rig({ get });
      assert.equal(await find.current(), undefined);
      assert.equal(logs.length, 1);
    }
  });

  it("sends a Find My request to the chat id inside the space, and says false when it fails", async () => {
    const ok = rig();
    assert.equal(await ok.find.request(JSON.stringify(["iMessage;-;+10000000001", "+10000000009"])), true);
    assert.deepEqual(ok.calls.requests, [{ chat: "iMessage;-;+10000000001", address: "+10000000001" }]);
    const bad = rig({
      request: async () => {
        throw new Error("refused");
      },
    });
    assert.equal(await bad.find.request(JSON.stringify(["chat", "+1"])), false);
    assert.equal(bad.logs[0]?.event, "findmy_failed");
    assert.equal(await bad.find.request("not json"), false);
  });

  it("issues one token for overlapping calls and never closes a client that is still in use", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { find, calls, tick } = rig({
      expiresIn: 100,
      get: async () => {
        await gate;
        return { latitude: 1, longitude: 2, locationType: "live" };
      },
    });
    const first = Promise.all([find.current(), find.current(), find.current()]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.issued, 1);
    tick(100 * 1000);
    const late = find.current();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.issued, 2);
    assert.equal(calls.closed, 0, "the old client is still in use");
    release();
    const results = await Promise.all([first, late]);
    assert.equal(results[0].every((entry) => entry?.latitude === 1), true);
    assert.equal(results[1]?.latitude, 1);
    assert.equal(calls.closed, 1, "closed once nothing used it");
  });

  it("does not open a client when closed while a token is being issued", async () => {
    let finish!: () => void;
    const { find, calls } = rig({ issueGate: new Promise<void>((resolve) => (finish = resolve)) });
    const pending = find.current();
    await find.close();
    finish();
    assert.equal(await pending, undefined);
    assert.deepEqual(calls.opened, []);
  });

  it("ignores coordinates with no timestamp unless the location is live", async () => {
    const stale = rig({ get: async () => ({ latitude: 1, longitude: 2, locationType: "legacy" }) });
    assert.equal(await stale.find.current(), undefined);
    const live = rig({ get: async () => ({ latitude: 1, longitude: 2, locationType: "live" }) });
    assert.deepEqual(await live.find.current(), { latitude: 1, longitude: 2, label: null, at: 1_000_000 });
  });

  it("refreshes a token that lives less than the old 30 second floor", async () => {
    const { find, calls, tick } = rig({ expiresIn: 10 });
    await find.current();
    tick(8_001);
    await find.current();
    assert.equal(calls.issued, 2);
  });

  it("closes its client on close", async () => {
    const { find, calls } = rig();
    await find.current();
    await find.close();
    assert.equal(calls.closed, 1);
  });
});
