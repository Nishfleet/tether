import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { startTether, type Tether, STOPPED_TEXT, RESUMED_TEXT } from "../src/app.ts";
import { createModelAccess } from "../src/model.ts";
import { FAILURE_TEXT } from "../src/reply.ts";
import { ALLOWED, FakeChannel, FakeModel, KEY, SPACE, call, fail, flatten, hold, inbound, say } from "./helpers.ts";

const opts = { timeout: 30000 };

describe("tether app, in process", () => {
  let dir: string;
  let model: FakeModel;
  let channel: FakeChannel;
  let tether: Tether | undefined;
  let logs: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tether-"));
    model = new FakeModel();
    await model.start();
    channel = new FakeChannel();
    logs = [];
  });

  afterEach(async () => {
    await tether?.stop();
    tether = undefined;
    await model.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const logWaiters: { event: string; resolve: () => void }[] = [];

  function logged(event: string): Promise<void> {
    if (logs.some((line) => line.includes(`"event":"${event}"`))) return Promise.resolve();
    return new Promise((resolve) => logWaiters.push({ event, resolve }));
  }

  async function boot(retryBaseMs = 5): Promise<Tether> {
    const { models, ref } = createModelAccess({ baseUrl: model.url, apiKey: KEY });
    tether = await startTether({
      channel,
      models,
      model: ref,
      storage: await openNodeSqliteStorage(join(dir, "t.sqlite")),
      allowedSender: ALLOWED,
      salt: "test-salt",
      log: (event, fields) => {
        logs.push(JSON.stringify({ event, ...fields }));
        for (const waiter of logWaiters.splice(0)) {
          if (event === waiter.event) waiter.resolve();
          else logWaiters.push(waiter);
        }
      },
      retryBaseMs,
      settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 5 }, stream: { maxRetries: 0 } },
    });
    return tether;
  }

  it("answers the allowed sender through the router group and replies in the same space", opts, async () => {
    model.enqueue(say("Hello there."));
    await boot();
    channel.push(inbound("m1", "hi tether"));
    await channel.sentCount(1);
    assert.deepEqual(channel.sent, [{ space: SPACE, text: "Hello there." }]);
    assert.equal(model.requests[0]?.model, "assistant");
    assert.deepEqual(model.badAuth, []);
    assert.match(flatten(model.requests[0] as never), /hi tether/);
  });

  it("ignores other senders and group chats without calling the model or replying", opts, async () => {
    model.enqueue(say("should not be used"));
    await boot();
    channel.push(inbound("x1", "secret words", { sender: "stranger@example.test" }));
    channel.push(inbound("x2", "STOP", { sender: "stranger@example.test" }));
    channel.push(inbound("x3", "group words", { direct: false }));
    channel.push(inbound("x4", undefined));
    channel.push(inbound("m1", "real message"));
    await channel.sentCount(1);
    assert.equal(model.requests.length, 1);
    assert.match(flatten(model.requests[0] as never), /real message/);
    assert.doesNotMatch(flatten(model.requests[0] as never), /secret words|group words/);
    assert.equal(channel.sent.length, 1);
    const ignored = logs.filter((line) => line.includes('"ignored"'));
    assert.equal(ignored.length, 4);
    const everything = logs.join("\n");
    assert.doesNotMatch(everything, /secret words|group words|real message|stranger@example|owner@example/);
  });

  it("treats a handle given with formatting as the same sender", opts, async () => {
    model.enqueue(say("ok"));
    await boot();
    channel.push(inbound("m1", "hi", { sender: " Owner@Example.TEST " }));
    await channel.sentCount(1);
  });

  it("does not process a redelivered message twice", opts, async () => {
    model.enqueue(say("once"), say("twice"));
    await boot();
    channel.push(inbound("m1", "hi"));
    channel.push(inbound("m1", "hi"));
    channel.push(inbound("m2", "again"));
    await channel.sentCount(2);
    assert.equal(model.requests.length, 2);
  });

  it("saves a memory note through a tool call and lists it in later requests", opts, async () => {
    model.enqueue(call("memory_save", { note: "prefers oat milk" }), say("Noted."));
    await boot();
    channel.push(inbound("m1", "remember I prefer oat milk"));
    await channel.sentCount(1);
    assert.equal(channel.sent[0]?.text, "Noted.");
    model.enqueue(say("Oat milk."));
    channel.push(inbound("m2", "what do I prefer?"));
    await channel.sentCount(2);
    const last = model.requests.at(-1);
    assert.match(flatten(last as never), /prefers oat milk/);
    assert.match(JSON.stringify(last), /remember I prefer oat milk/);
    const names = (last?.tools ?? []).map((tool) => tool.function.name).sort();
    assert.deepEqual(names, ["memory_forget", "memory_save"]);
  });

  it("STOP aborts the model call and sends nothing for it; RESUME re-asks and replies", opts, async () => {
    model.enqueue(hold());
    await boot();
    channel.push(inbound("m1", "slow question"));
    await model.requestCount(1);
    channel.push(inbound("m2", "STOP"));
    await channel.sentCount(1);
    assert.equal(channel.sent[0]?.text, STOPPED_TEXT);
    await model.closedCount(1);
    assert.deepEqual(model.closed, [0], "the in-flight model request was dropped");
    channel.push(inbound("m3", "are you there"));
    channel.push(inbound("m4", "RESUME"));
    model.enqueue(say("Here is the answer."));
    await channel.sentCount(3);
    const texts = channel.sent.map((entry) => entry.text).sort();
    assert.deepEqual(texts, [RESUMED_TEXT, "Here is the answer.", STOPPED_TEXT].sort());
    assert.equal(model.requests.length, 2, "nothing reached the model while stopped");
    assert.doesNotMatch(JSON.stringify(model.requests[1]), /are you there/);
  });

  it("retries a failing send on a durable sleep and delivers it once", opts, async () => {
    model.enqueue(say("eventually"));
    channel.failures = 2;
    await boot(5);
    channel.push(inbound("m1", "hi"));
    await channel.sentCount(1);
    assert.deepEqual(channel.sent, [{ space: SPACE, text: "eventually" }]);
    assert.equal(logs.filter((line) => line.includes("send_failed")).length, 2);
  });

  it("keeps both notes when one message asks for two saves", opts, async () => {
    model.enqueue(call("memory_save", { note: "likes tea" }), call("memory_save", { note: "allergic to nuts" }), say("Both noted."));
    await boot();
    channel.push(inbound("m1", "remember I like tea and that I am allergic to nuts"));
    await channel.sentCount(1);
    model.enqueue(say("ok"));
    channel.push(inbound("m2", "recall"));
    await channel.sentCount(2);
    const prompt = flatten(model.requests.at(-1) as never);
    assert.match(prompt, /likes tea/);
    assert.match(prompt, /allergic to nuts/);
    const results = JSON.stringify(model.requests[2]?.messages);
    assert.equal((results.match(/Saved as n[0-9a-f]{8}/g) ?? []).length, 2);
  });

  it("drops an exhausted send from the in-flight list so RESUME does not re-ask it", opts, async () => {
    model.enqueue(say("never delivered"));
    channel.failures = 8;
    await boot(1);
    channel.push(inbound("m1", "hi"));
    await logged("send_gave_up");
    assert.equal(channel.failures, 0);
    channel.push(inbound("m2", "STOP"));
    channel.push(inbound("m3", "RESUME"));
    await channel.sentCount(2);
    assert.deepEqual(channel.sent.map((entry) => entry.text).sort(), ["Resumed.", STOPPED_TEXT].sort());
    assert.equal(model.requests.length, 1, "the dead message was not asked again");
  });

  it("logs a salted hash of an ignored sender", opts, async () => {
    await boot();
    channel.push(inbound("x1", "hi", { sender: "stranger@example.test" }));
    channel.push(inbound("m1", "hello"));
    model.enqueue(say("ok"));
    await channel.sentCount(1);
    const line = logs.find((entry) => entry.includes('"ignored"')) ?? "";
    const from = /"from":"([0-9a-f]+)"/.exec(line)?.[1];
    assert.ok(from);
    assert.notEqual(from, createHash("sha256").update("stranger@example.test").digest("hex").slice(0, 8));
  });

  it("sends a fixed apology when the model keeps failing", opts, async () => {
    model.enqueue(fail(), fail(), fail(), fail(), fail(), fail());
    await boot();
    channel.push(inbound("m1", "hi"));
    await channel.sentCount(1);
    assert.equal(channel.sent[0]?.text, FAILURE_TEXT);
  });
});
