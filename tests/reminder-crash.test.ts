import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { STOPPED_TEXT } from "../src/app.ts";
import { REMINDER_PREFIX } from "../src/reminders.ts";
import { FakeModel, call, inbound, say } from "./helpers.ts";
import { Tether } from "./process.ts";

const opts = { timeout: 60000 };

describe("reminders across SIGKILL and restart", () => {
  let dir: string;
  let model: FakeModel;
  const running: Tether[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tether-remind-"));
    model = new FakeModel();
    await model.start();
  });

  afterEach(async () => {
    for (const tether of running.splice(0)) await tether.terminate();
    await model.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(): Promise<Tether> {
    const tether = new Tether({ stateDir: dir, baseUrl: model.url });
    running.push(tether);
    await tether.started();
    return tether;
  }

  const setReminder = async (first: Tether, text: string, inMinutes: number) => {
    model.enqueue(call("reminder_set", { text, inMinutes }), say("Set."));
    first.push(inbound("m1", `remind me: ${text}`));
    await first.logged("reply_sent");
    assert.deepEqual(first.sent, ["Set."]);
  };

  it("texts a reminder that came due while the process was dead, once", opts, async () => {
    const first = await start();
    await setReminder(first, "take the tablet", 0.1);
    const overdueAt = Date.now() + 0.1 * 60000 + 300;
    await first.kill9();
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, overdueAt - Date.now())));

    const second = await start();
    await second.until(() => second.sent.length >= 1);
    assert.deepEqual(second.sent, [`${REMINDER_PREFIX}take the tablet`]);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(await second.terminate(), 0);
    assert.deepEqual(second.sent, [`${REMINDER_PREFIX}take the tablet`], "delivered exactly once");
  });

  it("keeps sleeping through a restart and texts at the due time, then not again after another restart", opts, async () => {
    const first = await start();
    const due = Date.now() + 0.12 * 60000;
    await setReminder(first, "water the plants", 0.12);
    await first.kill9();

    const second = await start();
    assert.deepEqual(second.sent, [], "nothing before the due time");
    await second.until(() => second.sent.length >= 1);
    assert.ok(Date.now() >= due - 200, "not early");
    assert.deepEqual(second.sent, [`${REMINDER_PREFIX}water the plants`]);
    await second.logged("reply_sent");
    await second.kill9();

    const third = await start();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.deepEqual(third.sent, [], "a delivered reminder is not sent again");
  });

  it("keeps two reminders that came due during STOP across a kill and sends each once after RESUME", opts, async () => {
    const first = await start();
    model.enqueue(call("reminder_set", { text: "alpha", inMinutes: 0.04 }), say("Set alpha."), call("reminder_set", { text: "beta", inMinutes: 0.04 }), say("Set beta."));
    first.push(inbound("m1", "remind me alpha"));
    await first.until(() => first.sent.includes("Set alpha."));
    first.push(inbound("m2", "remind me beta"));
    await first.until(() => first.sent.includes("Set beta."));
    const overdueAt = Date.now() + 0.04 * 60000 + 1500;
    first.push(inbound("m3", "STOP"));
    await first.until(() => first.sent.includes(STOPPED_TEXT));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, overdueAt - Date.now())));
    assert.deepEqual(first.sent, ["Set alpha.", "Set beta.", STOPPED_TEXT], "nothing sent while stopped");
    await first.kill9();

    const second = await start();
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.deepEqual(second.sent, [], "still held after the restart");
    second.push(inbound("m4", "RESUME"));
    await second.until(() => second.sent.length >= 3);
    assert.deepEqual([...second.sent].sort(), ["Resumed.", `${REMINDER_PREFIX}alpha`, `${REMINDER_PREFIX}beta`].sort());
    await second.logged("reply_sent", 3);
    await second.kill9();

    const third = await start();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.deepEqual(third.sent, [], "a released reminder is not sent again");
  });
});
