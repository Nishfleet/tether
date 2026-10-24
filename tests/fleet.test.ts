import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig, type TincanConfig } from "../src/config.ts";
import { createFleetTools, failedText, type Run, type RunResult, sentText, UNREACHABLE } from "../src/fleet.ts";

const CONFIG: TincanConfig = { bin: "/usr/local/bin/tincan", config: "/etc/tether/tincan.json" };

type Call = { bin: string; args: readonly string[]; env: Readonly<Record<string, string>> };

function build(result: RunResult | Error) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const run: Run = async (bin, args, env) => {
    calls.push({ bin, args, env });
    if (result instanceof Error) throw result;
    return result;
  };
  const tools = createFleetTools(CONFIG, (event, fields) => void logs.push(JSON.stringify({ event, ...fields })), run);
  const [tool] = tools;
  assert.ok(tool);
  const send = (text: string) =>
    tool.execute({ text } as never, undefined as never, undefined as never) as Promise<{ output?: { text?: string }[]; isError?: boolean }>;
  return { tools, calls, logs, send };
}

const textOf = (result: { output?: { text?: string }[] }) => result.output?.[0]?.text ?? "";

describe("fleet config", () => {
  const base = { TETHER_ALLOWED_SENDER: "a", TETHER_LLM_API_KEY: "k", TETHER_STATE_DIR: "/state" };

  it("registers the tool only when both TETHER_TINCAN_CONFIG and TETHER_TINCAN_BIN are set", () => {
    assert.equal(loadConfig(base).tincan, undefined);
    assert.equal(loadConfig({ ...base, TETHER_TINCAN_BIN: CONFIG.bin }).tincan, undefined);
    assert.equal(loadConfig({ ...base, TETHER_TINCAN_CONFIG: CONFIG.config }).tincan, undefined);
    assert.equal(loadConfig({ ...base, TETHER_TINCAN_BIN: CONFIG.bin, TETHER_TINCAN_CONFIG: " " }).tincan, undefined);
    assert.deepEqual(loadConfig({ ...base, TETHER_TINCAN_BIN: CONFIG.bin, TETHER_TINCAN_CONFIG: CONFIG.config }).tincan, CONFIG);
  });
});

describe("fleet_request", () => {
  it("is one tool that does not ask first, because the request goes to Nish's own fleet", () => {
    const { tools } = build({ code: 0, stdout: "{}", stderr: "" });
    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.askFirst, tool.money]),
      [["fleet_request", undefined, undefined]],
    );
  });

  it("makes one tincan ask to issue-desk with an argument array and texts back the issue link", async () => {
    const link = "https://github.com/Nishfleet/0509/issues/123";
    const { calls, send } = build({ code: 0, stdout: JSON.stringify({ request_id: "r1", reply: link }), stderr: "" });
    const result = await send("fix the  booking page;\n rm -rf / $(whoami)");
    assert.equal(textOf(result), link);
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [
      { bin: CONFIG.bin, args: ["ask", "issue-desk", "--json", "--", "fix the booking page; rm -rf / $(whoami)"], env: { TINCAN_CONFIG: CONFIG.config, ...(process.env.HOME ? { HOME: process.env.HOME } : {}) } },
    ]);
  });

  it("texts the request id when no answer comes back in time, after exactly one tincan call", async () => {
    const { calls, send } = build({ code: 2, stdout: JSON.stringify({ request_id: "r2" }), stderr: "" });
    const result = await send("add dark mode");
    assert.equal(textOf(result), "Sent to the fleet, request r2");
    assert.equal(textOf(result), sentText("r2"));
    assert.equal(calls.length, 1);
  });

  it("fails with a reason, never a crash, on output it cannot use", async () => {
    const cases: [RunResult, string][] = [
      [{ code: 0, stdout: "warning: upgrade available\n", stderr: "" }, "the answer was not JSON"],
      [{ code: 0, stdout: JSON.stringify({ request_id: "r3" }), stderr: "" }, "the fleet answered with nothing"],
      [{ code: 2, stdout: "{}", stderr: "" }, "no request id came back"],
    ];
    for (const [result, reason] of cases) {
      const answered = await build(result).send("fix it");
      assert.equal(answered.isError, true, reason);
      assert.equal(textOf(answered), failedText(reason));
    }
  });

  it("says why when the fleet refuses or cannot be reached", async () => {
    const refused = await build({ code: 1, stdout: "", stderr: "issue-desk: not a product repo\n" }).send("paint my house");
    assert.equal(refused.isError, true);
    assert.equal(textOf(refused), "The fleet request failed: issue-desk: not a product repo");
    const missing = build(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    const unreachable = await missing.send("fix it");
    assert.equal(unreachable.isError, true);
    assert.equal(textOf(unreachable), UNREACHABLE);
    assert.deepEqual(missing.logs, [JSON.stringify({ event: "fleet_unreachable", error: "Error" })]);
  });
});
