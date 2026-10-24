import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ProcessOutput } from "@trycua/cua";
import { startTether, type Tether } from "../src/app.ts";
import { createComputer, type SpaceClient, UNREACHABLE } from "../src/computer.ts";
import { type ComputerConfig, loadConfig } from "../src/config.ts";
import { createModelAccess } from "../src/model.ts";
import { ALLOWED, FakeChannel, FakeModel, KEY, call, inbound, say } from "./helpers.ts";

const opts = { timeout: 30000 };

const TOKEN = "secret-token-value";
const CONFIG: ComputerConfig = { url: "http://127.0.0.1:7777", token: TOKEN, home: "/state/cua" };

const bytes = (value: string) => new TextEncoder().encode(value).buffer;

const output = (stdout: string, stderr = "", code: number | undefined = 0, timedOut = false, error?: string): ProcessOutput => ({
  exit: { code, timedOut, success: code === 0, ...(error === undefined ? {} : { error }) },
  stdout: bytes(stdout),
  stderr: bytes(stderr),
  pty: bytes(""),
});

const unreachable = (message = "nothing answered") => Object.assign(new Error(message), { tag: "SpacesdNotAvailable" });

class FakeSpace implements SpaceClient {
  readonly commands: string[] = [];
  readonly written: [string, string][] = [];
  readonly timeouts: (number | undefined)[] = [];
  result: ProcessOutput = output("hello\n");
  failWith: Error | undefined;
  shell = false;

  sh = async (line: string, timeoutMs: number | undefined) => {
    this.commands.push(line);
    this.timeouts.push(timeoutMs);
    if (this.failWith) throw this.failWith;
    if (!this.shell) return this.result;
    try {
      return output(execFileSync("sh", ["-c", line], { encoding: "utf8", maxBuffer: 1 << 24 }));
    } catch (error) {
      const failed = error as { status: number; stderr: string };
      return output("", failed.stderr, failed.status);
    }
  };
  upload = async (path: string, data: ArrayBuffer) => {
    if (this.failWith) throw this.failWith;
    this.written.push([path, Buffer.from(data).toString("utf8")]);
    return {} as never;
  };
}

function build(fake: FakeSpace, config: ComputerConfig = CONFIG) {
  const logs: string[] = [];
  const connected: ComputerConfig[] = [];
  const computer = createComputer(config, (event, fields) => void logs.push(JSON.stringify({ event, ...fields })), {
    connect: async (seen) => {
      connected.push(seen);
      return fake;
    },
  });
  const tool = (name: string) => {
    const found = computer.tools.find((entry) => entry.name === name);
    assert.ok(found, name);
    return (args: Record<string, unknown>) => found.execute(args as never, undefined as never, undefined as never) as Promise<{ output?: { type: string; text?: string }[]; isError?: boolean }>;
  };
  return { computer, logs, connected, tool };
}

const textOf = (result: { output?: { text?: string }[] }) => result.output?.[0]?.text ?? "";

describe("computer extension tools", () => {
  it("offers exactly three tools, none of which asks first, so a new tool forces a decision", () => {
    const { computer } = build(new FakeSpace());
    assert.deepEqual(computer.tools.map((tool) => tool.name).sort(), ["computer_read", "computer_run", "computer_write"]);
    assert.deepEqual(computer.tools.filter((tool) => "askFirst" in tool).map((tool) => tool.name), []);
  });

  it("replays only the pure read", () => {
    const { computer } = build(new FakeSpace());
    assert.deepEqual(computer.tools.filter((tool) => tool.replay === "safe").map((tool) => tool.name), ["computer_read"]);
  });
});

describe("computer config", () => {
  const base = { TETHER_ALLOWED_SENDER: "a", TETHER_LLM_API_KEY: "k", TETHER_STATE_DIR: "/state" };
  const space = { ...base, TETHER_SPACE_URL: "http://127.0.0.1:7777", TETHER_SPACE_TOKEN: TOKEN };

  it("registers the tools only when both the URL and the token are set", () => {
    assert.equal(loadConfig(base).computer, undefined);
    assert.equal(loadConfig({ ...base, TETHER_SPACE_URL: "http://127.0.0.1:7777" }).computer, undefined);
    assert.equal(loadConfig({ ...base, TETHER_SPACE_TOKEN: TOKEN }).computer, undefined);
    assert.equal(loadConfig({ ...space, TETHER_SPACE_TOKEN: " " }).computer, undefined);
    assert.equal(loadConfig({ ...space, TETHER_SPACE_URL: " " }).computer, undefined);
    assert.deepEqual(loadConfig(space).computer, { url: "http://127.0.0.1:7777", token: TOKEN, home: "/state/cua" });
  });

  it("ignores the old daemon variables", () => {
    const old = { ...base, TETHER_CUA_URL: "/run/cua-agents/cua.sock", TETHER_CUA_TOKEN: TOKEN, TETHER_CUA_SPACE: "tether" };
    assert.equal(loadConfig(old).computer, undefined);
  });

  it("accepts only an http://127.0.0.1:<port> URL, and never echoes the token", () => {
    for (const url of ["http://localhost:7777", "http://[::1]:7777", "http://10.0.0.5:7777", "https://127.0.0.1:7777", "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:70000", "http://127.0.0.1:7777/x", "/run/cua.sock", "not a url"]) {
      assert.throws(
        () => loadConfig({ ...space, TETHER_SPACE_URL: url }),
        (error: Error) => /TETHER_SPACE_URL must be http:\/\/127\.0\.0\.1:<port>/.test(error.message) && !error.message.includes(TOKEN),
        url,
      );
    }
  });
});

describe("connecting to its Space", () => {
  it("connects lazily with the configured URL and token, once for many calls", async () => {
    const { connected, tool } = build(new FakeSpace());
    assert.deepEqual(connected, []);
    await tool("computer_run")({ command: "true" });
    await tool("computer_run")({ command: "true" });
    assert.deepEqual(connected, [CONFIG]);
  });

  it("clamps a fractional, tiny or huge timeout to whole seconds from 1 to 900", async () => {
    const fake = new FakeSpace();
    const { tool } = build(fake);
    for (const timeoutSec of [0.0005, -5, 1.9, 99999, undefined]) await tool("computer_run")({ command: "x", timeoutSec });
    assert.deepEqual(fake.timeouts, [1000, 1000, 1000, 900000, 120000]);
  });

  it("runs the command and returns the exit code and output, as an error when it fails", async () => {
    const fake = new FakeSpace();
    const { tool } = build(fake);
    const good = await tool("computer_run")({ command: "echo hello" });
    assert.equal(textOf(good), "exit code 0\nstdout:\nhello\n");
    assert.equal(good.isError, undefined);
    fake.result = output("", "boom", 2);
    const bad = await tool("computer_run")({ command: "false" });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /exit code 2\nstderr:\nboom/);
  });

  it("reports a timed out command as an error", async () => {
    const fake = new FakeSpace();
    fake.result = output("", "", undefined, true);
    const result = await build(fake).tool("computer_run")({ command: "sleep 99" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^timed out/);
  });

  it("writes files in its own Space", async () => {
    const fake = new FakeSpace();
    const { tool } = build(fake);
    const result = await tool("computer_write")({ path: "/home/a.txt", content: "hi é" });
    assert.deepEqual(fake.written, [["/home/a.txt", "hi é"]]);
    assert.equal(textOf(result), "Wrote 5 bytes to /home/a.txt.");
  });

  describe("computer_read", () => {
    let dir: string;
    let fake: FakeSpace;
    let read: ReturnType<typeof build>["tool"] extends (name: string) => infer F ? F : never;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "tether-read-"));
      fake = new FakeSpace();
      fake.shell = true;
      read = build(fake).tool("computer_read");
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("returns a small file whole", async () => {
      writeFileSync(join(dir, "a.txt"), "file body é\n");
      assert.equal(textOf(await read({ path: join(dir, "a.txt") })), "file body é\n");
    });

    it("pulls at most the first 100000 bytes of a large file", async () => {
      writeFileSync(join(dir, "big.txt"), "x".repeat(300000));
      const result = await read({ path: join(dir, "big.txt") });
      assert.equal(textOf(result), "x".repeat(100000));
      assert.match(fake.commands.at(-1) as string, /head -c 100000/);
    });

    it("fails on a directory and a missing file", async () => {
      for (const path of [dir, join(dir, "missing")]) {
        const result = await read({ path });
        assert.equal(result.isError, true, path);
      }
    });

    it("fails loudly on an unreadable file instead of returning it empty", { skip: process.getuid?.() === 0 }, async () => {
      const locked = join(dir, "locked.txt");
      writeFileSync(locked, "secret");
      chmodSync(locked, 0);
      const result = await read({ path: locked });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /not readable/);
    });

    it("refuses a FIFO instead of blocking on it", async () => {
      const pipe = join(dir, "pipe");
      execFileSync("mkfifo", [pipe]);
      const result = await read({ path: pipe });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /not a regular file/);
    });

    it("keeps a hostile path inside one quoted word", async () => {
      const hostile = join(dir, "a'; echo pwned; echo 'b");
      writeFileSync(hostile, "safe");
      assert.equal(textOf(await read({ path: hostile })), "safe");
      const result = await read({ path: `${dir}/x'; touch ${dir}/pwned; echo '` });
      assert.equal(result.isError, true);
      assert.equal(existsSync(join(dir, "pwned")), false);
    });
  });
});

describe("when its Space is unreachable", () => {
  const calls = {
    computer_run: { command: "date" },
    computer_write: { path: "/a", content: "x" },
    computer_read: { path: "/a" },
  };

  it("answers every tool with the friendly error and does not throw", async () => {
    const fake = new FakeSpace();
    fake.failWith = unreachable();
    const { tool } = build(fake);
    for (const [name, args] of Object.entries(calls)) {
      const result = await tool(name)(args);
      assert.equal(result.isError, true, name);
      assert.equal(textOf(result), UNREACHABLE, name);
    }
  });

  for (const tag of ["SpacesdNotAvailable", "Timeout", "Transport", "Closed"]) {
    it(`treats ${tag} as off`, async () => {
      const fake = new FakeSpace();
      fake.failWith = Object.assign(new Error("x"), { tag });
      assert.equal(textOf(await build(fake).tool("computer_run")({ command: "date" })), UNREACHABLE);
    });
  }

  it("answers the same when connecting itself fails, and retries the connection next time", async () => {
    let attempts = 0;
    const computer = createComputer(CONFIG, () => undefined, {
      connect: async () => {
        attempts += 1;
        if (attempts === 1) throw unreachable();
        return new FakeSpace();
      },
    });
    const run = computer.tools.find((entry) => entry.name === "computer_run")!;
    const go = () => run.execute({ command: "true" } as never, undefined as never, undefined as never) as Promise<{ output?: { text?: string }[]; isError?: boolean }>;
    const first = await go();
    assert.equal(first.isError, true);
    assert.equal(textOf(first), UNREACHABLE);
    const second = await go();
    assert.equal(second.isError, undefined);
    assert.equal(attempts, 2);
  });

  it("works again once the Space is back", async () => {
    const fake = new FakeSpace();
    const { tool } = build(fake);
    fake.failWith = unreachable();
    assert.equal(textOf(await tool("computer_run")({ command: "date" })), UNREACHABLE);
    fake.failWith = undefined;
    assert.equal(textOf(await tool("computer_run")({ command: "date" })), "exit code 0\nstdout:\nhello\n");
  });

  it("lets an error that is not about reachability through, so a refused key is not called off", async () => {
    const fake = new FakeSpace();
    fake.failWith = Object.assign(new Error("Unauthenticated: missing or invalid bearer token"), { tag: "Unauthenticated" });
    await assert.rejects(() => build(fake).tool("computer_run")({ command: "date" }), /Unauthenticated/);
  });
});

describe("startup", () => {
  it("probes with true and logs computer_ready", async () => {
    const fake = new FakeSpace();
    const { computer, logs } = build(fake);
    await computer.startup();
    assert.deepEqual(fake.commands, ["true"]);
    assert.deepEqual(logs, [JSON.stringify({ event: "computer_ready" })]);
  });

  it("logs computer_unreachable and does not throw when the Space cannot be reached", async () => {
    const fake = new FakeSpace();
    fake.failWith = unreachable();
    const { computer, logs } = build(fake);
    await computer.startup();
    assert.equal(logs.length, 1);
    assert.equal((JSON.parse(logs[0] as string) as { event: string }).event, "computer_unreachable");
  });

  it("logs computer_unreachable and does not throw when connecting fails", async () => {
    const logs: string[] = [];
    const computer = createComputer(CONFIG, (event) => void logs.push(event), {
      connect: async () => {
        throw unreachable();
      },
    });
    await computer.startup();
    assert.deepEqual(logs, ["computer_unreachable"]);
  });

  it("never puts the token in a log line", async () => {
    const fake = new FakeSpace();
    fake.failWith = new Error(`401 for token ${TOKEN}`);
    const { computer, logs } = build(fake);
    await computer.startup();
    assert.equal(logs.length, 1);
    assert.ok(!logs[0]?.includes(TOKEN) && logs[0]?.includes("[token]"));
  });

  it("leaves error text alone when it holds no token", async () => {
    const fake = new FakeSpace();
    fake.failWith = new Error("daemon down");
    const { computer, logs } = build(fake);
    await computer.startup();
    assert.match(logs[0] as string, /Error: daemon down/);
  });

  it("logs nothing at all before it is started", () => {
    const { logs } = build(new FakeSpace());
    assert.deepEqual(logs, []);
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

  it("runs a command and writes a file at once, with no question to Nish", opts, async () => {
    const fake = new FakeSpace();
    const { computer } = build(fake);
    model.enqueue(call("computer_run", { command: "date" }), call("computer_write", { path: "/home/a.txt", content: "hi" }), say("All done."));
    const { models, ref } = createModelAccess({ baseUrl: model.url, apiKey: KEY });
    tether = await startTether({
      channel,
      models,
      model: ref,
      storage: await openNodeSqliteStorage(join(dir, "t.sqlite")),
      allowedSender: ALLOWED,
      log: () => undefined,
      retryBaseMs: 5,
      settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 5 }, stream: { maxRetries: 0 } },
      tools: computer.tools,
    });
    channel.push(inbound("m1", "check the date then write a file"));
    await channel.sentCount(1);
    assert.deepEqual(channel.sent.map((entry) => entry.text), ["All done."]);
    assert.deepEqual(fake.commands, ["date"]);
    assert.deepEqual(fake.written, [["/home/a.txt", "hi"]]);
  });
});
