import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { SpaceCreateOptions, SpaceInfo } from "@trycua/cua";
import { type AnyGuardedTool, defineAskFirstTool } from "./approval.ts";
import { type ComputerConfig, JOB_PREFIX } from "./config.ts";
import type { Log } from "./log.ts";

export const DEFAULT_TIMEOUT_SEC = 120;
export const MAX_TIMEOUT_SEC = 900;
export const OUTPUT_CHARS = 20000;
export const READ_BYTES = 100000;

export type BashResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number | undefined;
  readonly timedOut: boolean;
  readonly error?: string | undefined;
};

export type SpacePort = {
  bash(command: string, timeoutMs: bigint | undefined): Promise<BashResult>;
  write(path: string, content: ArrayBuffer): Promise<unknown>;
  download(remotePath: string, destDir: string): Promise<{ readonly dest: string }>;
};

export type SpacesPort = {
  list(): Promise<SpaceInfo[]>;
  create(options: SpaceCreateOptions): Promise<{ readonly space?: SpaceInfo | undefined }>;
  space(ref: string): Promise<SpacePort>;
  start(ref: string): Promise<unknown>;
  delete_(ref: string): Promise<unknown>;
};

export type ComputerDeps = {
  readonly spaces?: () => Promise<SpacesPort>;
  readonly jobId?: () => string;
  readonly connect?: Connect;
};

export type Computer = {
  readonly tools: readonly AnyGuardedTool[];
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

const succeeded = (result: BashResult) => !result.timedOut && !result.error && result.exitCode === 0;

function serialize() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };
}

export type Connect = (...address: [url: string] | [url: string, token: string]) => { spaces(): SpacesPort };

async function defaultSpaces(config: ComputerConfig, connectOverride: Connect | undefined): Promise<SpacesPort> {
  const connect = connectOverride ?? (await import("@trycua/cua")).connect;
  return (config.token ? connect(config.url, config.token) : connect(config.url)).spaces();
}

const createOptions = (on: string, name: string): SpaceCreateOptions => ({
  ...(on ? { on } : {}),
  name,
  reuse: false,
  env: new Map(),
  services: new Map(),
});

export const hostSlotsFull = (limit: number) => `Refused: the server's ${limit} Spaces are all in use. Try again later.`;

export function onHost(entry: SpaceInfo, hostRef: string): boolean {
  if (!hostRef) return true;
  const wanted = (hostRef.startsWith("host:") ? hostRef.slice("host:".length) : hostRef).toLowerCase();
  return entry.host.toLowerCase() === wanted || entry.hostName.toLowerCase() === wanted;
}

export function createComputer(config: ComputerConfig, log: Log, deps: ComputerDeps = {}): Computer {
  const jobId = deps.jobId ?? (() => randomBytes(4).toString("hex"));
  const describeError = (error: unknown) =>
    error instanceof Error ? `${error.name}: ${error.message}`.replaceAll(config.token || "\0", "[token]").slice(0, 200) : "unknown";
  let client: Promise<SpacesPort> | undefined;
  const spaces = () => {
    client ??= (deps.spaces ?? (() => defaultSpaces(config, deps.connect)))().catch((error: unknown) => {
      client = undefined;
      throw error;
    });
    return client;
  };
  const createTurn = serialize();
  const hostUsed = (all: SpaceInfo[]) => all.filter((entry) => onHost(entry, config.hostRef)).length;

  const ensureSpace = (): Promise<SpacePort> =>
    createTurn(async () => {
      const api = await spaces();
      const all = await api.list();
      const found = all.find((entry) => entry.name === config.spaceName);
      if (!found) {
        if (hostUsed(all) >= config.hostSlots) throw new Error(hostSlotsFull(config.hostSlots));
        const created = await api.create(createOptions(config.hostRef, config.spaceName));
        if (!created.space) throw new Error(`Space ${config.spaceName} was not created`);
        log("computer_space_created", { name: config.spaceName });
        return api.space(created.space.id);
      }
      if (found.powerState === "stopped" || found.powerState === "suspended") {
        await api.start(found.id);
        log("computer_space_started", { name: config.spaceName });
      }
      return api.space(found.id);
    });

  const jobSpaces = async (api: SpacesPort) => (await api.list()).filter((entry) => entry.name.startsWith(JOB_PREFIX));

  const bashSeconds = (timeoutSec: number | undefined) => BigInt(Math.min(MAX_TIMEOUT_SEC, timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000);

  const run = defineAskFirstTool({
    name: "computer_run",
    description:
      "Run a shell command in your own computer: a persistent Linux machine that keeps its files between conversations. Returns the exit code, stdout and stderr. It is separate from Nish's own computers.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1 }),
      timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_SEC })),
    }),
    replay: "unsafe",
    execute: async (args) => {
      const result = await (await ensureSpace()).bash(args.command, bashSeconds(args.timeoutSec));
      return succeeded(result) ? text(formatBash(result)) : failure(formatBash(result));
    },
  });

  const write = defineAskFirstTool({
    name: "computer_write",
    description: "Write a text file in your own computer, replacing it if it exists.",
    parameters: Type.Object({ path: Type.String({ minLength: 1 }), content: Type.String() }),
    replay: "unsafe",
    execute: async (args) => {
      await (await ensureSpace()).write(args.path, new TextEncoder().encode(args.content).buffer);
      return text(`Wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}.`);
    },
  });

  const read = defineAskFirstTool({
    name: "computer_read",
    description: `Read a text file from your own computer. Shows at most ${READ_BYTES} bytes.`,
    parameters: Type.Object({ path: Type.String({ minLength: 1 }) }),
    replay: "safe",
    execute: async (args) => {
      const space = await ensureSpace();
      const dir = mkdtempSync(join(tmpdir(), "tether-read-"));
      try {
        const report = await space.download(args.path, dir);
        const file = statSync(report.dest).isDirectory() ? join(report.dest, basename(args.path)) : report.dest;
        const data = readFileSync(file);
        if (data.includes(0)) return failure(`${args.path} is a binary file.`);
        const shown = data.subarray(0, READ_BYTES).toString("utf8");
        return text(data.length > READ_BYTES ? `${shown}\n[cut at ${READ_BYTES} bytes of ${data.length}]` : shown);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  });

  const job = defineAskFirstTool({
    name: "job_run",
    description:
      "Run one shell command in a brand new throwaway Linux machine that is deleted as soon as the command ends. Use it for anything untrusted or messy. Nothing is kept. Refused when too many jobs are already running.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1 }),
      timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_SEC })),
    }),
    replay: "unsafe",
    execute: async (args) => {
      const api = await spaces();
      const name = `${JOB_PREFIX}${jobId()}`;
      const made = await createTurn(async () => {
        const all = await api.list();
        const running = all.filter((entry) => entry.name.startsWith(JOB_PREFIX)).length;
        if (running >= config.jobSlots) return `Refused: ${running} job machines are already running and the limit is ${config.jobSlots}. Try again later.`;
        if (hostUsed(all) >= config.hostSlots) return hostSlotsFull(config.hostSlots);
        const created = await api.create(createOptions(config.hostRef, name));
        if (!created.space) throw new Error(`Space ${name} was not created`);
        return created.space;
      });
      if (typeof made === "string") return failure(made);
      try {
        const result = await (await api.space(made.id)).bash(args.command, bashSeconds(args.timeoutSec));
        return succeeded(result) ? text(formatBash(result)) : failure(formatBash(result));
      } finally {
        try {
          await api.delete_(made.id);
        } catch (error) {
          log("job_space_leaked", { name, error: describeError(error) });
        }
      }
    },
  });

  const startup = async () => {
    try {
      const api = await spaces();
      for (const entry of await jobSpaces(api)) {
        await api.delete_(entry.id);
        log("job_space_swept", { name: entry.name });
      }
    } catch (error) {
      log("computer_sweep_failed", { error: describeError(error) });
    }
    try {
      await ensureSpace();
      log("computer_ready", { name: config.spaceName });
    } catch (error) {
      log("computer_startup_failed", { name: config.spaceName, error: describeError(error) });
    }
  };

  return { tools: [run, write, read, job] as readonly AnyGuardedTool[], startup };
}
