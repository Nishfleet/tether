import { execFile } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { type AnyGuardedTool } from "./approval.ts";
import type { TincanConfig } from "./config.ts";
import type { Log } from "./log.ts";
import { failure, text } from "./tool.ts";

export const DESK = "issue-desk";
export const ANSWERED = 0;
export const PENDING = 2;

export const sentText = (id: string) => `Sent to the fleet, request ${id}`;
export const failedText = (reason: string) => `The fleet request failed: ${reason}`;

export type RunResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

export type Run = (bin: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<RunResult>;

const defaultRun: Run = (bin, args, env) =>
  new Promise((resolve, reject) => {
    execFile(bin, [...args], { env, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) resolve({ code: 0, stdout, stderr });
      else if (typeof error.code === "number") resolve({ code: error.code, stdout, stderr });
      else reject(error);
    });
  });

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

const at = (value: unknown, ...path: readonly string[]) =>
  path.reduce<unknown>((node, key) => (typeof node === "object" && node !== null ? (node as Record<string, unknown>)[key] : undefined), value);

const lineAt = (value: unknown, ...path: readonly string[]) => {
  const found = at(value, ...path);
  return typeof found === "string" ? oneLine(found) : "";
};

const parse = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

export function createFleetTools(config: TincanConfig, log: Log, run: Run = defaultRun): readonly AnyGuardedTool[] {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TINCAN_CONFIG: config.config };

  const request = defineTool({
    name: "fleet_request",
    description: `Send one request for a change to a product, such as a fix or a new feature, to the fleet's ${DESK}, which turns it into an issue. Call it only when Nish clearly asks for such a change, and write the request as one plain sentence. Tell Nish the one line it returns.`,
    parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
    replay: "unsafe",
    execute: async (args) => {
      let result: RunResult;
      try {
        result = await run(config.bin, ["ask", DESK, "--json", "--", oneLine(args.text)], env);
      } catch (error) {
        log("fleet_unreachable", { error: error instanceof Error ? error.name : "unknown" });
        return failure(failedText("the tincan client could not be started"));
      }
      const answer = parse(result.stdout);
      const id = lineAt(answer, "result", "request", "id");
      const reply = lineAt(answer, "result", "reply", "body");
      log("fleet_request", { code: result.code, id });
      if (result.code === ANSWERED) return reply ? text(reply) : failure(failedText("the fleet answered with nothing"));
      if (result.code === PENDING) return id ? text(sentText(id)) : failure(failedText("no request id came back"));
      return failure(failedText(reply || oneLine(result.stderr) || `exit ${result.code}`));
    },
  });

  return [request] as readonly AnyGuardedTool[];
}
