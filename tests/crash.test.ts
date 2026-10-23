import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { STOPPED_TEXT } from "../src/app.ts";
import { askText } from "../src/approval.ts";
import { BACK_TEXT, FALLBACK_PREFIX } from "../src/tier.ts";
import { BACKUP_VIA, FakeModel, call, flatten, hold, inbound, say, via } from "./helpers.ts";
import { commitStopWithoutAbort } from "./offline.ts";
import { Tether } from "./process.ts";

const opts = { timeout: 60000 };

describe("tether process, killed with SIGKILL and restarted", () => {
  let dir: string;
  let model: FakeModel;
  const running: Tether[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tether-crash-"));
    model = new FakeModel();
    await model.start();
  });

  afterEach(async () => {
    for (const tether of running.splice(0)) await tether.terminate();
    await model.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(hangSend = false): Promise<Tether> {
    const tether = new Tether({ stateDir: dir, baseUrl: model.url, hangSend });
    running.push(tether);
    await tether.started();
    return tether;
  }

  it("finishes a reply that was cut off mid-model-call", opts, async () => {
    model.enqueue(hold());
    const first = await start();
    first.push(inbound("m1", "tell me a story"));
    await model.requestCount(1);
    await first.kill9();
    assert.deepEqual(first.sent, []);

    model.enqueue(say("Once upon a time."));
    const second = await start();
    await second.until(() => second.sent.length >= 1);
    assert.deepEqual(second.sent, ["Once upon a time."]);
    assert.match(flatten(model.requests[1] as never), /tell me a story/);
    assert.equal(await second.terminate(), 0);
    assert.deepEqual(second.sent, ["Once upon a time."], "delivered exactly once");
  });

  it("finishes a reply that was cut off mid-send", opts, async () => {
    model.enqueue(say("Your answer."));
    const first = await start(true);
    first.push(inbound("m1", "question"));
    await first.until(() => first.sending.length >= 1);
    assert.deepEqual(first.sending, ["Your answer."]);
    await first.kill9();

    const second = await start();
    await second.until(() => second.sent.length >= 1);
    assert.deepEqual(second.sent, ["Your answer."]);
    assert.equal(model.requests.length, 1, "the model was not asked again");
  });

  it("keeps the thread and memory notes across kills", opts, async () => {
    model.enqueue(call("memory_save", { note: "daughter is called Mia" }), say("Noted."));
    const first = await start();
    first.push(inbound("m1", "remember my daughter is called Mia"));
    await first.logged("reply_sent");
    await first.kill9();

    model.enqueue(say("Her name is Mia."));
    const second = await start();
    second.push(inbound("m2", "what is her name?"));
    await second.logged("reply_sent");
    const request = model.requests.at(-1);
    assert.match(flatten(request as never), /daughter is called Mia/);
    assert.match(JSON.stringify(request?.messages), /remember my daughter is called Mia/);
    assert.match(JSON.stringify(request?.messages), /Noted\./);
    await second.kill9();
    assert.deepEqual(second.sent, ["Her name is Mia."]);

    model.enqueue(say("Still Mia."));
    const third = await start();
    third.push(inbound("m3", "and again?"));
    await third.until(() => third.sent.length >= 1);
    assert.match(JSON.stringify(model.requests.at(-1)?.messages), /what is her name\?/);
    assert.match(flatten(model.requests.at(-1) as never), /daughter is called Mia/);
  });

  it("stays stopped after a kill until RESUME", opts, async () => {
    const first = await start();
    first.push(inbound("m1", "STOP"));
    await first.logged("reply_sent");
    assert.equal(first.sent[0], STOPPED_TEXT);
    await first.kill9();

    const second = await start();
    second.push(inbound("m2", "hello?"));
    second.push(inbound("m3", "RESUME"));
    await second.until(() => second.sent.length >= 1);
    assert.equal(second.sent[0], "Resumed.");
    assert.equal(model.requests.length, 0, "no model call while stopped");
  });

  it("does not run a pending model call after a kill between STOP's commit and its abort", opts, async () => {
    model.enqueue(hold());
    const first = await start();
    first.push(inbound("m1", "slow question"));
    await model.requestCount(1);
    await first.kill9();
    await commitStopWithoutAbort(dir);

    model.enqueue(say("The answer."), say("pong"));
    const second = await start();
    second.push(inbound("m1b", "anyone there?"));
    await second.logged("handled");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(second.sent, []);
    assert.equal(model.requests.length, 1, "no model call while stopped");
    second.push(inbound("m2", "RESUME"));
    second.push(inbound("m3", "ping"));
    await second.until(() => second.sent.includes("pong"));
    assert.deepEqual([...second.sent].sort(), ["Resumed.", "The answer.", "pong"]);
    assert.equal(model.requests.length, 3, "one call before the kill, one re-ask after RESUME, one for the ping, none while stopped");
  });

  it("does not send a finished reply after a kill between STOP's commit and its abort", opts, async () => {
    model.enqueue(say("The answer."));
    const first = await start(true);
    first.push(inbound("m1", "question"));
    await first.until(() => first.sending.length >= 1);
    await first.kill9();
    await commitStopWithoutAbort(dir);

    model.enqueue(say("The answer, again."));
    const second = await start();
    second.push(inbound("m1b", "anyone there?"));
    await second.logged("handled");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(second.sent, [], "nothing is sent while stopped");
    second.push(inbound("m2", "RESUME"));
    await second.until(() => second.sent.length >= 2);
    assert.deepEqual([...second.sent].sort(), ["Resumed.", "The answer, again."]);
    assert.equal(second.sent.filter((text) => text === "The answer.").length, 0);
  });

  it("does not leak message text or handles into its logs", opts, async () => {
    model.enqueue(say("fine"));
    const first = await start();
    first.push(inbound("m1", "my private question"));
    first.push(inbound("m2", "intruder words", { sender: "stranger@example.test" }));
    await first.until(() => first.sent.length >= 1);
    await first.terminate();
    const logs = first.stderr.join("\n");
    assert.doesNotMatch(logs, /private question|intruder words|stranger@example|owner@example|router-key/);
    assert.match(logs, /sender_not_allowed/);
  });

  const notices = (sent: string[]) => sent.filter((text) => text === BACK_TEXT || text.startsWith(FALLBACK_PREFIX));

  it("sends exactly one switch notice when killed between the reply and the notice", opts, async () => {
    model.enqueue(say("fine"), via(say("backup answer"), BACKUP_VIA));
    const first = await start();
    first.push(inbound("m1", "a"));
    await first.logged("reply_sent");
    await first.kill9();
    const second = await start(true);
    second.push(inbound("m2", "b"));
    await second.until(() => second.sending.length >= 1);
    await second.kill9();
    assert.deepEqual(second.sent, []);
    assert.deepEqual(notices(first.sent), []);

    const third = await start();
    await third.until(() => third.sent.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual([...third.sent].sort(), ["Switched to the backup model: Claude didn't answer.", "backup answer"].sort());
    assert.equal(notices([...first.sent, ...second.sent, ...third.sent]).length, 1, "one notice in total");
    assert.equal(await third.terminate(), 0);
  });

  it("sends nothing for a restart with no switch", opts, async () => {
    model.enqueue(via(say("backup one"), BACKUP_VIA));
    const first = await start();
    first.push(inbound("m1", "a"));
    await first.logged("reply_sent", 2);
    await first.kill9();
    assert.equal(notices(first.sent).length, 1);

    const second = await start();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(second.sent, [], "a restart alone sends nothing");
    model.enqueue(via(say("backup two"), BACKUP_VIA));
    second.push(inbound("m2", "b"));
    await second.until(() => second.sent.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(second.sent, ["backup two"], "no second notice for the same tier");
  });

  it("keeps a pending approval across a kill, asks once, and runs the tool only on YES", opts, async () => {
    model.enqueue(call("send_text", { to: "bob" }));
    const first = await start();
    first.push(inbound("m1", "text bob hi"));
    await first.logged("reply_sent");
    assert.deepEqual(first.sent, [askText("Send a text to bob.")]);
    await first.kill9();

    model.enqueue(say("Sent it."));
    const second = await start();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.deepEqual(second.sent, [], "the question was not asked again");
    assert.deepEqual(second.ran, [], "nothing ran while the approval was pending");
    second.push(inbound("m2", "YES"));
    await second.until(() => second.sent.length >= 1);
    assert.deepEqual(second.ran, ["send_text:bob"]);
    assert.deepEqual(second.sent, ["Sent it."]);
    assert.equal(await second.terminate(), 0);
    assert.deepEqual(second.ran, ["send_text:bob"], "ran exactly once");
  });

  it("cancels on NO after a kill", opts, async () => {
    model.enqueue(call("send_text", { to: "bob" }));
    const first = await start();
    first.push(inbound("m1", "text bob hi"));
    await first.logged("reply_sent");
    await first.kill9();

    model.enqueue(say("Cancelled."));
    const second = await start();
    second.push(inbound("m2", "NO"));
    await second.until(() => second.sent.length >= 1);
    assert.deepEqual(second.sent, ["Cancelled."]);
    assert.deepEqual(second.ran, []);
  });

  it("keeps a pending approval across a clean restart too", opts, async () => {
    model.enqueue(call("send_text", { to: "bob" }));
    const first = await start();
    first.push(inbound("m1", "text bob hi"));
    await first.logged("reply_sent");
    assert.equal(await first.terminate(), 0);

    model.enqueue(say("Sent it."));
    const second = await start();
    second.push(inbound("m2", "YES"));
    await second.until(() => second.sent.length >= 1);
    assert.deepEqual(second.sent, ["Sent it."]);
    assert.deepEqual(second.ran, ["send_text:bob"]);
    assert.deepEqual(first.ran, []);
  });
});
