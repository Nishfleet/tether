import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GOOGLE_SCOPES } from "../../src/calendar/google.ts";
import { groupId, parseEnv, updateEnvFile } from "../../src/setup/env-file.ts";
import { codeFrom, connectGoogle, REDIRECT } from "../../src/setup/google.ts";
import { connectIcloud } from "../../src/setup/icloud.ts";
import type { Ask } from "../../src/setup/prompt.ts";
import { APP_PASSWORD, APPLE_ID, FakeDav } from "./fake-dav.ts";
import { CLIENT_ID, CLIENT_SECRET, FakeGoogle, REFRESH_TOKEN } from "./fake-google.ts";

const scripted = (answers: string[]): Ask => async () => answers.shift() ?? "";

describe("setup", () => {
  let dir: string;
  let file: string;
  let printed: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tether-setup-"));
    file = join(dir, "calendar.env");
    printed = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges new values into the env file, keeps the others and sets mode 0640", () => {
    writeFileSync(file, "KEEP=1\nTETHER_ICLOUD_APPLE_ID=old\n", { mode: 0o600 });
    updateEnvFile(file, { TETHER_ICLOUD_APPLE_ID: "new", ADDED: "x" }, undefined);
    assert.deepEqual([...parseEnv(readFileSync(file, "utf8"))], [["KEEP", "1"], ["TETHER_ICLOUD_APPLE_ID", "new"], ["ADDED", "x"]]);
    assert.equal(statSync(file).mode & 0o777, 0o640);
  });

  it("refuses a value that would break the file", () => {
    assert.throws(() => updateEnvFile(file, { NAME: "a\nINJECT=1" }, undefined));
    assert.throws(() => updateEnvFile(file, { "bad name": "x" }, undefined));
    assert.throws(() => updateEnvFile(file, { NAME: "" }, undefined));
  });

  it("reads a group id from a group file", () => {
    const groups = join(dir, "group");
    writeFileSync(groups, "root:x:0:\ntether:x:996:\n");
    assert.equal(groupId("tether", groups), 996);
    assert.equal(groupId("nobody-here", groups), undefined);
  });

  it("takes the code from a pasted address or a bare code", () => {
    assert.equal(codeFrom(`${REDIRECT}/?state=s&code=4%2Fabc&scope=x`), "4/abc");
    assert.equal(codeFrom("4/abc"), "4/abc");
    assert.throws(() => codeFrom(`${REDIRECT}/?error=access_denied`));
  });

  describe("google", () => {
    let google: FakeGoogle;

    beforeEach(async () => {
      google = new FakeGoogle();
      await google.start();
      google.grantedScopes = [...GOOGLE_SCOPES];
      google.calendars = [{ id: "primary", selected: true }];
    });

    afterEach(async () => {
      await google.stop();
    });

    const run = (answers: string[]) =>
      connectGoogle({
        ask: scripted(answers),
        print: (line) => printed.push(line),
        envFile: file,
        timezone: "Asia/Kolkata",
        endpoints: { tokenUrl: `${google.url}token`, calendarRoot: google.url, peopleRoot: google.url },
      });

    it("sends a consent link with PKCE and the narrow scopes, then stores the refresh token after a real read", async () => {
      await run([CLIENT_ID, CLIENT_SECRET, `${REDIRECT}/?code=the-code`]);
      const link = new URL(printed.find((line) => line.startsWith("https://")) as string);
      assert.equal(link.searchParams.get("access_type"), "offline");
      assert.equal(link.searchParams.get("prompt"), "consent");
      assert.equal(link.searchParams.get("code_challenge_method"), "S256");
      assert.deepEqual(link.searchParams.get("scope")?.split(" "), [...GOOGLE_SCOPES]);
      const exchange = google.tokenForms.find((form) => form.get("grant_type") === "authorization_code");
      assert.equal(exchange?.get("code"), "the-code");
      assert.ok(exchange?.get("code_verifier"));
      assert.deepEqual([...parseEnv(readFileSync(file, "utf8"))], [
        ["TETHER_GOOGLE_CLIENT_ID", CLIENT_ID],
        ["TETHER_GOOGLE_CLIENT_SECRET", CLIENT_SECRET],
        ["TETHER_GOOGLE_REFRESH_TOKEN", REFRESH_TOKEN],
      ]);
      assert.ok(google.seen.some((entry) => entry.path === "/calendar/v3/calendars/primary/events"));
      assert.ok(!printed.join("\n").includes(CLIENT_SECRET));
      assert.ok(!printed.join("\n").includes(REFRESH_TOKEN));
    });

    it("stores nothing when the person unticks a permission", async () => {
      google.grantedScopes = GOOGLE_SCOPES.slice(0, 2);
      await assert.rejects(run([CLIENT_ID, CLIENT_SECRET, "the-code"]), /missing permissions: 1/);
      assert.throws(() => readFileSync(file));
    });
  });

  describe("icloud", () => {
    let dav: FakeDav;

    beforeEach(async () => {
      dav = new FakeDav();
      await dav.start();
    });

    afterEach(async () => {
      await dav.stop();
    });

    const run = (answers: string[]) =>
      connectIcloud({
        ask: scripted(answers),
        print: (line) => printed.push(line),
        envFile: file,
        timezone: "Asia/Kolkata",
        endpoints: { caldavUrl: dav.url, carddavUrl: dav.url },
      });

    it("proves the login with a real read, then stores the app password", async () => {
      await run([APPLE_ID, APP_PASSWORD]);
      assert.deepEqual([...parseEnv(readFileSync(file, "utf8"))], [
        ["TETHER_ICLOUD_APPLE_ID", APPLE_ID],
        ["TETHER_ICLOUD_APP_PASSWORD", APP_PASSWORD],
      ]);
      assert.ok(dav.requests.some((line) => line.startsWith("REPORT")));
      assert.ok(!printed.join("\n").includes(APP_PASSWORD));
    });

    it("stores nothing when the password is wrong", async () => {
      await assert.rejects(run([APPLE_ID, "wrong"]));
      assert.throws(() => readFileSync(file));
    });
  });
});
