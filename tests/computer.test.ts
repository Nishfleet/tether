import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SpaceCreateOptions, SpaceInfo } from "@trycua/cua";
import { askText } from "../src/approval.ts";
import { startTether, type Tether } from "../src/app.ts";
import {
  appleScriptString,
  type BashResult,
  clampLimit,
  createComputer,
  MAC_ASLEEP,
  messagesCommand,
  messagesQuery,
  sendCommand,
  sendScript,
  shellQuote,
  type SpacePort,
  type SpacesPort,
} from "../src/computer.ts";
import { type ComputerConfig, JOB_PREFIX, loadConfig } from "../src/config.ts";
import { createModelAccess } from "../src/model.ts";
import { ALLOWED, FakeChannel, FakeModel, KEY, SPACE, call, inbound, say } from "./helpers.ts";

const opts = { timeout: 30000 };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const TOKEN = "secret-token-value";
const CONFIG: ComputerConfig = { url: "http://127.0.0.1:7777", token: TOKEN, spaceName: "tether", hostRef: "host:test", macRef: "relay:mac", jobSlots: 2, hostSlots: 4 };
const OK: BashResult = { stdout: "hello\n", stderr: "", exitCode: 0, timedOut: false };

const info = (name: string, id: string, powerState = "running", host = "test"): SpaceInfo => ({ id, name, powerState, host, hostName: host }) as SpaceInfo;

class FakeSpace implements SpacePort {
  readonly commands: string[] = [];
  readonly written: [string, string][] = [];
  readonly actions: string[] = [];
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
  screenshot = async (_options: undefined) => ({ image: new Uint8Array([1, 2, 3]).buffer, format: 0 });
  spacesd = () => ({
    click: async (x: number, y: number) => void this.actions.push(`click ${x} ${y}`),
    typeText: async (value: string) => void this.actions.push(`type ${value}`),
    press: async (key: string) => void this.actions.push(`press ${key}`),
    hotkey: async (keys: string[]) => void this.actions.push(`hotkey ${keys.join("+")}`),
  });
}

class FakeSpaces implements SpacesPort {
  entries: SpaceInfo[] = [];
  readonly spaces = new Map<string, FakeSpace>();
  readonly calls: string[] = [];
  readonly created: SpaceCreateOptions[] = [];
  failMac: Error | undefined;
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
    if (ref === CONFIG.macRef && this.failMac) throw this.failMac;
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
  mac = () => this.spaces.get(CONFIG.macRef) as FakeSpace;
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
  it("asks first for exactly mac_send_message and mac_act", () => {
    const { computer } = build(new FakeSpaces());
    const asking = computer.tools.filter((tool) => tool.askFirst !== undefined).map((tool) => tool.name);
    assert.deepEqual(asking.sort(), ["mac_act", "mac_send_message"]);
    assert.deepEqual(
      computer.tools.map((tool) => tool.name).sort(),
      ["computer_read", "computer_run", "computer_write", "job_run", "mac_act", "mac_read_messages", "mac_screenshot", "mac_send_message", "mac_status"],
    );
  });

  it("replays only pure reads", () => {
    const { computer } = build(new FakeSpaces());
    const safe = computer.tools.filter((tool) => tool.replay === "safe").map((tool) => tool.name);
    assert.deepEqual(safe.sort(), ["computer_read", "mac_read_messages", "mac_screenshot", "mac_status"]);
  });

  it("offers only the Linux tools without a Mac and only the Mac tools with one", () => {
    const linux = build(new FakeSpaces(), { ...CONFIG, macRef: "" }).computer.tools.map((tool) => tool.name);
    assert.deepEqual(linux.sort(), ["computer_read", "computer_run", "computer_write", "job_run"]);
    assert.ok(build(new FakeSpaces()).computer.tools.some((tool) => tool.name === "mac_status"));
  });
});

describe("computer config", () => {
  const base = { TETHER_ALLOWED_SENDER: "a", TETHER_LLM_API_KEY: "k", TETHER_STATE_DIR: "/state" };
  const cua = { ...base, TETHER_CUA_URL: "http://127.0.0.1:7777", TETHER_CUA_TOKEN: TOKEN };

  it("registers nothing unless both the daemon URL and token are set", () => {
    assert.equal(loadConfig(base).computer, undefined);
    assert.equal(loadConfig({ ...base, TETHER_CUA_URL: " ", TETHER_CUA_TOKEN: " " }).computer, undefined);
  });

  it("names the missing variable of a half-set daemon login and never echoes the token", () => {
    assert.throws(() => loadConfig({ ...base, TETHER_CUA_URL: "http://127.0.0.1:7777" }), /incomplete environment: TETHER_CUA_TOKEN/);
    assert.throws(() => loadConfig({ ...base, TETHER_CUA_TOKEN: TOKEN }), (error: Error) => {
      assert.match(error.message, /TETHER_CUA_URL/);
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      return true;
    });
  });

  it("accepts only a loopback daemon URL, so the token never leaves the host", () => {
    for (const url of ["http://127.0.0.1:7777", "http://localhost:7777", "http://[::1]:7777"]) {
      assert.equal(loadConfig({ ...cua, TETHER_CUA_URL: url }).computer?.url, url);
    }
    for (const url of ["http://example.com:7777", "http://10.0.0.5:7777", "ftp://127.0.0.1", "not a url", "/run/cua.sock"]) {
      assert.throws(
        () => loadConfig({ ...cua, TETHER_CUA_URL: url }),
        (error: Error) => /TETHER_CUA_URL must be an http\(s\) loopback URL/.test(error.message) && !error.message.includes(TOKEN),
        url,
      );
    }
  });

  it("defaults the Space name to tether, two job slots and four host slots", () => {
    assert.deepEqual(loadConfig(cua).computer, {
      url: "http://127.0.0.1:7777",
      token: TOKEN,
      spaceName: "tether",
      hostRef: "",
      macRef: "",
      jobSlots: 2,
      hostSlots: 4,
    });
  });

  it("takes every setting from the environment and rejects bad numbers and a job-like Space name", () => {
    const env = { ...cua, TETHER_CUA_HOST: "h", TETHER_CUA_MAC: "relay:m", TETHER_CUA_SPACE: "box", TETHER_CUA_JOB_SLOTS: "1", TETHER_CUA_HOST_SLOTS: "6" };
    assert.deepEqual(loadConfig(env).computer, { url: "http://127.0.0.1:7777", token: TOKEN, spaceName: "box", hostRef: "h", macRef: "relay:m", jobSlots: 1, hostSlots: 6 });
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

describe("Mac tools", () => {
  it("reports an asleep Mac as a plain status, never an error", async () => {
    const fake = new FakeSpaces();
    fake.failMac = new Error("machine stopped sharing");
    const result = await build(fake).tool("mac_status")({});
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), `${MAC_ASLEEP}.`);
  });

  it("reports an awake Mac", async () => {
    assert.equal(textOf(await build(new FakeSpaces()).tool("mac_status")({})), "Nish's Mac is awake and sharing.");
  });

  for (const reason of ["relay: stopped sharing", "host unreachable", "unauthenticated", "request timed out"]) {
    it(`returns the friendly error when the relay says: ${reason}`, async () => {
      const fake = new FakeSpaces();
      fake.failMac = new Error(reason);
      const { tool } = build(fake);
      for (const [name, args] of [
        ["mac_read_messages", {}],
        ["mac_send_message", { to: "a@b.c", text: "hi" }],
        ["mac_screenshot", {}],
        ["mac_act", { action: "click", x: 1, y: 2 }],
      ] as const) {
        const result = await tool(name)(args);
        assert.equal(result.isError, true, name);
        assert.equal(textOf(result), MAC_ASLEEP, name);
      }
    });
  }

  it("treats an asleep Mac that fails mid-call the same way", async () => {
    const fake = new FakeSpaces();
    const { tool } = build(fake);
    await tool("mac_status")({});
    fake.mac().failWith = new Error("connection lost");
    assert.equal(textOf(await tool("mac_read_messages")({})), MAC_ASLEEP);
  });

  it("does not hide other errors", async () => {
    const fake = new FakeSpaces();
    fake.failMac = new Error("disk full");
    await assert.rejects(build(fake).tool("mac_read_messages")({}), /disk full/);
  });

  it("returns the messages the fixed query printed", async () => {
    const fake = new FakeSpaces();
    const { tool } = build(fake);
    await tool("mac_status")({});
    fake.mac().result = { stdout: '[{"text":"yo"}]\n', stderr: "", exitCode: 0, timedOut: false };
    assert.equal(textOf(await tool("mac_read_messages")({ limit: 3 })), '[{"text":"yo"}]');
    assert.equal(fake.mac().commands.at(-1), messagesCommand(3));
  });

  it("surfaces a failed read, such as missing Full Disk Access", async () => {
    const fake = new FakeSpaces();
    const { tool } = build(fake);
    await tool("mac_status")({});
    fake.mac().result = { stdout: "", stderr: "unable to open database", exitCode: 1, timedOut: false };
    const result = await tool("mac_read_messages")({});
    assert.equal(result.isError, true);
    assert.match(textOf(result), /unable to open database/);
  });

  it("sends through the fixed osascript template", async () => {
    const fake = new FakeSpaces();
    const { tool } = build(fake);
    assert.equal(textOf(await tool("mac_send_message")({ to: "a@b.c", text: "hi" })), "Sent to a@b.c.");
    assert.equal(fake.mac().commands[0], sendCommand("a@b.c", "hi"));
  });

  it("returns the screenshot as an image", async () => {
    const result = await build(new FakeSpaces()).tool("mac_screenshot")({});
    assert.deepEqual(result.output, [{ type: "image", data: "AQID", mimeType: "image/png" }]);
  });

  it("does one action per call and rejects a missing field", async () => {
    const fake = new FakeSpaces();
    const { tool } = build(fake);
    assert.equal(textOf(await tool("mac_act")({ action: "click", x: 3, y: 4 })), "Done: click.");
    await tool("mac_act")({ action: "type", text: "abc" });
    await tool("mac_act")({ action: "key", key: "Return" });
    await tool("mac_act")({ action: "key", key: "cmd+c" });
    assert.deepEqual(fake.mac().actions, ["click 3 4", "type abc", "press Return", "hotkey cmd+c"]);
    assert.equal(textOf(await tool("mac_act")({ action: "run", command: "ls" })), "exit code 0\nstdout:\nhello\n");
    const bad = await tool("mac_act")({ action: "click", x: 1 });
    assert.equal(bad.isError, true);
    assert.equal(textOf(bad), "mac_act click needs x and y.");
    assert.equal(fake.mac().actions.length, 4);
  });
});

describe("osascript escaping", () => {
  it("escapes backslashes, quotes and newlines", () => {
    assert.equal(appleScriptString('say "hi"'), '"say \\"hi\\""');
    assert.equal(appleScriptString("a\\b"), '"a\\\\b"');
    assert.equal(appleScriptString("a\nb\r\nc"), '"a\\nb\\r\\nc"');
    assert.equal(appleScriptString('\\"'), '"\\\\\\""');
  });

  it("keeps hostile text inside the string literal of the template", () => {
    const hostile = '" & (do shell script "rm -rf /") & "';
    const lines = sendScript("a@b.c", hostile);
    assert.equal(lines.length, 5);
    assert.equal(lines[3], `send "\\" & (do shell script \\"rm -rf /\\") & \\"" to targetBuddy`);
    assert.equal(lines[2], 'set targetBuddy to buddy "a@b.c" of targetService');
  });

  it("escapes the recipient too", () => {
    assert.equal(sendScript('x"y', "t")[2], 'set targetBuddy to buddy "x\\"y" of targetService');
  });

  it("survives the shell: every -e argument reaches osascript unchanged", () => {
    const text = `it's "quoted" \\ back\nnew $(touch /tmp/never) \`id\``;
    const command = sendCommand("a'b@c.d", text).replace(/^osascript/, 'printf "%s\\n"');
    const printed = execFileSync("sh", ["-c", command], { encoding: "utf8" }).split("\n");
    const expected = sendScript("a'b@c.d", text).flatMap((line) => ["-e", line]);
    assert.deepEqual(printed.slice(0, expected.length), expected);
  });

  it("quotes single quotes for the shell", () => {
    assert.equal(shellQuote("a'b"), `'a'\\''b'`);
    assert.equal(execFileSync("sh", ["-c", `printf %s ${shellQuote("a'b $x")}`], { encoding: "utf8" }), "a'b $x");
  });
});

describe("mac_read_messages query", () => {
  it("is one fixed read-only statement against chat.db", () => {
    const command = messagesCommand(10);
    assert.match(command, /^sqlite3 -readonly -json "\$HOME\/Library\/Messages\/chat\.db" '/);
    assert.match(messagesQuery(10), /^SELECT datetime\(message\.date \/ 1000000000 \+ 978307200, 'unixepoch'\) AS date, handle\.id AS sender, message\.is_from_me AS is_from_me, message\.text AS text FROM message LEFT JOIN handle ON message\.handle_id = handle\.ROWID ORDER BY message\.date DESC LIMIT 10;$/);
  });

  it("clamps the limit to 1-50 with a default of 10, whatever the caller sends", () => {
    assert.equal(clampLimit(undefined), 10);
    assert.equal(clampLimit(0), 1);
    assert.equal(clampLimit(-5), 1);
    assert.equal(clampLimit(99), 50);
    assert.equal(clampLimit(7.9), 7);
    assert.equal(clampLimit(Number.NaN), 10);
    assert.match(messagesQuery(1e9), /LIMIT 50;$/);
    assert.match(messagesQuery(undefined), /LIMIT 10;$/);
  });

  it("has no way to carry caller text into the command", () => {
    const strip = (limit: number | undefined) => messagesCommand(limit).replace(/LIMIT \d+/, "LIMIT n");
    assert.equal(strip(5), strip(undefined));
    assert.equal(strip(5), strip(Number.NaN));
  });
});

describe("ask-first through the real hook", () => {
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

  it("does not send an iMessage until Nish says YES, but runs a plain computer call at once", opts, async () => {
    const fake = new FakeSpaces();
    const { computer } = build(fake);
    model.enqueue(call("computer_run", { command: "date" }), call("mac_send_message", { to: "bob@example.test", text: "hi" }), say("All done."));
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
    channel.push(inbound("m1", "check the date then message bob"));
    await channel.sentCount(1);
    assert.equal(channel.sent[0]?.text, askText('Run mac_send_message with {"to":"bob@example.test","text":"hi"}.'));
    await pause(200);
    assert.equal(fake.spaces.get("id-1")!.commands.length, 1, "computer_run ran without asking");
    assert.equal(fake.spaces.has(CONFIG.macRef), false, "the Mac was not touched");
    channel.push(inbound("m2", "YES"));
    await channel.sentCount(2);
    assert.equal(fake.mac().commands.length, 1);
    assert.equal(fake.mac().commands[0], sendCommand("bob@example.test", "hi"));
  });
});
