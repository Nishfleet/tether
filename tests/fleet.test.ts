import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { startTether, type Tether } from "../src/app.ts";
import { askText } from "../src/approval.ts";
import { loadConfig } from "../src/config.ts";
import { createFleet, NO_ANSWER, parseOutcome, POLL_LIMIT_MS, type Run, type RunResult } from "../src/fleet.ts";
import { createModelAccess } from "../src/model.ts";
import { ALLOWED, FakeChannel, FakeModel, KEY, SPACE, call, inbound, say } from "./helpers.ts";

const opts = { timeout: 30000 };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const REQUEST = "the site is broken on phones";
const ASK = askText(`Send this to the fleet as a job? "${REQUEST}"`);
const LINK = "https://github.com/Nishfleet/site/issues/7";
const pending = (id = "req-1"): RunResult => ({ code: 2, stdout: JSON.stringify({ id }), stderr: "" });
const answered = (reply: string): RunResult => ({ code: 0, stdout: JSON.stringify({ reply }), stderr: "" });

describe("fleet config", () => {
  const base = { TETHER_ALLOWED_SENDER: "a", TETHER_LLM_API_KEY: "k", TETHER_STATE_DIR: "/state" };

  it("has no tool unless both the identity file and the binary are set", () => {
    assert.equal(loadConfig(base).tincan, undefined);
    assert.equal(loadConfig({ ...base, TETHER_TINCAN_CONFIG: "/etc/tether/tincan.json" }).tincan, undefined);
    assert.equal(loadConfig({ ...base, TETHER_TINCAN_BIN: "/usr/bin/tincan" }).tincan, undefined);
    assert.equal(loadConfig({ ...base, TETHER_TINCAN_BIN: "/usr/bin/tincan", TETHER_TINCAN_CONFIG: " " }).tincan, undefined);
    assert.deepEqual(loadConfig({ ...base, TETHER_TINCAN_BIN: "/usr/bin/tincan", TETHER_TINCAN_CONFIG: "/etc/tether/tincan.json" }).tincan, {
      bin: "/usr/bin/tincan",
      config: "/etc/tether/tincan.json",
    });
  });

  it("parses the exit code as the state and finds the id and the reply", () => {
    assert.deepEqual(parseOutcome(pending("abc")), { state: "pending", id: "abc", body: "" });
    assert.deepEqual(parseOutcome(answered(LINK)), { state: "answered", id: undefined, body: LINK });
    assert.equal(parseOutcome({ code: 1, stdout: "", stderr: "nobody home" }).body, "nobody home");
  });
});

describe("fleet_request, in process", () => {
  let dir: string;
  let model: FakeModel;
  let channel: FakeChannel;
  let tether: Tether | undefined;
  let calls: { args: readonly string[]; env: Record<string, string> }[];
  let script: RunResult[];
  let clock: number;
  let hold: Promise<void> | undefined;

  const run: Run = async (_bin, args, env) => {
    calls.push({ args, env });
    if (args[0] === "get") await hold;
    return script.shift() ?? { code: 1, stdout: "", stderr: "script ran out" };
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tether-fleet-"));
    model = new FakeModel();
    await model.start();
    channel = new FakeChannel();
    calls = [];
    script = [];
    clock = 0;
    hold = undefined;
  });

  afterEach(async () => {
    await tether?.stop();
    tether = undefined;
    await model.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(): Promise<void> {
    const { models, ref } = createModelAccess({ baseUrl: model.url, apiKey: KEY });
    const fleet = createFleet({ bin: "/bin/tincan", config: "/etc/tether/tincan.json" }, { channel, log: () => undefined }, {
      run,
      sleep: async (ms) => {
        clock += ms;
        await pause(1);
      },
      now: () => clock,
    });
    tether = await startTether({
      channel,
      models,
      model: ref,
      storage: await openNodeSqliteStorage(join(dir, "t.sqlite")),
      allowedSender: ALLOWED,
      salt: "s",
      log: () => undefined,
      retryBaseMs: 5,
      settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 5 }, stream: { maxRetries: 0 } },
      tools: fleet.tools,
      onStop: () => fleet.halt(),
    });
  }

  it("is not offered to the model without a fleet", opts, async () => {
    const { models, ref } = createModelAccess({ baseUrl: model.url, apiKey: KEY });
    model.enqueue(say("hi"));
    tether = await startTether({
      channel,
      models,
      model: ref,
      storage: await openNodeSqliteStorage(join(dir, "t.sqlite")),
      allowedSender: ALLOWED,
      salt: "s",
      log: () => undefined,
    });
    channel.push(inbound("m1", "hello"));
    await channel.sentCount(1);
    assert.ok(!model.requests[0]?.tools?.some((tool) => tool.function.name === "fleet_request"));
  });

  it("is offered with the tool and refuses a non-owner: their message never reaches the model", opts, async () => {
    await boot();
    channel.push(inbound("m1", "fix the site", { sender: "stranger@example.test" }));
    await pause(150);
    assert.equal(model.requests.length, 0);
    assert.equal(calls.length, 0);
    model.enqueue(say("ok"));
    channel.push(inbound("m2", "hello"));
    await channel.sentCount(1);
    assert.ok(model.requests[0]?.tools?.some((tool) => tool.function.name === "fleet_request"));
  });

  it("asks yes/no first and sends nothing to tincan until YES", opts, async () => {
    script.push(answered(LINK));
    model.enqueue(call("fleet_request", { text: REQUEST }), say(LINK));
    await boot();
    channel.push(inbound("m1", "the site is broken on phones, fix it"));
    await channel.sentCount(1);
    assert.deepEqual(channel.sent, [{ space: SPACE, text: ASK }]);
    await pause(150);
    assert.equal(calls.length, 0);
    channel.push(inbound("m2", "yes"));
    await channel.sentCount(2);
    assert.deepEqual(channel.sent[1], { space: SPACE, text: LINK });
    assert.deepEqual(calls.map((entry) => entry.args), [["ask", "issue-desk", "--json", "--wait", "20s", "--", REQUEST]]);
    assert.deepEqual(calls.map((entry) => entry.env.TINCAN_CONFIG), ["/etc/tether/tincan.json"]);
  });

  it("sends nothing after NO", opts, async () => {
    model.enqueue(call("fleet_request", { text: REQUEST }), say("Okay, not sent."));
    await boot();
    channel.push(inbound("m1", "fix it"));
    await channel.sentCount(1);
    channel.push(inbound("m2", "no"));
    await channel.sentCount(2);
    assert.equal(calls.length, 0);
  });

  it("does not block the chat: a slow answer is polled in the background and texted when it comes", opts, async () => {
    script.push(pending("req-9"), pending("req-9"), answered(LINK));
    model.enqueue(call("fleet_request", { text: REQUEST }), say("Sent. I will text the link."));
    await boot();
    channel.push(inbound("m1", "fix it"));
    await channel.sentCount(1);
    channel.push(inbound("m2", "yes"));
    await channel.sentCount(3);
    assert.deepEqual(channel.sent.slice(1).map((entry) => entry.text).sort(), [LINK, "Sent. I will text the link."].sort());
    assert.deepEqual(calls.map((entry) => entry.args.slice(0, 2)), [["ask", "issue-desk"], ["get", "req-9"], ["get", "req-9"]]);
  });

  it("texts the timeout line with the request id after 10 minutes of waiting", opts, async () => {
    script.push(pending("req-3"));
    for (let index = 0; index < 100; index += 1) script.push(pending("req-3"));
    model.enqueue(call("fleet_request", { text: REQUEST }), say("Sent."));
    await boot();
    channel.push(inbound("m1", "fix it"));
    await channel.sentCount(1);
    channel.push(inbound("m2", "yes"));
    await channel.sentCount(3);
    assert.deepEqual(channel.sent[2], { space: SPACE, text: NO_ANSWER("req-3") });
    assert.ok(clock >= POLL_LIMIT_MS);
    assert.ok(calls.length < 30, "backs off instead of polling every few seconds");
  });

  it("texts the refusal as one line", opts, async () => {
    script.push({ code: 1, stdout: JSON.stringify({ error: "no such repo" }), stderr: "" });
    model.enqueue(call("fleet_request", { text: REQUEST }), say("The fleet refused this: no such repo"));
    await boot();
    channel.push(inbound("m1", "fix it"));
    await channel.sentCount(1);
    channel.push(inbound("m2", "yes"));
    await channel.sentCount(2);
    const result = JSON.stringify(model.requests[1]?.messages);
    assert.match(result, /The fleet refused this: no such repo/);
  });

  it("STOP cancels a pending confirmation, so tincan is never run", opts, async () => {
    model.enqueue(call("fleet_request", { text: REQUEST }), say("never"));
    await boot();
    channel.push(inbound("m1", "fix it"));
    await channel.sentCount(1);
    channel.push(inbound("m2", "stop"));
    await channel.sentCount(2);
    channel.push(inbound("m3", "yes"));
    await pause(150);
    assert.equal(calls.length, 0);
  });

  it("STOP while polling drops the late answer", opts, async () => {
    let release = () => {};
    hold = new Promise<void>((resolve) => (release = resolve));
    script.push(pending("req-5"), answered(LINK));
    model.enqueue(call("fleet_request", { text: REQUEST }), say("Sent."));
    await boot();
    channel.push(inbound("m1", "fix it"));
    await channel.sentCount(1);
    channel.push(inbound("m2", "yes"));
    await channel.sentCount(2);
    channel.push(inbound("m3", "stop"));
    await channel.sentCount(3);
    release();
    await pause(300);
    assert.ok(!channel.sent.some((entry) => entry.text === LINK));
  });
});
