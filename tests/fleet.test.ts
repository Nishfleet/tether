import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { startTether, type Tether } from "../src/app.ts";
import { askText } from "../src/approval.ts";
import { loadConfig } from "../src/config.ts";
import { createFleet, DESK, NO_ANSWER, parseOutcome, POLL_LIMIT_MS, runTincan, type Run, type RunResult } from "../src/fleet.ts";
import { createModelAccess } from "../src/model.ts";
import { ALLOWED, FakeChannel, FakeModel, KEY, SPACE, call, inbound, say } from "./helpers.ts";

const opts = { timeout: 30000 };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const REQUEST = "the site is broken on phones";
const ASK = askText(`Send this to the fleet as a job? "${REQUEST}"`);
const LINK = "https://github.com/Nishfleet/site/issues/7";
const said = (code: number, outcome: string, result: Record<string, unknown>): RunResult => ({ code, stdout: `${JSON.stringify({ outcome, result }, null, 2)}\n`, stderr: "" });
const sent = { id: "req-1", to: DESK, body: REQUEST };
const pending = (id = "req-1"): RunResult => said(2, "pending", { request: { ...sent, id }, status: "queued" });
const answered = (reply: string): RunResult => said(0, "answered", { request: sent, status: "answered", reply: { from: DESK, status: "answered", body: reply } });
const refused = (body: string): RunResult => said(1, "failed", { request: sent, status: "failed", reply: { from: DESK, status: "failed", body } });
const unreachable = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr });
const REAL_PENDING = `{
  "outcome": "pending",
  "result": {
    "request": {
      "id": "req-01J8Z9",
      "to": "issue-desk",
      "body": "the site is broken on phones"
    },
    "status": "queued"
  }
}
`;

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

  it("parses the stock ask and get JSON, and takes the state from the exit code", () => {
    assert.deepEqual(parseOutcome({ code: 2, stdout: REAL_PENDING, stderr: "" }), { state: "pending", id: "req-01J8Z9", body: "", replied: false });
    assert.deepEqual(parseOutcome(pending("abc")), { state: "pending", id: "abc", body: "", replied: false });
    assert.deepEqual(parseOutcome(answered(LINK)), { state: "answered", id: "req-1", body: LINK, replied: true });
    assert.equal(parseOutcome(refused("no such repo")).body, "no such repo");
    assert.equal(parseOutcome({ code: 1, stdout: JSON.stringify({ outcome: "failed", result: { request: sent, status: "expired", relay_note: { note: "the target never checked in" } } }), stderr: "" }).body, "the target never checked in");
    assert.equal(parseOutcome({ code: 1, stdout: "", stderr: "nobody home" }).body, "nobody home");
    assert.deepEqual(parseOutcome(unreachable("nobody home")), { state: "failed", id: undefined, body: "nobody home", replied: false });
  });
});

describe("tincan runner", () => {
  it("runs the argv array with the identity in TINCAN_CONFIG and reads the stock JSON", async () => {
    const home = mkdtempSync(join(tmpdir(), "tether-run-"));
    try {
      const bin = join(home, "tincan");
      const script = '#!/bin/sh\n[ -n "$TINCAN_CONFIG" ] || exit 9\ndir=${TINCAN_CONFIG%/*}\nprintf \'%s\\n\' "$@" > "$dir/args"\nprintf \'%s\\n\' "$TINCAN_CONFIG" > "$dir/config"\ncat "$dir/reply"\n';
      writeFileSync(bin, script, { mode: 0o755 });
      writeFileSync(join(home, "reply"), answered(LINK).stdout);
      const env = { TINCAN_CONFIG: join(home, "identity.json"), PATH: process.env.PATH ?? "", HOME: home };
      const argv = ["ask", DESK, "--json", "--wait", "20s", "--", REQUEST];
      const result = await runTincan(bin, argv, env);
      assert.equal(result.code, 0);
      assert.deepEqual(parseOutcome(result), { state: "answered", id: "req-1", body: LINK, replied: true });
      assert.equal(readFileSync(join(home, "args"), "utf8"), `${argv.join("\n")}\n`);
      assert.equal(readFileSync(join(home, "config"), "utf8"), `${env.TINCAN_CONFIG}\n`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("maps an exit 1 with no JSON to a failure with the stderr line, and a missing binary to a rejection", async () => {
    const home = mkdtempSync(join(tmpdir(), "tether-run-"));
    try {
      const bin = join(home, "tincan-fail");
      writeFileSync(bin, "#!/bin/sh\necho 'no relay configured' >&2\nexit 1\n", { mode: 0o755 });
      const env = { TINCAN_CONFIG: join(home, "identity.json"), PATH: process.env.PATH ?? "", HOME: home };
      const result = await runTincan(bin, ["ask", DESK, "--json"], env);
      assert.equal(result.code, 1);
      assert.deepEqual(parseOutcome(result), { state: "failed", id: undefined, body: "no relay configured", replied: false });
      await assert.rejects(runTincan(join(home, "missing"), ["ask", DESK], env));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
    assert.deepEqual(channel.sent.slice(1).map((entry) => entry.text).sort(), [NO_ANSWER("req-3"), "Sent."].sort());
    assert.ok(clock >= POLL_LIMIT_MS);
    assert.ok(calls.length < 30, "backs off instead of polling every few seconds");
  });

  it("texts the refusal as one line", opts, async () => {
    script.push(refused("no such repo"));
    model.enqueue(call("fleet_request", { text: REQUEST }), say("The fleet refused this: no such repo"));
    await boot();
    channel.push(inbound("m1", "fix it"));
    await channel.sentCount(1);
    channel.push(inbound("m2", "yes"));
    await channel.sentCount(2);
    const result = JSON.stringify(model.requests[1]?.messages);
    assert.match(result, /The fleet refused this: no such repo/);
  });

  it("texts a transport failure as a failure, not a refusal", opts, async () => {
    script.push(unreachable("no relay configured"));
    model.enqueue(call("fleet_request", { text: REQUEST }), say("I could not reach the fleet."));
    await boot();
    channel.push(inbound("m1", "fix it"));
    await channel.sentCount(1);
    channel.push(inbound("m2", "yes"));
    await channel.sentCount(2);
    const result = JSON.stringify(model.requests[1]?.messages);
    assert.match(result, /The fleet could not take the request: no relay configured/);
    assert.doesNotMatch(result, /refused/);
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
