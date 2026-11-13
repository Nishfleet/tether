import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = (file: string) => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");

test("the agent run name carries its engine, so the reviewer reads it and picks another model family", () => {
  assert.match(workflow("agent.yml"), /^run-name: .*engine=/m);
});
