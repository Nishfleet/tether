import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SpaceCreateOptions, SpaceInfo } from "@trycua/cua";
import { startTether, type Tether } from "../src/app.ts";
import { type BashResult, createComputer, type SpacePort, type SpacesPort } from "../src/computer.ts";
import { type ComputerConfig, JOB_PREFIX, loadConfig } from "../src/config.ts";
import { createModelAccess } from "../src/model.ts";
import { ALLOWED, FakeChannel, FakeModel, KEY, SPACE, call, inbound, say } from "./helpers.ts";

const opts = { timeout: 30000 };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const TOKEN = "secret-token-value";
const CONFIG: ComputerConfig = { url: "http://127.0.0.1:7777", token: TOKEN, spaceName: "tether", hostRef: "host:test", jobSlots: 2, hostSlots: 4 };
const OK: BashResult = { stdout: "hello\n", stderr: "", exitCode: 0, timedOut: false };

const info = (name: string, id: string, powerState = "running", host = "test"): SpaceInfo => ({ id, name, powerState, host, hostName: host }) as SpaceInfo;

class FakeSpace implements SpacePort {
  readonly commands: string[] = [];
  readonly written: [string, string][] = [];
  result: BashResult = OK;
  failWith: Error | undefined;
  files: Record<string, string> = {};

  bash = async (command: string, _timeoutMs: bigint | undefined) => {
    this.commands.push(command);
    if (this.failWith) throw this.failWith;
    return this.result;
  };
  write = async (path: string, content: ArrayBuffer) => {
    this.written.push([path, Buffer.from(content).toString("utf8")]);
  };
  download = async (remotePath: string, destDir: string) => {
    const body = this.files[remotePath];
    if (body === undefined) throw new Error("not found");
    writeFileSync(join(destDir, remotePath.split("/").pop() as string), body);
    return { dest: destDir };
  };
}

class FakeSpaces implements SpacesPort {
  entries: SpaceInfo[] = [];
  readonly spaces = new Map<string, FakeSpace>();
  readonly calls: string[] = [];
  readonly created: SpaceCreateOptions[] = [];
  next = 0;

  list = async () => {
    this.calls.push("list");
    return [...this.entries];
  };
  create = async (options: SpaceCreateOptions) => {
    this.calls.push(`create ${options.name}`);
    this.created.push(options);
    const made = info(options.name as string, `id-${(this.next += 1)}`);
    this.entries.push(made);
    return { space: made };
  };
  space = async (ref: string) => {
    const found = this.spaces.get(ref) ?? new FakeSpace();
    this.spaces.set(ref, found);
    return found;
  };
  start = async (ref: string) => {
    this.calls.push(`start ${ref}`);
    const entry = this.entries.find((candidate) => candidate.id === ref);
    if (entry) entry.powerState = "running";
  };
  delete_ = async (ref: string) => {
    this.calls.push(`delete ${ref}`);
    this.entries = this.entries.filter((candidate) => candidate.id !== ref);
  };
}

function build(fake: FakeSpaces, config: ComputerConfig = CONFIG, ids: string[] = ["a1", "b2", "c3", "d4"]) {
  const logs: string[] = [];
  const computer = createComputer(config, (event) => void logs.push(event), { spaces: async () => fake, jobId: () => ids.shift() as string });
  const tool = (name: string) => {
    const found = computer.tools.find((entry) => entry.name === name);
    assert.ok(found, name);
    return (args: Record<string, unknown>) => found.execute(args as never, undefined as never, undefined as never) as Promise<{ output?: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }>;
  };
  return { computer, logs, tool };
}

const textOf = (result: { output?: { text?: string }[] }) => result.output?.[0]?.text ?? "";

describe("computer extension tools", () => {
  it("offers exactly four tools, none of which asks first, so a new tool forces a decision", () => {
    const { computer } = build(new FakeSpaces());
    assert.deepEqual(computer.tools.map((tool) => tool.name).sort(), ["computer_read", "computer_run", "computer_write", "job_run"]);
    assert.deepEqual(computer.tools.filter((tool) => tool.askFirst !== undefined || tool.money !== undefined).map((tool) => tool.name), []);
  });

  it("replays only the pure read", () => {
    const { computer } = build(new FakeSpaces());
    assert.deepEqual(computer.tools.filter((tool) => tool.replay === "safe").map((tool) => tool.name), ["computer_read"]);
  });

  it("has no Mac tool and no tool that names a Mac", () => {
    const { computer } = build(new FakeSpaces());
    assert.ok(computer.tools.every((tool) => !/\bmac\b|imessage/i.test(`${tool.name} ${tool.description}`)));
  });
});

describe("computer config", () => {
  const base = { TETHER_ALLOWED_SENDER: "a", TETHER_LLM_API_KEY: "k", TETHER_STATE_DIR: "/state" };
  const cua = { ...base, TETHER_CUA_URL: "http://127.0.0.1:7777", TETHER_CUA_TOKEN: TOKEN };

  it("registers nothing unless the daemon URL is set, whatever the token", () => {
    assert.equal(loadConfig(base).computer, undefined);
    assert.equal(loadConfig({ ...base, TETHER_CUA_URL: " " }).computer, undefined);
    assert.equal(loadConfig({ ...base, TETHER_CUA_TOKEN: TOKEN }).computer, undefined);
  });

  it("works with a socket path and no token", () => {
    const computer = loadConfig({ ...base, TETHER_CUA_URL: "/run/cua-agents/cua.sock" }).computer;
    assert.equal(computer?.url, "/run/cua-agents/cua.sock");
    assert.equal(computer?.token, "");
  });

  it("accepts a socket path or a loopback URL only, and never echoes the token", () => {
    for (const url of ["http://127.0.0.1:7777", "http://localhost:7777", "http://[::1]:7777", "/run/cua.sock"]) {
      assert.equal(loadConfig({ ...cua, TETHER_CUA_URL: url }).computer?.url, url);
    }
    for (const url of ["http://example.com:7777", "http://10.0.0.5:7777", "ftp://127.0.0.1", "not a url", "run/cua.sock"]) {
      assert.throws(
        () => loadConfig({ ...cua, TETHER_CUA_URL: url }),
        (error: Error) => /TETHER_CUA_URL must be an absolute socket path or an http\(s\) loopback URL/.test(error.message) && !error.message.includes(TOKEN),
        url,
      );
    }
  });

  it("calls connect with the token when there is one and with the URL alone when there is not", async () => {
    const seen: unknown[][] = [];
    const connect = (...address: unknown[]) => {
      seen.push(address);
      return { spaces: () => new FakeSpaces() };
    };
    for (const config of [CONFIG, { ...CONFIG, url: "/run/cua.sock", token: "" }]) {
      await createComputer(config, () => undefined, { connect: connect as never }).tools.find((tool) => tool.name === "computer_run")!.execute({ command: "true" } as never, undefined as never, undefined as never);
    }
    assert.deepEqual(seen, [[CONFIG.url, TOKEN], ["/run/cua.sock"]]);
  });

  it("defaults the Space name to tether, two job slots and four host slots", () => {
    assert.deepEqual(loadConfig(cua).computer, {
      url: "http://127.0.0.1:7777",
      token: TOKEN,
      spaceName: "tether",
      hostRef: "",
      jobSlots: 2,
      hostSlots: 4,
    });
  });

  it("takes every setting from the environment and rejects bad numbers and a job-like Space name", () => {
    const env = { ...cua, TETHER_CUA_HOST: "h", TETHER_CUA_SPACE: "box", TETHER_CUA_JOB_SLOTS: "1", TETHER_CUA_HOST_SLOTS: "6" };
    assert.deepEqual(loadConfig(env).computer, { url: "http://127.0.0.1:7777", token: TOKEN, spaceName: "box", hostRef: "h", jobSlots: 1, hostSlots: 6 });
    assert.throws(() => loadConfig({ ...env, TETHER_CUA_JOB_SLOTS: "9" }), /TETHER_CUA_JOB_SLOTS/);
    assert.throws(() => loadConfig({ ...env, TETHER_CUA_JOB_SLOTS: "x" }), /TETHER_CUA_JOB_SLOTS/);
    assert.throws(() => loadConfig({ ...env, TETHER_CUA_HOST_SLOTS: "-1" }), /TETHER_CUA_HOST_SLOTS/);
    assert.throws(() => loadConfig({ ...env, TETHER_CUA_SPACE: "tether-job-x" }), /TETHER_CUA_SPACE/);
  });
});

describe("ensure Space", () => {
  it("creates its Space on the host provider when missing", async () => {
    const fake = new FakeSpaces();
    await build(fake).tool("computer_run")({ command: "uname" });
    assert.deepEqual(fake.calls, ["list", "create tether"]);
    assert.equal(fake.created[0]?.on, "host:test");
  });

  it("leaves the daemon's default location when no host is configured", async () => {
    const fake = new FakeSpaces();
    await build(fake, { ...CONFIG, hostRef: "" }).tool("computer_run")({ command: "uname" });
    assert.equal("on" in (fake.created[0] as object), false);
  });

  it("refuses to create its own Space when every host slot is taken, and touches nobody else's", async () => {
    const fake = new FakeSpaces();
    fake.entries = [info("desk", "d1"), info("agent-a", "a1"), info("agent-b", "b1"), info("agent-c", "c1")];
    const { computer, logs } = build(fake);
    await assert.rejects(computer.tools.find((tool) => tool.name === "computer_run")!.execute({ command: "x" } as never, undefined as never, undefined as never), /the server's 4 Spaces are all in use/);
    await computer.startup();
    assert.ok(logs.includes("computer_startup_failed"));
    assert.deepEqual(fake.calls.filter((entry) => entry !== "list"), []);
    assert.equal(fake.entries.length, 4);
  });

  it("does not count another host's Spaces against this host's slots", async () => {
    const fake = new FakeSpaces();
    fake.entries = [info("a", "1"), info("b", "2"), info("c", "3"), info("d", "4", "running", "elsewhere")];
    await build(fake).tool("computer_run")({ command: "x" });
    assert.ok(fake.calls.includes("create tether"));
  });

  it("creates every Space with an empty environment and sends the token nowhere", async () => {
    const fake = new FakeSpaces();
    const { tool } = build(fake);
    await tool("computer_run")({ command: "echo hi" });
    await tool("job_run")({ command: "echo hi" });
    assert.equal(fake.created.length, 2);
    assert.ok(fake.created.every((options) => options.env.size === 0 && options.command === undefined && options.services.size === 0));
    const everything = JSON.stringify([fake.created, [...fake.spaces.values()].map((space) => space.commands)], (_key, value) => (value instanceof Map ? [...value] : value));
    assert.equal(everything.includes(TOKEN), false);
  });

  it("starts a stopped Space", async () => {
    const fake = new FakeSpaces();
    fake.entries = [info("tether", "id-9", "stopped")];
    await build(fake).tool("computer_run")({ command: "uname" });
    assert.deepEqual(fake.calls, ["list", "start id-9"]);
  });

  it("starts a suspended Space", async () => {
    const fake = new FakeSpaces();
    fake.entries = [info("tether", "id-9", "suspended")];
    await build(fake).tool("computer_run")({ command: "uname" });
    assert.deepEqual(fake.calls, ["list", "start id-9"]);
  });

  it("does nothing to a running Space", async () => {
    const fake = new FakeSpaces();
    fake.entries = [info("tether", "id-9")];
    await build(fake).tool("computer_run")({ command: "uname" });
    assert.deepEqual(fake.calls, ["list"]);
  });

  it("creates only once when two calls arrive together", async () => {
    const fake = new FakeSpaces();
    const { tool } = build(fake);
    await Promise.all([tool("computer_run")({ command: "a" }), tool("computer_run")({ command: "b" })]);
    assert.equal(fake.calls.filter((entry) => entry.startsWith("create")).length, 1);
  });

  it("runs the command and returns the exit code and output, as an error when it fails", async () => {
    const fake = new FakeSpaces();
    const { tool } = build(fake);
    const good = await tool("computer_run")({ command: "echo hello" });
    assert.equal(textOf(good), "exit code 0\nstdout:\nhello\n");
    assert.equal(good.isError, undefined);
    fake.spaces.get("id-1")!.result = { stdout: "", stderr: "boom", exitCode: 2, timedOut: false };
    const bad = await tool("computer_run")({ command: "false" });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /exit code 2\nstderr:\nboom/);
  });

  it("writes and reads files in its own Space", async () => {
    const fake = new FakeSpaces();
    const { tool } = build(fake);
    await tool("computer_write")({ path: "/home/a.txt", content: "hi é" });
    assert.deepEqual(fake.spaces.get("id-1")!.written, [["/home/a.txt", "hi é"]]);
    fake.spaces.get("id-1")!.files["/home/a.txt"] = "file body";
    assert.equal(textOf(await tool("computer_read")({ path: "/home/a.txt" })), "file body");
    await assert.rejects(tool("computer_read")({ path: "/missing" }), /not found/);
  });
});

describe("startup", () => {
  it("deletes leftover job Spaces, keeps the others and ensures its own Space", async () => {
    const fake = new FakeSpaces();
    fake.entries = [info(`${JOB_PREFIX}old`, "j1"), info("desk", "d1"), info("tether", "t1")];
    const { computer, logs } = build(fake);
    await computer.startup();
    assert.deepEqual(fake.calls, ["list", "delete j1", "list"]);
    assert.deepEqual(logs, ["job_space_swept", "computer_ready"]);
  });

  it("only ever deletes tether-job-* Spaces, never desk, another agent's Space or a near miss", async () => {
    const fake = new FakeSpaces();
    const others = ["desk", "tether", "tether-job", "tether-jobs-1", "mytether-job-1", "Tether-Job-1", "agent-a", "agent-a-tether-job-1"];
    fake.entries = [...others.map((name, index) => info(name, `o${index}`)), info(`${JOB_PREFIX}1`, "j1"), info(`${JOB_PREFIX}2`, "j2")];
    await build(fake).computer.startup();
    assert.deepEqual(fake.calls.filter((entry) => entry.startsWith("delete")), ["delete j1", "delete j2"]);
    assert.deepEqual(fake.entries.map((entry) => entry.name), others);
  });

  it("leaves error text alone when there is no token", async () => {
    const fake = new FakeSpaces();
    fake.list = async () => {
      throw new Error("daemon down");
    };
    const lines: string[] = [];
    const computer = createComputer({ ...CONFIG, token: "" }, (event, fields) => void lines.push(JSON.stringify({ event, ...fields })), { spaces: async () => fake });
    await computer.startup();
    assert.ok(lines.every((line) => line.includes("Error: daemon down")));
  });

  it("never puts the token in a log line", async () => {
    const fake = new FakeSpaces();
    fake.list = async () => {
      throw new Error(`401 for token ${TOKEN}`);
    };
    const lines: string[] = [];
    const computer = createComputer(CONFIG, (event, fields) => void lines.push(JSON.stringify({ event, ...fields })), { spaces: async () => fake });
    await computer.startup();
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => !line.includes(TOKEN) && line.includes("[token]")));
  });

  it("logs a loud error and does not throw when it cannot reach Cua", async () => {
    const fake = new FakeSpaces();
    fake.list = async () => {
      throw new Error("daemon down");
    };
    const { computer, logs } = build(fake);
    await computer.startup();
    assert.deepEqual(logs, ["computer_sweep_failed", "computer_startup_failed"]);
  });
});

describe("job_run", () => {
  it("runs in a fresh named Space and deletes it", async () => {
    const fake = new FakeSpaces();
    const result = await build(fake).tool("job_run")({ command: "echo hello" });
    assert.equal(textOf(result), "exit code 0\nstdout:\nhello\n");
    assert.deepEqual(fake.calls, ["list", "create tether-job-a1", "delete id-1"]);
    assert.equal(fake.entries.length, 0);
  });

  it("deletes the Space even when the command throws", async () => {
    const fake = new FakeSpaces();
    fake.space = async () => {
      const broken = new FakeSpace();
      broken.failWith = new Error("exec failed");
      return broken;
    };
    await assert.rejects(build(fake).tool("job_run")({ command: "x" }), /exec failed/);
    assert.deepEqual(fake.calls, ["list", "create tether-job-a1", "delete id-1"]);
  });

  it("logs a leak instead of failing when the delete fails", async () => {
    const fake = new FakeSpaces();
    fake.delete_ = async () => {
      throw new Error("cannot delete");
    };
    const { tool, logs } = build(fake);
    assert.equal(textOf(await tool("job_run")({ command: "x" })), "exit code 0\nstdout:\nhello\n");
    assert.deepEqual(logs, ["job_space_leaked"]);
  });

  it("refuses at the slot cap without creating anything", async () => {
    const fake = new FakeSpaces();
    fake.entries = [info(`${JOB_PREFIX}1`, "j1"), info(`${JOB_PREFIX}2`, "j2"), info("tether", "t1")];
    const result = await build(fake).tool("job_run")({ command: "x" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Refused: 2 job machines are already running and the limit is 2/);
    assert.deepEqual(fake.calls, ["list"]);
  });

  it("refuses when the server's Spaces are all in use, whoever owns them, without creating anything", async () => {
    const fake = new FakeSpaces();
    fake.entries = [info("desk", "d1"), info("tether", "t1"), info("agent-a", "a1"), info("agent-b", "b1")];
    const result = await build(fake).tool("job_run")({ command: "x" });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "Refused: the server's 4 Spaces are all in use. Try again later.");
    assert.deepEqual(fake.calls, ["list"]);
  });

  it("honours a configured host limit", async () => {
    const fake = new FakeSpaces();
    fake.entries = [info("desk", "d1"), info("tether", "t1")];
    const result = await build(fake, { ...CONFIG, hostSlots: 2 }).tool("job_run")({ command: "x" });
    assert.equal(textOf(result), "Refused: the server's 2 Spaces are all in use. Try again later.");
  });

  it("applies the per-Tether job cap as well, before the host limit", async () => {
    const fake = new FakeSpaces();
    fake.entries = [info(`${JOB_PREFIX}1`, "j1"), info(`${JOB_PREFIX}2`, "j2")];
    const result = await build(fake, { ...CONFIG, hostSlots: 2 }).tool("job_run")({ command: "x" });
    assert.match(textOf(result), /Refused: 2 job machines are already running and the limit is 2/);
  });

  it("never exceeds the host limit when its own Space and a job are created together", async () => {
    const fake = new FakeSpaces();
    fake.entries = [info("desk", "d1"), info("agent-a", "a1")];
    const { tool } = build(fake, { ...CONFIG, hostSlots: 3 });
    const results = await Promise.allSettled([tool("computer_run")({ command: "a" }), tool("job_run")({ command: "b" })]);
    assert.equal(fake.entries.length <= 3, true);
    assert.equal(results.filter((entry) => entry.status === "rejected" || entry.value.isError === true).length, 1);
  });

  it("counts only job Spaces against the cap", async () => {
    const fake = new FakeSpaces();
    fake.entries = [info(`${JOB_PREFIX}1`, "j1"), info("tether", "t1"), info("desk", "d1")];
    const result = await build(fake).tool("job_run")({ command: "x" });
    assert.equal(result.isError, undefined);
  });

  it("never exceeds the cap when jobs start together", async () => {
    const fake = new FakeSpaces();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    fake.space = async () => {
      await gate;
      return new FakeSpace();
    };
    const { tool } = build(fake, { ...CONFIG, jobSlots: 1 });
    const running = [tool("job_run")({ command: "a" }), tool("job_run")({ command: "b" })];
    await pause(50);
    open();
    const results = await Promise.all(running);
    assert.deepEqual(results.map((entry) => entry.isError === true).sort(), [false, true]);
  });
});

describe("computer tools through the real hook", () => {
  let dir: string;
  let model: FakeModel;
  let channel: FakeChannel;
  let tether: Tether | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tether-computer-"));
    model = new FakeModel();
    await model.start();
    channel = new FakeChannel();
  });

  afterEach(async () => {
    await tether?.stop();
    tether = undefined;
    await model.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a computer command and a job at once, with no question to Nish", opts, async () => {
    const fake = new FakeSpaces();
    const { computer } = build(fake);
    model.enqueue(call("computer_run", { command: "date" }), call("job_run", { command: "echo hi" }), say("All done."));
    const { models, ref } = createModelAccess({ baseUrl: model.url, apiKey: KEY });
    tether = await startTether({
      channel,
      models,
      model: ref,
      storage: await openNodeSqliteStorage(join(dir, "t.sqlite")),
      allowedSender: ALLOWED,
      salt: "test-salt",
      log: () => undefined,
      retryBaseMs: 5,
      settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 5 }, stream: { maxRetries: 0 } },
      tools: computer.tools,
    });
    channel.push(inbound("m1", "check the date then run a job"));
    await channel.sentCount(1);
    assert.deepEqual(channel.sent.map((entry) => entry.text), ["All done."]);
    assert.equal(fake.spaces.get("id-1")!.commands.length, 1);
    assert.equal(fake.spaces.get("id-2")!.commands.length, 1);
    assert.equal(fake.entries.some((entry) => entry.name.startsWith(JOB_PREFIX)), false, "the job Space was deleted");
  });
});
