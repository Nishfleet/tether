import { mkdirSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ProcessOutput, SpacesdClientLike } from "@trycua/cua";
import type { ComputerConfig } from "./config.ts";
import type { Log } from "./log.ts";

export const DEFAULT_TIMEOUT_SEC = 120;
export const MAX_TIMEOUT_SEC = 900;
export const OUTPUT_CHARS = 20000;
export const READ_BYTES = 100000;
export const PROBE_TIMEOUT_MS = 5000;
export const UNREACHABLE = "My computer is off right now; the server restarts it at boot.";

export type BashResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number | undefined;
  readonly timedOut: boolean;
  readonly error?: string | undefined;
};

export type SpaceClient = Pick<SpacesdClientLike, "sh" | "upload">;

export type Connect = (config: ComputerConfig) => Promise<SpaceClient>;

export type ComputerDeps = {
  readonly connect?: Connect;
};

export type Computer = {
  readonly tools: readonly ToolRegistration[];
  startup(): Promise<void>;
};

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
const failure = (value: string) => ({ ...text(value), isError: true as const });

const tail = (value: string) => (value.length > OUTPUT_CHARS ? `[earlier output cut]\n${value.slice(-OUTPUT_CHARS)}` : value);

export function formatBash(result: BashResult): string {
  const parts = [result.timedOut ? "timed out" : `exit code ${result.exitCode ?? "unknown"}`];
  if (result.error) parts.push(`error: ${result.error}`);
  if (result.stdout) parts.push(`stdout:\n${tail(result.stdout)}`);
  if (result.stderr) parts.push(`stderr:\n${tail(result.stderr)}`);
  return parts.join("\n");
}

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export const readCommand = (path: string) => `head -c ${READ_BYTES} -- ${shellQuote(path)}`;

const succeeded = (result: BashResult) => !result.timedOut && !result.error && result.exitCode === 0;

const decode = (data: ArrayBuffer) => new TextDecoder().decode(data);

export const toBash = (output: ProcessOutput): BashResult => ({
  stdout: decode(output.stdout),
  stderr: decode(output.stderr),
  exitCode: output.exit.code,
  timedOut: output.exit.timedOut,
  error: output.exit.error,
});

const UNREACHABLE_TAGS = new Set(["SpacesdNotAvailable", "Timeout", "Transport", "Closed"]);

export const isUnreachable = (error: unknown) =>
  typeof error === "object" && error !== null && "tag" in error && typeof error.tag === "string" && UNREACHABLE_TAGS.has(error.tag);

const defaultConnect: Connect = async (config) => {
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  const { embedded } = await import("@trycua/cua");
  return embedded({ spacesHome: config.home, envProbeTimeoutMs: PROBE_TIMEOUT_MS }).spacesd(config.url, config.token);
};

const UPLOAD = { createNew: false, append: false, permissions: 0, createParents: true };

export function createComputer(config: ComputerConfig, log: Log, deps: ComputerDeps = {}): Computer {
  const connect = deps.connect ?? defaultConnect;
  const describeError = (error: unknown) =>
    error instanceof Error ? `${error.name}: ${error.message}`.replaceAll(config.token, "[token]").slice(0, 200) : "unknown";
  let client: Promise<SpaceClient> | undefined;
  const space = () => {
    client ??= connect(config).catch((error: unknown) => {
      client = undefined;
      throw error;
    });
    return client;
  };

  const attempt = async <T extends object>(work: (own: SpaceClient) => Promise<T>) => {
    try {
      return await work(await space());
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      client = undefined;
      return failure(UNREACHABLE);
    }
  };

  const bashMillis = (timeoutSec: number | undefined) => {
    const seconds = Math.trunc(Math.min(MAX_TIMEOUT_SEC, timeoutSec ?? DEFAULT_TIMEOUT_SEC));
    return (Number.isFinite(seconds) ? Math.max(1, seconds) : DEFAULT_TIMEOUT_SEC) * 1000;
  };

  const run = defineTool({
    name: "computer_run",
    description:
      "Run a shell command in your own computer: a persistent Linux machine that keeps its files between conversations. Returns the exit code, stdout and stderr. It is separate from Nish's own computers.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1 }),
      timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_SEC })),
    }),
    replay: "unsafe",
    execute: (args) =>
      attempt(async (own) => {
        const result = toBash(await own.sh(args.command, bashMillis(args.timeoutSec)));
        return succeeded(result) ? text(formatBash(result)) : failure(formatBash(result));
      }),
  });

  const write = defineTool({
    name: "computer_write",
    description: "Write a text file in your own computer, replacing it if it exists.",
    parameters: Type.Object({ path: Type.String({ minLength: 1 }), content: Type.String() }),
    replay: "unsafe",
    execute: (args) =>
      attempt(async (own) => {
        await own.upload(args.path, new TextEncoder().encode(args.content).buffer, UPLOAD);
        return text(`Wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}.`);
      }),
  });

  const read = defineTool({
    name: "computer_read",
    description: `Read a text file from your own computer. Shows at most ${READ_BYTES} bytes.`,
    parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
    replay: "safe",
    execute: (args) =>
      attempt(async (own) => {
        const result = toBash(await own.sh(readCommand(args.path), 60000));
        return succeeded(result) ? text(result.stdout) : failure(formatBash(result));
      }),
  });

  const startup = async () => {
    try {
      await (await space()).sh("true", PROBE_TIMEOUT_MS);
      log("computer_ready");
    } catch (error) {
      client = undefined;
      log("computer_unreachable", { error: describeError(error) });
    }
  };

  return { tools: [run, write, read] as readonly ToolRegistration[], startup };
}
