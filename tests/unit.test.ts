import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { normalizeHandle } from "../src/channel.ts";
import { loadConfig, loadPhotonConfig } from "../src/config.ts";
import { classify } from "../src/control.ts";
import { routerBaseUrl } from "../src/model.ts";
import { ALLOWED, inbound } from "./helpers.ts";

describe("classify", () => {
  it("accepts only the allowed handle, however it is formatted", () => {
    assert.equal(classify(inbound("1", "hi"), ALLOWED).kind, "chat");
    assert.equal(classify(inbound("1", "hi", { sender: " Owner@EXAMPLE.test " }), "owner@example.test").kind, "chat");
    assert.deepEqual(classify(inbound("1", "hi", { sender: "stranger@example.test" }), ALLOWED), { kind: "ignore", reason: "sender_not_allowed" });
    assert.deepEqual(classify(inbound("1", "hi", { sender: "" }), ALLOWED), { kind: "ignore", reason: "sender_not_allowed" });
  });

  it("matches email handles case-insensitively", () => {
    assert.equal(classify(inbound("1", "hi", { sender: "Me@Example.com" }), "me@example.com").kind, "chat");
  });

  it("reads STOP and RESUME only from the allowed sender, in any case, and only as the whole text", () => {
    assert.equal(classify(inbound("1", " stop "), ALLOWED).kind, "stop");
    assert.equal(classify(inbound("1", "Resume"), ALLOWED).kind, "resume");
    assert.equal(classify(inbound("1", "please stop"), ALLOWED).kind, "chat");
    assert.equal(classify(inbound("1", "STOP", { sender: "stranger@example.test" }), ALLOWED).kind, "ignore");
  });

  it("ignores group chats, empty text and non-text content", () => {
    assert.deepEqual(classify(inbound("1", "hi", { direct: false }), ALLOWED), { kind: "ignore", reason: "not_direct" });
    assert.deepEqual(classify(inbound("1", "   "), ALLOWED), { kind: "ignore", reason: "not_text" });
    assert.deepEqual(classify(inbound("1", undefined), ALLOWED), { kind: "ignore", reason: "not_text" });
  });

  it("normalizes handles", () => {
    assert.equal(normalizeHandle(" (000) 000-0 "), "0000000");
    assert.equal(normalizeHandle("A@B.C"), "a@b.c");
  });
});

describe("config", () => {
  it("names every missing variable and never echoes a value", () => {
    assert.throws(() => loadConfig({ TETHER_LLM_API_KEY: "secret-value" }), (error: Error) => {
      assert.match(error.message, /TETHER_ALLOWED_SENDER/);
      assert.doesNotMatch(error.message, /secret-value/);
      return true;
    });
    assert.throws(() => loadConfig({ TETHER_ALLOWED_SENDER: "a", TETHER_LLM_API_KEY: "k" }), /TETHER_STATE_DIR or STATE_DIRECTORY/);
    assert.throws(() => loadPhotonConfig({}), /PHOTON_PROJECT_ID, PHOTON_PROJECT_SECRET/);
  });

  it("defaults the router to loopback port 4000 and takes the state directory from systemd", () => {
    const config = loadConfig({ TETHER_ALLOWED_SENDER: "a", TETHER_LLM_API_KEY: "k", STATE_DIRECTORY: "/var/lib/tether" });
    assert.equal(config.llmBaseUrl, "http://127.0.0.1:4000");
    assert.equal(config.stateDir, "/var/lib/tether");
    assert.equal(loadConfig({ TETHER_ALLOWED_SENDER: "a", TETHER_LLM_API_KEY: "k", TETHER_STATE_DIR: "/x", STATE_DIRECTORY: "/y" }).stateDir, "/x");
  });

  it("points the model client at the router's /v1", () => {
    assert.equal(routerBaseUrl("http://127.0.0.1:4000"), "http://127.0.0.1:4000/v1");
    assert.equal(routerBaseUrl("http://127.0.0.1:4000/"), "http://127.0.0.1:4000/v1");
    assert.equal(routerBaseUrl("http://router.example/v1/"), "http://router.example/v1");
  });
});

describe("supply chain", () => {
  it("pins every dependency to an exact version", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as Record<string, Record<string, string>>;
    const ranges = { ...manifest.dependencies, ...manifest.devDependencies };
    assert.ok(Object.keys(ranges).length >= 5);
    for (const [name, range] of Object.entries(ranges)) assert.match(range, /^\d+\.\d+\.\d+$/, name);
  });

  it("loads the Photon Spectrum iMessage provider", async () => {
    const { Spectrum } = await import("spectrum-ts");
    const { imessage } = await import("spectrum-ts/providers/imessage");
    assert.equal(typeof Spectrum, "function");
    assert.equal(typeof imessage.config, "function");
  });
});
