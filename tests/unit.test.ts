import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { normalizeHandle } from "../src/channel.ts";
import { loadConfig, loadPhotonConfig } from "../src/config.ts";
import { classify } from "../src/control.ts";
import { routerBaseUrl } from "../src/model.ts";
import { classifyTier, switchNotice } from "../src/tier.ts";
import { chmodSync, mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import { loadSalt, SALT_FILE } from "../src/salt.ts";
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

  it("takes the model group from TETHER_MODEL_GROUP and defaults to tether", () => {
    const base = { TETHER_ALLOWED_SENDER: "a", TETHER_LLM_API_KEY: "k", TETHER_STATE_DIR: "/x" };
    assert.equal(loadConfig(base).modelGroup, "tether");
    assert.equal(loadConfig({ ...base, TETHER_MODEL_GROUP: " other " }).modelGroup, "other");
    assert.equal(loadConfig({ ...base, TETHER_MODEL_GROUP: " " }).modelGroup, "tether");
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
    assert.equal(routerBaseUrl("http://router.example/litellm"), "http://router.example/litellm/v1");
  });
});

describe("log salt", () => {
  it("is random, created once, kept 0600 and stable across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "tether-salt-"));
    try {
      const first = loadSalt(dir);
      assert.match(first, /^[0-9a-f]{32}$/);
      assert.equal(loadSalt(dir), first);
      assert.equal(statSync(join(dir, SALT_FILE)).mode & 0o777, 0o600);
      chmodSync(join(dir, SALT_FILE), 0o644);
      assert.equal(loadSalt(dir), first);
      assert.equal(statSync(join(dir, SALT_FILE)).mode & 0o777, 0o600);
      const other = mkdtempSync(join(tmpdir(), "tether-salt-"));
      assert.notEqual(loadSalt(other), first);
      rmSync(other, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("context bound", () => {
  it("relies on Pi Durable's automatic compaction, which is on by default", () => {
    assert.equal(DEFAULT_COMPACTION_POLICY.enabled, true);
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

describe("tier", () => {
  const served = (model: string | undefined, fallbacks?: string) => ({ model, deployment: undefined, fallbacks });

  it("classifies by the model the router reports: the group alias or a Claude model is primary", () => {
    assert.equal(classifyTier(served("tether"), "tether"), "primary");
    assert.equal(classifyTier(served("claude-sonnet-5-5"), "tether"), "primary");
    assert.equal(classifyTier(served("anthropic/claude-sonnet-5-5"), "tether"), "primary");
    assert.equal(classifyTier(served("custom-group"), "custom-group"), "primary");
    assert.equal(classifyTier(served("assistant"), "tether"), "fallback");
    assert.equal(classifyTier(served("deepseek-v4.1-flash"), "tether"), "fallback");
    assert.equal(classifyTier(served(undefined), "tether"), "fallback");
  });

  it("lets x-litellm-attempted-fallbacks decide when it is present", () => {
    assert.equal(classifyTier(served("tether", "1"), "tether"), "fallback");
    assert.equal(classifyTier(served("claude-sonnet-5-5", "2"), "tether"), "fallback");
    assert.equal(classifyTier(served("deepseek-v4.1-flash", "1"), "tether"), "fallback");
    assert.equal(classifyTier(served("tether", "0"), "tether"), "primary");
    assert.equal(classifyTier(served("assistant", "0"), "tether"), "primary");
    assert.equal(classifyTier(served(undefined, "0"), "tether"), "primary");
    assert.equal(classifyTier(served("assistant", "not-a-number"), "tether"), "fallback");
  });

  it("words one notice per switch and none for the baseline or the same tier", () => {
    assert.equal(switchNotice(null, "primary"), null);
    assert.equal(switchNotice("primary", "primary"), null);
    assert.equal(switchNotice("fallback", "fallback"), null);
    assert.equal(switchNotice(null, "fallback"), "Switched to the backup model: Claude didn't answer.");
    assert.equal(switchNotice("primary", "fallback"), "Switched to the backup model: Claude didn't answer.");
    assert.equal(switchNotice("fallback", "primary"), "Back on Claude.");
  });
});
