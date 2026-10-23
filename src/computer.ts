import { randomBytes } from "node:crypto";
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

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export const readCommand = (path: string) =>
  `f=${shellQuote(path)}; if [ ! -f "$f" ]; then echo "not a regular file" >&2; exit 3; fi; if [ ! -r "$f" ]; then echo "not readable" >&2; exit 4; fi; wc -c < "$f"; head -c ${READ_BYTES} -- "$f" | base64 -w0`;

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

export const NOT_OURS = "refused: not a Tether Space";

export function guardSpaces(api: SpacesPort, config: Pick<ComputerConfig, "spaceName" | "hostRef">): SpacesPort {
  const ownName = (name: string | undefined) => name === config.spaceName || (name !== undefined && name.startsWith(JOB_PREFIX));
  const ours = async (ref: string) => {
    const all = await api.list();
    const byId = all.filter((entry) => entry.id === ref);
    const matches = byId.length > 0 ? byId : all.filter((entry) => entry.name === ref);
    if (matches.length === 0 || !matches.every((entry) => ownName(entry.name) && onHost(entry, config.hostRef))) throw new Error(NOT_OURS);
  };
  return {
    list: () => api.list(),
    create: async (options) => {
      if (!ownName(options.name) || (options.on ?? "") !== config.hostRef) throw new Error(NOT_OURS);
      return api.create(options);
    },
    space: async (ref) => {
      await ours(ref);
      return api.space(ref);
    },
    start: async (ref) => {
      await ours(ref);
      return api.start(ref);
    },
    delete_: async (ref) => {
      await ours(ref);
      return api.delete_(ref);
    },
  };
}

export function createComputer(config: ComputerConfig, log: Log, deps: ComputerDeps = {}): Computer {
  const jobId = deps.jobId ?? (() => randomBytes(4).toString("hex"));
  const describeError = (error: unknown) =>
    error instanceof Error ? `${error.name}: ${error.message}`.replaceAll(config.token || "\0", "[token]").slice(0, 200) : "unknown";
  let client: Promise<SpacesPort> | undefined;
  const spaces = () => {
    client ??= (deps.spaces ?? (() => defaultSpaces(config, deps.connect)))()
      .then((api) => guardSpaces(api, config))
      .catch((error: unknown) => {
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
      const found = all.find((entry) => entry.name === config.spaceName && onHost(entry, config.hostRef));
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

  const jobSpaces = async (api: SpacesPort) => (await api.list()).filter((entry) => entry.name.startsWith(JOB_PREFIX) && onHost(entry, config.hostRef));

  const bashSeconds = (timeoutSec: number | undefined) => {
    const seconds = Math.trunc(Math.min(MAX_TIMEOUT_SEC, timeoutSec ?? DEFAULT_TIMEOUT_SEC));
    return BigInt((Number.isFinite(seconds) ? Math.max(1, seconds) : DEFAULT_TIMEOUT_SEC) * 1000);
  };
  const inflight = new Set<string>();

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
      const result = await (await ensureSpace()).bash(readCommand(args.path), 60000n);
      if (!succeeded(result)) return failure(formatBash(result));
      const newline = result.stdout.indexOf("\n");
      const size = Number(result.stdout.slice(0, newline < 0 ? undefined : newline).trim());
      const data = Buffer.from(newline < 0 ? "" : result.stdout.slice(newline + 1).trim(), "base64");
      if (!Number.isInteger(size) || data.length !== Math.min(size, READ_BYTES)) return failure(`${args.path} could not be read in full.`);
      if (data.includes(0)) return failure(`${args.path} is a binary file.`);
      const shown = data.toString("utf8");
      return text(size > data.length ? `${shown}\n[cut at ${data.length} bytes of ${size}]` : shown);
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
        const listed = await api.list();
        const gone = new Set<string>();
        for (const leaked of listed.filter((entry) => entry.name.startsWith(JOB_PREFIX) && onHost(entry, config.hostRef) && !inflight.has(entry.name))) {
          try {
            await api.delete_(leaked.id);
            gone.add(leaked.id);
            log("job_space_swept", { name: leaked.name });
          } catch (error) {
            log("job_space_leaked", { name: leaked.name, error: describeError(error) });
          }
        }
        const all = listed.filter((entry) => !gone.has(entry.id));
        const running = all.filter((entry) => entry.name.startsWith(JOB_PREFIX) && onHost(entry, config.hostRef)).length;
        if (running >= config.jobSlots) return `Refused: ${running} job machines are already running and the limit is ${config.jobSlots}. Try again later.`;
        if (hostUsed(all) >= config.hostSlots) return hostSlotsFull(config.hostSlots);
        const created = await api.create(createOptions(config.hostRef, name));
        if (!created.space) throw new Error(`Space ${name} was not created`);
        inflight.add(name);
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
        } finally {
          inflight.delete(name);
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
