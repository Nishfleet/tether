import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = (file: string) => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");

const lines = (file: string) => workflow(file).split("\n");

const jobBlock = (file: string, job: string) => {
  const all = lines(file);
  const start = all.indexOf(`  ${job}:`);
  assert.notEqual(start, -1, `${file} has no ${job} job`);
  const end = all.findIndex((line, index) => index > start && line.trim() !== "" && !line.startsWith("    "));
  return all.slice(start, end === -1 ? all.length : end);
};

const laneCall = (file: string, job: string, lane: string) => {
  const block = jobBlock(file, job);
  assert.equal(
    block.filter((line) => line.includes(`uses: Nishfleet/fleet-ops/.github/workflows/${lane}@main`)).length,
    1,
    `${file}: the ${job} job must call the ${lane} lane at @main`,
  );
  return block;
};

const secretHandoff = (file: string, job: string, lane: string, secret: string) => {
  const block = laneCall(file, job, lane);
  assert.equal(
    block.filter((line) => new RegExp(`^ {6}${secret}: \\$\\{\\{ secrets\\.${secret} \\}\\}$`).test(line)).length,
    1,
    `${file}: the ${job} job that calls the ${lane} lane must pass ${secret} by name`,
  );
};

test("the agent run name carries its engine, so the reviewer reads it and picks another model family", () => {
  assert.match(workflow("agent.yml"), /^run-name: .*engine=/m);
});

test("the review caller passes the approver token by name inside the job that calls the lane, so the bot never posts with an empty token", () => {
  secretHandoff("review.yml", "review", "review.yml", "APPROVER_TOKEN");
});

test("the agent caller passes the app key by name inside the job that calls the lane, so the lane never runs with an empty key", () => {
  secretHandoff("agent.yml", "agent", "agent.yml", "APP_PRIVATE_KEY");
});
