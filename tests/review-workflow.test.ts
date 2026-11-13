import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = (file: string) => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");

const nameOf = (file: string) => workflow(file).match(/^name: (.+)$/m)?.[1];

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

test("the answer stub waits for the CI workflow by its own name, so a rename there does not silence the trigger", () => {
  const waited = workflow("answer.yml").match(/^ {4}workflows: \[(.+)\]$/m)?.[1];
  assert.equal(waited, nameOf("ci.yml"));
});

test("the answer stub gates the red-run lane itself, so a green run or a non-agent branch never starts the called workflow", () => {
  const file = workflow("answer.yml");
  assert.match(file, /^ {4}if: >-$/m);
  assert.match(file, /github\.event_name == 'pull_request_review' \|\|$/m);
  assert.match(file, /github\.event\.workflow_run\.conclusion == 'failure' &&$/m);
  assert.match(file, /startsWith\(github\.event\.workflow_run\.head_branch, 'agent\/issue-'\)\)$/m);
});
