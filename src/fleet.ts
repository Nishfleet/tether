import { execFile } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { type AnyGuardedTool, defineAskFirstTool } from "./approval.ts";
import type { Channel } from "./channel.ts";
import type { TincanConfig } from "./config.ts";
import { StateDoc } from "./docs.ts";
import type { Log } from "./log.ts";
import { OwnerDoc } from "./owner.ts";
import { failure, text } from "./tool.ts";

export const DESK = "issue-desk";
export const REQUEST_CHARS = 150;
export const ASK_WAIT = "20s";
export const RUN_TIMEOUT_MS = 40000;
export const POLL_LIMIT_MS = 10 * 60 * 1000;
export const POLL_FIRST_MS = 5000;
export const POLL_MAX_MS = 60000;
export const NO_ANSWER = (id: string) => `No answer from the fleet yet, request ${id}`;
export const REFUSED = (reason: string) => `The fleet refused this: ${reason}`;

export type RunResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

export type Run = (bin: string, args: readonly string[], env: Readonly<Record<string, string>>) => Promise<RunResult>;

export type FleetDeps = {
  readonly run?: Run;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
};

export type Fleet = {
  readonly tools: readonly AnyGuardedTool[];
  halt(): void;
};

const defaultRun: Run = (bin, args, env) =>
  new Promise((resolve, reject) => {
    execFile(bin, [...args], { env, timeout: RUN_TIMEOUT_MS, maxBuffer: 1 << 20, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
    });
  });

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

const pick = (value: unknown, keys: readonly string[]): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  for (const key of keys) {
    const found = (value as Record<string, unknown>)[key];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return undefined;
};

export type Outcome = { readonly state: "answered" | "failed" | "pending"; readonly id: string | undefined; readonly body: string };

export function parseOutcome(result: RunResult): Outcome {
  const state = result.code === 0 ? "answered" : result.code === 2 ? "pending" : "failed";
  const raw = result.stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const id = pick(parsed, ["id", "request_id", "requestId"]) ?? /request id (\S+)/i.exec(raw)?.[1];
  const body = pick(parsed, ["reply", "answer", "text", "message", "error"]) ?? (parsed === undefined ? raw : "");
  return { state, id, body: body || result.stderr.trim() };
}

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

export function createFleet(config: TincanConfig, options: { channel: Channel; log: Log }, deps: FleetDeps = {}): Fleet {
  const { channel, log } = options;
  const run = deps.run ?? defaultRun;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const env: Record<string, string> = { TINCAN_CONFIG: config.config };
  for (const name of ["PATH", "HOME"]) if (process.env[name]) env[name] = process.env[name] as string;
  const running = new Set<AbortController>();

  const tincan = (args: readonly string[]) => run(config.bin, args, env);

  async function poll(id: string, space: string, halted: AbortController): Promise<void> {
    const deadline = now() + POLL_LIMIT_MS;
    let delay = POLL_FIRST_MS;
    let line = NO_ANSWER(id);
    while (now() < deadline && !halted.signal.aborted) {
      await sleep(delay);
      delay = Math.min(delay * 2, POLL_MAX_MS);
      if (halted.signal.aborted) return;
      let outcome: Outcome;
      try {
        outcome = parseOutcome(await tincan(["get", id, "--json", "--wait", ASK_WAIT]));
      } catch (error) {
        log("fleet_poll_failed", { error: error instanceof Error ? error.name : "unknown" });
        continue;
      }
      if (outcome.state === "pending") continue;
      line = outcome.state === "answered" ? oneLine(outcome.body) || `The fleet answered request ${id} with nothing.` : REFUSED(oneLine(outcome.body) || `request ${id} failed`);
      break;
    }
    running.delete(halted);
    if (halted.signal.aborted) return;
    try {
      await channel.send(space, line);
    } catch (error) {
      log("fleet_reply_failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  }

  const request = defineAskFirstTool({
    name: "fleet_request",
    description: `Hand one request for a change to a product (for example "fix the site" or "add a feature") to the fleet's ${DESK}. Call it only when the owner clearly asks for such a change; never for chat, questions or anything else. Write the request as one short plain sentence of at most ${REQUEST_CHARS} characters. The owner is asked "Send this to the fleet as a job?" first and the call runs only after YES. The answer is one line: the issue link, or the reason it was refused. A slow answer is texted to the owner later, so do not wait for it.`,
    parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: REQUEST_CHARS }) }),
    askFirst: (args) => `Send this to the fleet as a job? "${oneLine(args.text)}"`,
    replay: "unsafe",
    execute: async (args, api, context) => {
      const space = (await api.snapshot(OwnerDoc, context))?.space;
      if (!space) return failure("No chat to answer in yet. The owner has to message first.");
      if ((await api.snapshot(StateDoc, context))?.stopped) return failure("Stopped. Nothing was sent.");
      let outcome: Outcome;
      try {
        outcome = parseOutcome(await tincan(["ask", DESK, "--json", "--wait", ASK_WAIT, "--", oneLine(args.text)]));
      } catch (error) {
        log("fleet_ask_failed", { error: error instanceof Error ? error.name : "unknown" });
        return failure("The fleet could not be reached.");
      }
      if (outcome.state === "answered") return text(oneLine(outcome.body) || "The fleet answered with nothing.");
      if (outcome.state === "failed") return failure(REFUSED(oneLine(outcome.body) || "the request failed"));
      if (!outcome.id) return failure("The fleet took the request but gave no request id, so it cannot be followed up.");
      log("fleet_pending", { id: outcome.id });
      const halted = new AbortController();
      running.add(halted);
      void poll(outcome.id, space, halted);
      return text(`Sent as request ${outcome.id}. The answer will be texted when it comes, up to 10 minutes. Tell the owner that in one line.`);
    },
  });

  return { tools: [request] as readonly AnyGuardedTool[], halt: () => {
      for (const controller of running) controller.abort();
      running.clear();
    },
  };
}
