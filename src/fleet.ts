import { execFile } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { type AnyGuardedTool, defineAskFirstTool } from "./approval.ts";
import type { TincanConfig } from "./config.ts";
import type { Log } from "./log.ts";
import { failure, text } from "./tool.ts";

export const DESK = "issue-desk";
export const ANSWERED = 0;
export const PENDING = 2;
export const TIMEOUT_CODE = -1;
const RUN_TIMEOUT_MS = 30000;
const REASON_CHARS = 200;
export const UNREACHABLE = "The fleet could not be reached.";
export const sentText = (id: string) => `Sent to the fleet, request ${id}`;
export const failedText = (reason: string) => `The fleet request failed: ${reason}`;

export type RunResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

export type Run = (bin: string, args: readonly string[], env: Readonly<Record<string, string>>) => Promise<RunResult>;

const defaultRun: Run = (bin, args, env) =>
  new Promise((resolve, reject) => {
    execFile(bin, [...args], { env, timeout: RUN_TIMEOUT_MS, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) resolve({ code: 0, stdout, stderr });
      else if (error.killed) resolve({ code: TIMEOUT_CODE, stdout, stderr });
      else if (typeof error.code === "number") resolve({ code: error.code, stdout, stderr });
      else reject(error);
    });
  });

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

const reason = (value: string) => {
  const flat = oneLine(value);
  return flat.length > REASON_CHARS ? `${flat.slice(0, REASON_CHARS - 1)}…` : flat;
};

const field = (value: unknown, key: string) => {
  const found = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  return typeof found === "string" ? oneLine(found) : "";
};

export function createFleetTools(config: TincanConfig, log: Log, run: Run = defaultRun): readonly AnyGuardedTool[] {
  const env: Record<string, string> = { TINCAN_CONFIG: config.config };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.PATH) env.PATH = process.env.PATH;

  const request = defineAskFirstTool({
    name: "fleet_request",
    description: `Send one request for a change to a product (for example "fix the site" or "add a feature") to the fleet's ${DESK}, which files it as a job. Call it only when the owner clearly asks for such a change. Write the request as one plain sentence. Tell the owner the one line it returns: the issue link, the request id, or why it failed.`,
    parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 2000 }) }),
    replay: "unsafe",
    execute: async (args) => {
      const request = oneLine(args.text);
      if (!request) return failure(failedText("the request was empty"));
      let result: RunResult;
      try {
        result = await run(config.bin, ["ask", DESK, "--json", "--", request], env);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        log("fleet_unreachable", { code: typeof code === "string" ? code : "unknown", error: error instanceof Error ? error.name : "unknown" });
        return failure(UNREACHABLE);
      }
      if (result.code !== ANSWERED && result.code !== PENDING && result.code !== TIMEOUT_CODE)
        return failure(failedText(reason(result.stderr || result.stdout) || `exit ${result.code}`));
      let answer: unknown;
      let unreadable = false;
      try {
        answer = JSON.parse(result.stdout);
      } catch {
        unreadable = true;
        log("fleet_unreadable", { code: result.code });
      }
      const id = field(answer, "request_id");
      const reply = field(answer, "reply");
      log("fleet_request", { code: result.code, id });
      if (result.code === ANSWERED) {
        if (unreadable) return failure(failedText("the answer was not JSON"));
        return reply ? text(reply) : failure(failedText("the fleet answered with nothing"));
      }
      if (id) return text(sentText(id));
      return failure(failedText(result.code === TIMEOUT_CODE ? "no answer in time, so the request may still have been sent" : "no request id came back"));
    },
  });

  return [request] as readonly AnyGuardedTool[];
}
