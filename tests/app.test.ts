import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { HarnessSettings } from "@earendil-works/pi-durable";
import { startTether, type Tether, INSTRUCTIONS, STOPPED_TEXT, RESUMED_TEXT } from "../src/app.ts";
import { seedNote } from "./offline.ts";
import { createModelAccess, MAX_OUTPUT_TOKENS } from "../src/model.ts";
import { CAPS_SPENT_TEXT, FAILURE_TEXT, MAX_PART_CHARS, TRUNCATED_MARKER } from "../src/reply.ts";
import { ALLOWED, FakeChannel, FakeModel, KEY, SPACE, budget, call, cut, fail, flatten, hold, inbound, say } from "./helpers.ts";

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

  const logWaiters: { event: string; resolve: () => void; count: number }[] = [];

  function logged(event: string, count = 1): Promise<void> {
    if (logs.filter((line) => line.includes(`"event":"${event}"`)).length >= count) return Promise.resolve();
    return new Promise((resolve) => logWaiters.push({ event, resolve, count }));
  }

  function pumpLogWaiters(event: string): void {
    for (const waiter of logWaiters.splice(0)) {
      if (event === waiter.event && logs.filter((line) => line.includes(`"event":"${event}"`)).length >= waiter.count) waiter.resolve();
      else logWaiters.push(waiter);
    }
  }

  async function boot(retryBaseMs = 5, extra: { now?: () => number; contextWindow?: number; compaction?: HarnessSettings["compaction"] } = {}): Promise<Tether> {
    const { models, ref } = createModelAccess({ baseUrl: model.url, apiKey: KEY, ...(extra.contextWindow ? { contextWindow: extra.contextWindow } : {}) });
    tether = await startTether({
      channel,
      models,
      model: ref,
      storage: await openNodeSqliteStorage(join(dir, "t.sqlite")),
      allowedSender: ALLOWED,
      log: (event, fields) => {
        logs.push(JSON.stringify({ event, ...fields }));
        pumpLogWaiters(event);
      },
      retryBaseMs,
      ...(extra.now ? { now: extra.now } : {}),
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

  it("tells the model how to send a reply in parts and that it cannot promise a later follow-up", () => {
    assert.match(INSTRUCTIONS, /one reply/);
    assert.match(INSTRUCTIONS, /text_owner/);
    assert.match(INSTRUCTIONS, /never promise a follow-up unless you set one/);
    assert.match(INSTRUCTIONS, /web_search and read a page in full with web_read/);
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
    assert.deepEqual(names, [
      "brief_off",
      "brief_set",
      "location_last",
      "location_request",
      "memory_forget",
      "memory_save",
      "places_nearby",
      "reminder_cancel",
      "reminder_list",
      "reminder_set",
      "text_owner",
      "time_now",
      "web_read",
      "web_search",
    ]);
  });

  it("STOP aborts the model call and sends nothing for it; RESUME does not re-ask it", opts, async () => {
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
    await channel.sentCount(2);
    assert.deepEqual(channel.sent.map((entry) => entry.text), [STOPPED_TEXT, RESUMED_TEXT]);
    assert.equal(model.requests.length, 1, "nothing reached the model while stopped, and nothing was asked again");
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
    assert.equal((results.match(/Saved as n[0-9]+\b/g) ?? []).length, 2);
  });

  it("numbers a new note after the highest id, including notes saved before ids were numbers", opts, async () => {
    await seedNote(join(dir, "t.sqlite"), { id: "n5f3a9c1e", text: "an older note", at: 1 });
    model.enqueue(call("memory_save", { note: "note B" }), call("memory_save", { note: "note B" }), say("done"));
    await boot();
    channel.push(inbound("m1", "save it"));
    await channel.sentCount(1);
    model.enqueue(say("ok"));
    channel.push(inbound("m2", "recall"));
    await channel.sentCount(2);
    const memory = String(model.requests.at(-1)?.messages[0]?.content).split("\n").filter((line) => /^n[0-9a-f]+: /.test(line));
    assert.deepEqual(memory.sort(), ["n1: note B", "n5f3a9c1e: an older note"]);
  });

  it("does not reuse an id after a note is forgotten", opts, async () => {
    model.enqueue(call("memory_save", { note: "likes tea" }), call("memory_forget", { id: "n1" }), call("memory_save", { note: "likes coffee" }), say("done"));
    await boot();
    channel.push(inbound("m1", "change my drink note"));
    await channel.sentCount(1);
    const results = JSON.stringify(model.requests.at(-1)?.messages);
    assert.match(results, /Saved as n2/);
  });

  it("does not re-ask an exhausted send after RESUME", opts, async () => {
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

  it("logs only the message id and reason for an ignored sender", opts, async () => {
    await boot();
    channel.push(inbound("x1", "hi", { sender: "stranger@example.test" }));
    channel.push(inbound("m1", "hello"));
    model.enqueue(say("ok"));
    await channel.sentCount(1);
    const line = logs.find((entry) => entry.includes('"ignored"')) ?? "";
    assert.match(line, /"id":"x1"/);
    assert.ok(!line.includes("stranger@example.test"));
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

  describe("daily caps spent", () => {
    const morning = Date.UTC(2026, 9, 24, 14, 0, 0);

    it("texts once on the first budget error of a day and stays quiet on the second", opts, async () => {
      model.enqueue(budget());
      await boot(5, { now: () => morning });
      channel.push(inbound("m1", "hi"));
      await channel.sentCount(1);
      assert.deepEqual(channel.sent, [{ space: SPACE, text: CAPS_SPENT_TEXT }]);
      model.enqueue(budget());
      channel.push(inbound("m2", "hello?"));
      await logged("budget_exceeded", 2);
      assert.equal(channel.sent.length, 1);
      const lines = logs.filter((line) => line.includes('"event":"budget_exceeded"'));
      assert.match(lines[0] ?? "", /"texted":true/);
      assert.match(lines[1] ?? "", /"texted":false/);
    });

    it("answers again after UTC midnight with no manual step", opts, async () => {
      let clock = morning;
      model.enqueue(budget());
      await boot(5, { now: () => clock });
      channel.push(inbound("m1", "hi"));
      await channel.sentCount(1);
      clock = Date.UTC(2026, 9, 25, 0, 5, 0);
      model.enqueue(say("back again"));
      channel.push(inbound("m2", "good morning"));
      await channel.sentCount(2);
      assert.equal(channel.sent[1]?.text, "back again");
    });

    it("texts again when the caps run out on a later day", opts, async () => {
      let clock = morning;
      model.enqueue(budget());
      await boot(5, { now: () => clock });
      channel.push(inbound("m1", "hi"));
      await channel.sentCount(1);
      clock = Date.UTC(2026, 9, 25, 9, 0, 0);
      model.enqueue(budget());
      channel.push(inbound("m2", "again"));
      await channel.sentCount(2);
      assert.equal(channel.sent[1]?.text, CAPS_SPENT_TEXT);
    });

    it("stays quiet on a budget error after a restart on the same day", opts, async () => {
      model.enqueue(budget());
      await boot(5, { now: () => morning });
      channel.push(inbound("m1", "hi"));
      await channel.sentCount(1);
      assert.deepEqual(channel.sent, [{ space: SPACE, text: CAPS_SPENT_TEXT }]);
      await logged("reply_sent");
      const first = channel;
      await tether?.stop();
      tether = undefined;
      channel = new FakeChannel();
      model.enqueue(budget());
      await boot(5, { now: () => morning });
      channel.push(inbound("m2", "still there?"));
      await logged("budget_exceeded", 2);
      assert.equal(first.sent.length, 1);
      assert.equal(channel.sent.length, 0);
      const second = logs.filter((line) => line.includes('"event":"budget_exceeded"'))[1] ?? "";
      assert.match(second, /"texted":false/);
    });

    it("keeps the apology and sends no caps text for other model errors", opts, async () => {
      let broken = true;
      model.fallback = () => (broken ? fail() : say("fine"));
      await boot();
      channel.push(inbound("m1", "hi"));
      await channel.sentCount(1);
      assert.equal(channel.sent[0]?.text, FAILURE_TEXT);
      broken = false;
      channel.push(inbound("m2", "again"));
      await channel.sentCount(2);
      assert.equal(channel.sent[1]?.text, "fine");
    });
  });

});
