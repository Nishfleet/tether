import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { HarnessSettings } from "@earendil-works/pi-durable";
import { startTether, type Tether, INSTRUCTIONS, STOPPED_TEXT, RESUMED_TEXT } from "../src/app.ts";
import { seedNote } from "./offline.ts";
import { createModelAccess, MAX_OUTPUT_TOKENS } from "../src/model.ts";
import { FAILURE_TEXT, MAX_PART_CHARS, TRUNCATED_MARKER } from "../src/reply.ts";
import { ALLOWED, BACKUP_VIA, FakeChannel, FakeModel, KEY, SPACE, call, cut, fail, flatten, hold, inbound, say, via } from "./helpers.ts";
import { BACK_TEXT, fallbackText, DEFAULT_REASON } from "../src/tier.ts";

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

  async function boot(retryBaseMs = 5, extra: { contextWindow?: number; compaction?: HarnessSettings["compaction"] } = {}): Promise<Tether> {
    const { models, ref } = createModelAccess({ baseUrl: model.url, apiKey: KEY, ...(extra.contextWindow ? { contextWindow: extra.contextWindow } : {}) });
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
      settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 5 }, stream: { maxRetries: 0 }, ...(extra.compaction ? { compaction: extra.compaction } : {}) },
    });
    return tether;
  }

  it("answers the allowed sender through the router group and replies in the same space", opts, async () => {
    model.enqueue(say("Hello there."));
    await boot();
    channel.push(inbound("m1", "hi tether"));
    await channel.sentCount(1);
    assert.deepEqual(channel.sent, [{ space: SPACE, text: "Hello there." }]);
    assert.equal(model.requests[0]?.model, "tether");
    assert.deepEqual(model.badAuth, []);
    assert.match(flatten(model.requests[0] as never), /hi tether/);
  });

  it("asks the router for a long output budget", opts, async () => {
    model.enqueue(say("ok"));
    await boot();
    channel.push(inbound("m1", "hi"));
    await channel.sentCount(1);
    assert.equal(model.requests[0]?.max_tokens, MAX_OUTPUT_TOKENS);
  });

  it("delivers an over-long answer in full, in order, as several sends", opts, async () => {
    const poem = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}: the quiet river keeps on running past the old stone mill`).join("\n");
    assert.ok(poem.length > MAX_PART_CHARS * 3);
    model.enqueue(say(poem));
    await boot();
    channel.push(inbound("m1", "write a 300 line poem"));
    await channel.sentCount(Math.ceil(poem.length / MAX_PART_CHARS));
    await logged("reply_sent");
    assert.ok(channel.sent.length >= 4);
    for (const sent of channel.sent) {
      assert.equal(sent.space, SPACE);
      assert.ok(sent.text.length <= MAX_PART_CHARS);
    }
    assert.equal(channel.sent.map((sent) => sent.text).join("\n"), poem);
  });

  it("keeps the remaining parts when a send fails mid-way", opts, async () => {
    const text = Array.from({ length: 200 }, (_, i) => `Row ${i + 1} of the long answer goes here`).join("\n");
    model.enqueue(say(text));
    await boot();
    channel.failures = 2;
    channel.push(inbound("m1", "long please"));
    await logged("reply_sent");
    assert.equal(logs.filter((line) => line.includes('"send_failed"')).length, 2);
    assert.equal(channel.sent.map((sent) => sent.text).join("\n"), text);
  });

  it("marks an answer that the model cut at its length limit", opts, async () => {
    model.enqueue(cut("Roses are red, and"));
    await boot();
    channel.push(inbound("m1", "poem"));
    await channel.sentCount(1);
    assert.equal(channel.sent[0]?.text, `Roses are red, and\n\n${TRUNCATED_MARKER}`);
  });

  it("tells the model that it cannot send a multi-part reply", () => {
    assert.match(INSTRUCTIONS, /one reply/);
    assert.match(INSTRUCTIONS, /never promise parts/);
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

  it("sends only the last assistant message's text when the model wrote prose beside a tool call", opts, async () => {
    model.enqueue(
      { kind: "toolText", text: "Let me note that.", name: "memory_save", args: { note: "likes tea" } },
      say("Both noted."),
    );
    await boot();
    channel.push(inbound("m1", "remember I like tea"));
    await channel.sentCount(1);
    assert.deepEqual(channel.sent.map((entry) => entry.text), ["Both noted."]);
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

  it("stores a different note under the full digest when the short id is taken", opts, async () => {
    const note = "note B";
    const full = createHash("sha256").update(note).digest("hex");
    await seedNote(join(dir, "t.sqlite"), { id: `n${full.slice(0, 8)}`, text: "an unrelated note", at: 1 });
    model.enqueue(call("memory_save", { note }), call("memory_save", { note }), say("done"));
    await boot();
    channel.push(inbound("m1", "save it"));
    await channel.sentCount(1);
    model.enqueue(say("ok"));
    channel.push(inbound("m2", "recall"));
    await channel.sentCount(2);
    const memory = String(model.requests.at(-1)?.messages[0]?.content).split("\n").filter((line) => /^n[0-9a-f]+: /.test(line));
    assert.deepEqual(memory.sort(), [`n${full.slice(0, 8)}: an unrelated note`, `n${full}: ${note}`].sort());
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

  it("compacts the thread when it crosses a small context window and keeps replying", opts, async () => {
    model.fallback = (request) => (JSON.stringify(request.messages).toLowerCase().includes("summar") && !request.tools ? say("SUMMARY of the thread so far.") : say("ok"));
    await boot(5, { contextWindow: 2000, compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 300, backgroundTokens: 0 } });
    const filler = "lorem ipsum dolor sit amet ".repeat(40);
    for (let turn = 1; turn <= 6; turn++) {
      channel.push(inbound(`m${turn}`, `${filler} turn ${turn}`));
      await channel.sentCount(turn);
    }
    const summaries = model.requests.filter((request) => JSON.stringify(request.messages).includes("context summarization assistant"));
    assert.ok(summaries.length >= 1, "a summarize request was made");
    assert.deepEqual(channel.sent.map((entry) => entry.text), Array(6).fill("ok"));
    const last = JSON.stringify(model.requests.filter((request) => request.tools).at(-1)?.messages);
    assert.match(last, /SUMMARY of the thread so far\./);
    assert.doesNotMatch(last, /turn 1\b/);
    assert.match(last, /turn 6\b/);
  });

  it("sends a fixed apology when the model keeps failing", opts, async () => {
    model.enqueue(fail(), fail(), fail(), fail(), fail(), fail());
    await boot();
    channel.push(inbound("m1", "hi"));
    await channel.sentCount(1);
    assert.equal(channel.sent[0]?.text, FAILURE_TEXT);
  });

  const notices = () => channel.sent.map((entry) => entry.text).filter((text) => text === BACK_TEXT || text.startsWith("Switched to the backup model"));
  const quiet = () => new Promise((resolve) => setTimeout(resolve, 300));

  it("sends no notice for a reply from the primary model", opts, async () => {
    model.enqueue(say("one"), say("two"));
    await boot();
    channel.push(inbound("m1", "a"));
    await channel.sentCount(1);
    channel.push(inbound("m2", "b"));
    await channel.sentCount(2);
    await quiet();
    assert.deepEqual(channel.sent.map((entry) => entry.text), ["one", "two"]);
    assert.deepEqual(notices(), []);
  });

  it("sends exactly one switch notice when a primary reply is followed by a fallback reply", opts, async () => {
    model.enqueue(say("one"), via(say("two"), BACKUP_VIA));
    await boot();
    channel.push(inbound("m1", "a"));
    await channel.sentCount(1);
    channel.push(inbound("m2", "b"));
    await channel.sentCount(3);
    await quiet();
    assert.deepEqual(notices(), [fallbackText(DEFAULT_REASON)]);
    assert.equal(fallbackText(DEFAULT_REASON), "Switched to the backup model: Claude didn't answer.");
    assert.deepEqual(channel.sent.map((entry) => entry.text).filter((text) => !notices().includes(text)), ["one", "two"]);
    assert.ok(channel.sent.every((entry) => entry.space === SPACE));
  });

  it("sends no extra notice while replies keep coming from the fallback", opts, async () => {
    model.enqueue(say("one"), via(say("two"), BACKUP_VIA), via(say("three"), BACKUP_VIA), via(say("four"), BACKUP_VIA));
    await boot();
    for (const [index, id] of ["m1", "m2", "m3", "m4"].entries()) {
      channel.push(inbound(id, "q"));
      await channel.sentCount(index + 1 + (index >= 1 ? 1 : 0));
    }
    await quiet();
    assert.equal(channel.sent.length, 5);
    assert.equal(notices().length, 1);
  });

  it("treats a fallback first reply after deploy as a switch", opts, async () => {
    model.enqueue(via(say("one"), BACKUP_VIA));
    await boot();
    channel.push(inbound("m1", "a"));
    await channel.sentCount(2);
    await quiet();
    assert.deepEqual(notices(), [fallbackText(DEFAULT_REASON)]);
  });

  it("sends exactly one Back on Claude. when the primary answers again", opts, async () => {
    model.enqueue(via(say("one"), BACKUP_VIA), say("two"), say("three"));
    await boot();
    channel.push(inbound("m1", "a"));
    await channel.sentCount(2);
    channel.push(inbound("m2", "b"));
    await channel.sentCount(4);
    channel.push(inbound("m3", "c"));
    await channel.sentCount(5);
    await quiet();
    assert.deepEqual(notices(), [fallbackText(DEFAULT_REASON), "Back on Claude."]);
    assert.equal(BACK_TEXT, "Back on Claude.");
  });

  it("keeps the tier across a restart and sends nothing for the same tier", opts, async () => {
    model.enqueue(via(say("one"), BACKUP_VIA));
    await boot();
    channel.push(inbound("m1", "a"));
    await channel.sentCount(2);
    await logged("reply_sent");
    const before = channel.sent.map((entry) => entry.text);
    await tether?.stop();
    tether = undefined;
    channel = new FakeChannel();
    model.enqueue(via(say("two"), BACKUP_VIA));
    await boot();
    channel.push(inbound("m2", "b"));
    await channel.sentCount(1);
    await quiet();
    assert.equal(before.length, 2);
    assert.deepEqual(channel.sent.map((entry) => entry.text), ["two"]);
  });

  it("logs the deployment id and response model the router reported", opts, async () => {
    model.enqueue(via(say("one"), BACKUP_VIA));
    await boot();
    channel.push(inbound("m1", "a"));
    await logged("model_served");
    const line = logs.find((entry) => entry.includes('"event":"model_served"')) ?? "";
    assert.match(line, /"tier":"fallback"/);
    assert.match(line, /"model":"deepseek-v4.1-flash"/);
    assert.match(line, /"deployment":"deployment-backup"/);
    assert.match(line, /"fallbacks":"1"/);
  });
});
