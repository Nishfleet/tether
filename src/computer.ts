import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { SpaceCreateOptions, SpaceInfo } from "@trycua/cua";
import { type AnyGuardedTool, defineAskFirstTool } from "./approval.ts";
import type { ComputerConfig } from "./config.ts";
import type { Log } from "./log.ts";

export const JOB_PREFIX = "tether-job-";
export const MAC_ASLEEP = "Nish's Mac is asleep or not sharing";
export const DEFAULT_TIMEOUT_SEC = 120;
export const MAX_TIMEOUT_SEC = 900;
export const OUTPUT_CHARS = 20000;
export const READ_BYTES = 100000;
export const MESSAGES_DEFAULT = 10;
export const MESSAGES_MAX = 50;
export const MESSAGES_DB = "$HOME/Library/Messages/chat.db";

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
  screenshot(options: undefined): Promise<{ readonly image: ArrayBuffer; readonly format: number }>;
  spacesd(): {
    click(x: number, y: number): Promise<unknown>;
    typeText(text: string): Promise<unknown>;
    press(key: string): Promise<unknown>;
    hotkey(keys: string[]): Promise<unknown>;
  };
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

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export const appleScriptString = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", "\\r").replaceAll("\n", "\\n")}"`;

export function sendScript(to: string, body: string): string[] {
  return [
    'tell application "Messages"',
    "set targetService to 1st service whose service type = iMessage",
    `set targetBuddy to buddy ${appleScriptString(to)} of targetService`,
    `send ${appleScriptString(body)} to targetBuddy`,
    "end tell",
  ];
}

export const sendCommand = (to: string, body: string) =>
  `osascript ${sendScript(to, body)
    .map((line) => `-e ${shellQuote(line)}`)
    .join(" ")}`;

export const clampLimit = (limit: number | undefined) => {
  const value = Number.isFinite(limit) ? Math.trunc(limit as number) : MESSAGES_DEFAULT;
  return Math.min(MESSAGES_MAX, Math.max(1, value));
};

export const messagesQuery = (limit: number | undefined) =>
  [
    "SELECT datetime(message.date / 1000000000 + 978307200, 'unixepoch') AS date,",
    "handle.id AS sender, message.is_from_me AS is_from_me, message.text AS text",
    "FROM message LEFT JOIN handle ON message.handle_id = handle.ROWID",
    `ORDER BY message.date DESC LIMIT ${clampLimit(limit)};`,
  ].join(" ");

export const messagesCommand = (limit: number | undefined) => `sqlite3 -readonly -json "${MESSAGES_DB}" ${shellQuote(messagesQuery(limit))}`;

const ASLEEP = /stopped sharing|not sharing|asleep|unreachable|not reachable|offline|unauthenticated|unauthorized|not authenticated|host_unavailable|transport|connection (refused|closed|reset|lost)|timed out|timeout|machine .*not (found|online)|no such machine/i;

export const looksAsleep = (error: unknown) => ASLEEP.test(error instanceof Error ? `${error.name} ${error.message}` : String(error));

function serialize() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };
}

const describeError = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "unknown");

async function defaultSpaces(config: ComputerConfig): Promise<SpacesPort> {
  mkdirSync(config.cuaHome, { recursive: true, mode: 0o700 });
  process.env.CUA_HOME = config.cuaHome;
  const { embedded } = await import("@trycua/cua");
  return embedded().spaces();
}

const createOptions = (on: string, name: string): SpaceCreateOptions => ({ on, name, reuse: false, env: new Map(), services: new Map() });

export function createComputer(config: ComputerConfig, log: Log, deps: ComputerDeps = {}): Computer {
  const jobId = deps.jobId ?? (() => randomBytes(4).toString("hex"));
  let client: Promise<SpacesPort> | undefined;
  const spaces = () => {
    client ??= (deps.spaces ?? (() => defaultSpaces(config)))().catch((error: unknown) => {
      client = undefined;
      throw error;
    });
    return client;
  };
  const ensureTurn = serialize();
  const jobTurn = serialize();

  const ensureSpace = (): Promise<SpacePort> =>
    ensureTurn(async () => {
      const api = await spaces();
      const found = (await api.list()).find((entry) => entry.name === config.spaceName);
      if (!found) {
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

  const mac = async <T>(work: (space: SpacePort) => Promise<T>) => {
    try {
      return { value: await work(await (await spaces()).space(config.macRef)) };
    } catch (error) {
      if (!looksAsleep(error)) throw error;
      log("mac_unavailable", { error: describeError(error) });
      return undefined;
    }
  };

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
      const made = await jobTurn(async () => {
        const running = (await jobSpaces(api)).length;
        if (running >= config.jobSlots) return running;
        const created = await api.create(createOptions(config.hostRef, name));
        if (!created.space) throw new Error(`Space ${name} was not created`);
        return created.space;
      });
      if (typeof made === "number") return failure(`Refused: ${made} job machines are already running and the limit is ${config.jobSlots}. Try again later.`);
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

  const status = defineAskFirstTool({
    name: "mac_status",
    description: "Check whether Nish's Mac is reachable right now (awake and sharing). It never fails when the Mac is asleep; it says so.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => {
      const reached = await mac((space) => space.bash("true", 15000n));
      return text(reached ? "Nish's Mac is awake and sharing." : `${MAC_ASLEEP}.`);
    },
  });

  const messages = defineAskFirstTool({
    name: "mac_read_messages",
    description: `Read the latest iMessages on Nish's Mac, newest first: date, sender handle, is_from_me and text. At most ${MESSAGES_MAX}, default ${MESSAGES_DEFAULT}. Read only.`,
    parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MESSAGES_MAX })) }),
    replay: "safe",
    execute: async (args) => {
      const reached = await mac((space) => space.bash(messagesCommand(args.limit), 30000n));
      if (!reached) return failure(MAC_ASLEEP);
      const result = reached.value;
      return succeeded(result) ? text(tail(result.stdout.trim() || "[]")) : failure(formatBash(result));
    },
  });

  const send = defineAskFirstTool({
    name: "mac_send_message",
    description: "Send an iMessage from Nish's Mac, as Nish. Needs Nish's approval first. `to` is a phone number or email handle.",
    parameters: Type.Object({ to: Type.String({ minLength: 1, maxLength: 200 }), text: Type.String({ minLength: 1, maxLength: 4000 }) }),
    askFirst: true,
    replay: "unsafe",
    execute: async (args) => {
      const reached = await mac((space) => space.bash(sendCommand(args.to, args.text), 30000n));
      if (!reached) return failure(MAC_ASLEEP);
      return succeeded(reached.value) ? text(`Sent to ${args.to}.`) : failure(formatBash(reached.value));
    },
  });

  const MIME = ["image/png", "image/jpeg", "image/webp"];

  const shot = defineAskFirstTool({
    name: "mac_screenshot",
    description: "Take a screenshot of Nish's Mac screen.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => {
      const reached = await mac((space) => space.screenshot(undefined));
      if (!reached) return failure(MAC_ASLEEP);
      const { image, format } = reached.value;
      return { output: [{ type: "image" as const, data: Buffer.from(image).toString("base64"), mimeType: MIME[format] ?? "image/png" }] };
    },
  });

  const act = defineAskFirstTool({
    name: "mac_act",
    description:
      "Do one action on Nish's Mac, as Nish. Needs Nish's approval first. action click needs x and y; type needs text; key needs key (a key name like Return, or a combination like cmd+c); run needs command (a shell command, with optional timeoutSec).",
    parameters: Type.Object({
      action: StringEnum(["click", "type", "key", "run"] as const),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
      text: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_SEC })),
    }),
    askFirst: true,
    replay: "unsafe",
    execute: async (args) => {
      const missing = (...names: string[]) => failure(`mac_act ${args.action} needs ${names.join(" and ")}.`);
      if (args.action === "click" && (args.x === undefined || args.y === undefined)) return missing("x", "y");
      if (args.action === "type" && args.text === undefined) return missing("text");
      if (args.action === "key" && !args.key) return missing("key");
      if (args.action === "run" && !args.command) return missing("command");
      const done = await mac(async (space) => {
        if (args.action === "click") await space.spacesd().click(args.x as number, args.y as number);
        else if (args.action === "type") await space.spacesd().typeText(args.text as string);
        else if (args.action === "key") {
          const key = args.key as string;
          if (key.includes("+")) await space.spacesd().hotkey(key.split("+").map((part) => part.trim()));
          else await space.spacesd().press(key);
        } else return space.bash(args.command as string, bashSeconds(args.timeoutSec));
        return undefined;
      });
      if (!done) return failure(MAC_ASLEEP);
      if (done.value === undefined) return text(`Done: ${args.action}.`);
      return succeeded(done.value) ? text(formatBash(done.value)) : failure(formatBash(done.value));
    },
  });

  const startup = async () => {
    if (!config.hostRef) return;
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

  const linux = config.hostRef ? [run, write, read, job] : [];
  const macTools = config.macRef ? [status, messages, send, shot, act] : [];
  return { tools: [...linux, ...macTools] as readonly AnyGuardedTool[], startup };
}
