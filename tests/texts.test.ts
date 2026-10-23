import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { TEXT_LIMIT } from "../src/texts.ts";
import { call, flatten, inbound, say } from "./helpers.ts";
import { Rig } from "./rig.ts";

const opts = { timeout: 30000 };

describe("text_owner", () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = new Rig();
    await rig.open();
  });
  afterEach(() => rig.close());

  it("sends the parts in order and then the final answer", opts, async () => {
    rig.model.enqueue(call("text_owner", { text: "Part 1: the first verses." }), call("text_owner", { text: "Part 2: the middle verses." }), say("Part 3: the last verses."));
    await rig.boot();
    rig.channel.push(inbound("m1", "write me a long poem in parts"));
    await rig.channel.sentCount(3);
    assert.deepEqual(rig.texts(), ["Part 1: the first verses.", "Part 2: the middle verses.", "Part 3: the last verses."]);
    assert.ok(rig.channel.sent.every((sent) => sent.space === "space-1"));
  });

  it(`stops after ${TEXT_LIMIT} extra texts in ten minutes and tells the model`, opts, async () => {
    const calls = Array.from({ length: TEXT_LIMIT + 1 }, (_, index) => call("text_owner", { text: `part ${index + 1}` }));
    rig.model.enqueue(...calls, say("final"));
    await rig.boot();
    rig.channel.push(inbound("m1", "spam"));
    await rig.channel.sentCount(TEXT_LIMIT + 1);
    assert.equal(rig.texts().filter((sent) => sent.startsWith("part ")).length, TEXT_LIMIT);
    assert.equal(rig.texts().at(-1), "final");
    assert.match(flatten(rig.model.requests.at(-1) as never), /Too many extra texts/);
  });

  it("tells the model when a send fails and does not crash", opts, async () => {
    rig.model.enqueue(call("text_owner", { text: "lost" }), say("final answer"));
    await rig.boot();
    rig.channel.failures = 1;
    rig.channel.push(inbound("m1", "go"));
    await rig.logged("owner_text_failed");
    await rig.channel.sentCount(1);
    assert.match(flatten(rig.model.requests.at(-1) as never), /could not be sent/);
    assert.equal(rig.texts().at(-1), "final answer");
  });

  it("does not count a failed send against the limit", opts, async () => {
    const calls = Array.from({ length: TEXT_LIMIT + 2 }, (_, index) => call("text_owner", { text: `part ${index + 1}` }));
    rig.model.enqueue(...calls, say("final"));
    await rig.boot();
    rig.channel.failures = 1;
    rig.channel.push(inbound("m1", "spam"));
    await rig.channel.sentCount(TEXT_LIMIT + 1);
    assert.equal(rig.texts().filter((sent) => sent.startsWith("part ")).length, TEXT_LIMIT);
    assert.doesNotMatch(rig.texts().join("|"), /part 1\b(?!\d)/);
    const last = flatten(rig.model.requests.at(-1) as never);
    assert.match(last, /could not be sent/);
    assert.match(last, /Too many extra texts/);
  });
});
