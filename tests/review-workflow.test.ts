import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

type Workflow = {
  "run-name"?: string;
  jobs?: Record<string, { uses?: string; secrets?: Record<string, string> | "inherit" }>;
};

const workflow = (file: string): Workflow =>
  parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8")) as Workflow;

const laneHandoff = (file: string, job: string, lane: string, secret: string) => {
  const called = workflow(file).jobs?.[job];
  assert.ok(called, `${file} has no ${job} job`);
  assert.ok(
    typeof called.uses === "string" && called.uses.startsWith(`Nishfleet/fleet-ops/.github/workflows/${lane}@`),
    `${file}: the ${job} job must call the ${lane} lane`,
  );
  assert.ok(
    called.secrets === "inherit" ||
      (typeof called.secrets === "object" && called.secrets[secret] === `\${{ secrets.${secret} }}`),
    `${file}: the ${job} job that calls the ${lane} lane must pass ${secret} by name`,
  );
};

test("the agent run name carries its engine, so the reviewer reads it and picks another model family", () => {
  assert.ok(workflow("agent.yml")["run-name"]?.includes("engine="), "agent.yml must name the run with engine=");
});

test("the review caller passes the approver token by name inside the job that calls the lane, so the bot never posts with an empty token", () => {
  laneHandoff("review.yml", "review", "review.yml", "APPROVER_TOKEN");
});

test("the agent caller passes the app key by name inside the job that calls the lane, so the lane never runs with an empty key", () => {
  laneHandoff("agent.yml", "agent", "agent.yml", "APP_PRIVATE_KEY");
});
