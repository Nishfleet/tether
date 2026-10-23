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

export type Run = (bin: string, args: readonly string[], env: Readonly<Record<string, string>>, signal?: AbortSignal) => Promise<RunResult>;

export type FleetDeps = {
  readonly run?: Run;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
};

export type Fleet = {
  readonly tools: readonly AnyGuardedTool[];
  halt(): void;
};

export const runTincan: Run = (bin, args, env, signal) =>
  new Promise((resolve, reject) => {
    execFile(bin, [...args], { env, timeout: RUN_TIMEOUT_MS, maxBuffer: 1 << 20, encoding: "utf8", ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
    });
  });

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

const field = (value: unknown, ...keys: readonly string[]): string | undefined => {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current === "number" && Number.isFinite(current)) return String(current);
  return typeof current === "string" && current.trim() ? current.trim() : undefined;
};

const present = (value: unknown, ...keys: readonly string[]): boolean => {
  let current = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return false;
    current = (current as Record<string, unknown>)[key];
  }
  return current !== undefined && current !== null;
};

export type Outcome = {
  readonly state: "answered" | "failed" | "pending";
  readonly id: string | undefined;
  readonly body: string;
  readonly replied: boolean;
};

export function parseOutcome(result: RunResult): Outcome {
  const state = result.code === 0 ? "answered" : result.code === 2 ? "pending" : "failed";
  const raw = result.stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const id = field(parsed, "result", "request", "id") ?? field(parsed, "request", "id") ?? /request id (\S+)/i.exec(raw)?.[1];
  const body =
    field(parsed, "result", "reply", "body") ??
    field(parsed, "result", "relay_note", "note") ??
    field(parsed, "error") ??
    field(parsed, "message") ??
    (result.stderr.trim() || (parsed === undefined ? raw : ""));
  return { state, id, body, replied: present(parsed, "result", "reply") };
}

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

export function createFleet(config: TincanConfig, options: { channel: Channel; log: Log }, deps: FleetDeps = {}): Fleet {
  const { channel, log } = options;
  const run = deps.run ?? runTincan;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const env: Record<string, string> = { TINCAN_CONFIG: config.config };
  for (const name of ["PATH", "HOME"]) if (process.env[name]) env[name] = process.env[name] as string;
  const running = new Set<AbortController>();

  const tincan = (args: readonly string[], signal?: AbortSignal) => run(config.bin, args, env, signal);

  async function poll(id: string, space: string, halted: AbortController): Promise<void> {
    const deadline = now() + POLL_LIMIT_MS;
    let delay = POLL_FIRST_MS;
    let line = NO_ANSWER(id);
    while (!halted.signal.aborted) {
      const left = deadline - now();
      if (left <= 0) break;
      await sleep(Math.min(delay, left));
      delay = Math.min(delay * 2, POLL_MAX_MS);
      if (halted.signal.aborted || now() >= deadline) break;
      let outcome: Outcome;
      try {
        outcome = parseOutcome(await tincan(["get", id, "--json"], halted.signal));
      } catch (error) {
        if (halted.signal.aborted) return;
        log("fleet_poll_failed", { id, error: error instanceof Error ? error.name : "unknown" });
        continue;
      }
      if (outcome.state === "pending") continue;
      line =
        outcome.state === "answered"
          ? oneLine(outcome.body) || `The fleet answered request ${id} with nothing.`
          : outcome.replied
            ? REFUSED(oneLine(outcome.body) || `request ${id} was refused`)
            : `The fleet failed request ${id}: ${oneLine(outcome.body) || "no reason given"}`;
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
      const sent = new AbortController();
      running.add(sent);
      try {
        outcome = parseOutcome(await tincan(["ask", DESK, "--json", "--wait", ASK_WAIT, "--", oneLine(args.text)], sent.signal));
      } catch (error) {
        log("fleet_ask_failed", { error: error instanceof Error ? error.name : "unknown" });
        return failure("The fleet could not be reached.");
      } finally {
        running.delete(sent);
      }
      if (outcome.state === "answered") return text(oneLine(outcome.body) || "The fleet answered with nothing.");
      if (outcome.state === "failed") {
        if (outcome.replied) return failure(REFUSED(oneLine(outcome.body) || "the request was refused"));
        return failure(`The fleet could not take the request: ${oneLine(outcome.body) || "no reason given"}`);
      }
      if (!outcome.id) return failure("The fleet took the request but gave no request id, so it cannot be followed up.");
      log("fleet_pending", { id: outcome.id });
      const halted = new AbortController();
      running.add(halted);
      void poll(outcome.id, space, halted);
      return text(`Sent as request ${outcome.id}. The answer will be texted when it comes, up to 10 minutes. Tell the owner that in one line.`);
    },
  });

  const halt = () => {
    for (const controller of running) controller.abort();
    running.clear();
  };

  return { tools: [request], halt };
}
