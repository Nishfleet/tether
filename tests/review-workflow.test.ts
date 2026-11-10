import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = (file: string) => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");

test("every fleet-ops lane stub is held to the handoff checks below", () => {
  const stubs = readdirSync(new URL("../.github/workflows", import.meta.url))
    .filter((file) => file.endsWith(".yml"))
    .filter((file) => workflow(file).includes("Nishfleet/fleet-ops/.github/workflows/"));
  assert.deepEqual(stubs.sort(), ["agent.yml", "answer.yml", "review.yml"]);
});

test("the review caller passes the approver token by name, so the bot never posts with an empty token", () => {
  assert.match(workflow("review.yml"), /^ {4}secrets:\n {6}APPROVER_TOKEN: \$\{\{ secrets\.APPROVER_TOKEN \}\}$/m);
});

test("the agent caller passes the app key by name, so the lane never runs with an empty key", () => {
  assert.match(workflow("agent.yml"), /^ {4}secrets:\n {6}APP_PRIVATE_KEY: \$\{\{ secrets\.APP_PRIVATE_KEY \}\}$/m);
});

test("the agent run name carries its engine, so the reviewer reads it and picks another model family", () => {
  assert.match(workflow("agent.yml"), /^run-name: .*engine=/m);
});
