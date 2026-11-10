import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AdvancedIMessage, AuthenticationError } from "@photon-ai/advanced-imessage/grpc";
import { createFindMy, type FindMyDeps, SHARED_ADDRESS } from "../src/findmy.ts";

type Calls = { issued: number; opened: { address: string; token: string }[]; closed: number; gets: string[]; requests: { chat: string; address: string }[] };

function rig(overrides: { issueGate?: Promise<void>; type?: "shared" | "dedicated"; get?: () => Promise<unknown>; request?: () => Promise<unknown> } = {}) {
  const calls: Calls = { issued: 0, opened: [], closed: 0, gets: [], requests: [] };
  const clock = 1_000_000;
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const deps: FindMyDeps = {
    now: () => clock,
    sharedAddress: SHARED_ADDRESS,
    issue: async () => {
      await overrides.issueGate;
      calls.issued += 1;
      return overrides.type === "dedicated"
        ? { type: "dedicated", auth: { abc123: `tok-${calls.issued}` }, numbers: { abc123: "+10000000000" }, expiresIn: 3600 }
        : { type: "shared", token: `tok-${calls.issued}`, expiresIn: 3600 };
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
  return { find, calls, logs };
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

  it("issues a new token and tries once more when a call is refused as unauthenticated", async () => {
    let refused = true;
    const { find, calls } = rig({
      get: async () => {
        if (refused) {
          refused = false;
          throw new AuthenticationError("token expired", { code: "UNAUTHENTICATED", grpcCode: 16, retryable: false, context: {} } as never);
        }
        return { latitude: 1, longitude: 2, locationType: "live" };
      },
    });
    assert.equal((await find.current())?.latitude, 1);
    assert.deepEqual(calls.opened.map((entry) => entry.token), ["tok-1", "tok-2"]);
    assert.equal(calls.closed, 1);
  });

  it("makes the second refusal a failure instead of issuing a third token", async () => {
    let gets = 0;
    const { find, calls } = rig({
      get: async () => {
        gets += 1;
        if (gets > 2) throw new Error("a third call must not happen");
        throw new AuthenticationError("token expired", { code: "UNAUTHENTICATED", grpcCode: 16, retryable: false, context: {} } as never);
      },
    });
    assert.equal(await find.current(), undefined);
    assert.equal(gets, 2);
    assert.deepEqual(calls.opened.map((entry) => entry.token), ["tok-1", "tok-2"]);
    assert.equal(calls.issued, 2);
    assert.equal(calls.closed, 1);
  });

  it("keeps one client across calls and does not renew for other failures", async () => {
    const { find, calls } = rig({
      get: async () => {
        throw new Error("down");
      },
    });
    await find.current();
    await find.current();
    assert.equal(calls.issued, 1);
    assert.equal(calls.closed, 0);
  });

  it("does not wait for a token still being issued, and opens no client once closed", async () => {
    let finish!: () => void;
    const { find, calls } = rig({ issueGate: new Promise<void>((resolve) => (finish = resolve)) });
    const pending = find.current();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      find.close().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1000);
      }),
    ]);
    clearTimeout(timer);
    assert.equal(closed, true);
    assert.equal(calls.issued, 0);
    finish();
    assert.equal(await pending, undefined);
    assert.equal(calls.issued, 1);
    assert.deepEqual(calls.opened, []);
  });

  it("ignores coordinates with no timestamp unless the location is live", async () => {
    const stale = rig({ get: async () => ({ latitude: 1, longitude: 2, locationType: "legacy" }) });
    assert.equal(await stale.find.current(), undefined);
    const live = rig({ get: async () => ({ latitude: 1, longitude: 2, locationType: "live" }) });
    assert.deepEqual(await live.find.current(), { latitude: 1, longitude: 2, label: null, at: 1_000_000 });
  });

  it("closes its client on close", async () => {
    const { find, calls } = rig();
    await find.current();
    await find.close();
    assert.equal(calls.closed, 1);
  });
});
