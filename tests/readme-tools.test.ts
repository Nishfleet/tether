import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import type { AnyGuardedTool } from "../src/approval.ts";
import { createAssistExtension } from "../src/assist.ts";
import { createBriefTask } from "../src/brief.ts";
import { createCalendarExtension } from "../src/calendar/tools.ts";
import { createComputer } from "../src/computer.ts";
import { createEmailExtension } from "../src/email/tools.ts";
import { createFleetTools } from "../src/fleet.ts";
import { createMemoryExtension } from "../src/memory.ts";
import { createReplyTask } from "../src/reply.ts";
import { Links } from "../src/web.ts";
import { FakeChannel } from "./helpers.ts";

function allTools(): AnyGuardedTool[] {
  const log = () => undefined;
  const fetch = async () => new Response("");
  const timeZone = "Asia/Kolkata";
  const channel = new FakeChannel();
  const reply = createReplyTask({ channel, log, retryBaseMs: 5 });
  const brief = createBriefTask({ reply, timeZone, fetch, userAgent: "t", log, calendar: undefined, locations: undefined });
  const extensions = [
    createMemoryExtension([reply]),
    createAssistExtension({ channel, reply, timeZone, fetch, userAgent: "t", log, brief, links: new Links() }),
    createCalendarExtension({ backends: { calendar: [], contacts: [] }, timezone: timeZone }),
    createEmailExtension({ backend: {} as never, timezone: timeZone }),
  ];
  return [
    ...extensions.flatMap((extension) => (extension.tools ?? []) as AnyGuardedTool[]),
    ...createFleetTools({ bin: "tincan", config: "c" }, log),
    ...createComputer({ url: "http://127.0.0.1:1", token: "t", home: "/h" }, log).tools,
  ];
}

function readmeRows(): Map<string, string> {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const table = readme.slice(readme.indexOf("| Tool | What it does | Asks first |"));
  const rows = new Map<string, string>();
  for (const line of table.split("\n").slice(2)) {
    if (!line.startsWith("|")) break;
    const [tools = "", , asks = ""] = line.split("|").slice(1).map((cell) => cell.trim());
    for (const [, name] of tools.matchAll(/`([a-z_]+)`/g)) rows.set(name!, asks.replaceAll("*", ""));
  }
  return rows;
}

// A function rule can ask every time (email_send) or only sometimes (web_read), so its README cell is written here.
const ruleCells: Record<string, string> = { email_send: "yes", web_read: "only for a link the owner did not send" };
const asks = (tool: AnyGuardedTool) =>
  !tool.askFirst ? "no" : tool.askFirst === true ? "yes" : (ruleCells[tool.name] ?? `a README word for ${tool.name} in ruleCells`);

it("the README tools table lists every tool once, with the ask-first rule the code has", () => {
  const rows = readmeRows();
  const tools = allTools();
  assert.deepEqual([...rows.keys()].sort(), tools.map((tool) => tool.name).sort());
  for (const tool of tools) {
    const cell = rows.get(tool.name)!;
    assert.equal(cell, asks(tool), `${tool.name}: README says "${cell}", code asks ${asks(tool)}`);
  }
});
