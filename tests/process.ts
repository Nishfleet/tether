import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Inbound } from "../src/channel.ts";
import { KEY, ALLOWED } from "./helpers.ts";

export type Line = { ready?: true; sent?: { space: string; text: string }; sending?: string };

export class Tether {
  readonly sent: string[] = [];
  readonly sending: string[] = [];
  readonly stderr: string[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly child: ChildProcess;
  private readonly ready: Promise<void>;
  private readonly waiters: (() => void)[] = [];

  constructor(options: { stateDir: string; baseUrl: string; hangSend?: boolean }) {
    this.child = spawn(process.execPath, ["--no-warnings", join(import.meta.dirname, "fixtures/child.ts")], {
      env: {
        PATH: process.env.PATH,
        TETHER_ALLOWED_SENDER: ALLOWED,
        TETHER_LLM_API_KEY: KEY,
        TETHER_LLM_BASE_URL: options.baseUrl,
        TETHER_STATE_DIR: options.stateDir,
        ...(options.hangSend ? { TEST_HANG_SEND: "1" } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let markReady!: () => void;
    this.ready = new Promise<void>((resolve) => (markReady = resolve));
    createInterface({ input: this.child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      const parsed = JSON.parse(line) as Line;
      if (parsed.ready) markReady();
      if (parsed.sent) this.sent.push(parsed.sent.text);
      if (parsed.sending !== undefined) this.sending.push(parsed.sending);
      for (const waiter of this.waiters.splice(0)) waiter();
    });
    createInterface({ input: this.child.stderr as NodeJS.ReadableStream }).on("line", (line) => {
      this.stderr.push(line);
      for (const waiter of this.waiters.splice(0)) waiter();
    });
    this.exited = new Promise((resolve) => this.child.once("exit", (code, signal) => resolve({ code, signal })));
  }

  started(): Promise<void> {
    return Promise.race([this.ready, this.exited.then((end) => Promise.reject(new Error(`exited early ${JSON.stringify(end)}\n${this.stderr.join("\n")}`)))]);
  }

  push(message: Inbound): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  async until(check: () => boolean): Promise<void> {
    while (!check()) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  logged(event: string, count = 1): Promise<void> {
    return this.until(() => this.stderr.filter((line) => line.includes(`"event":"${event}"`)).length >= count);
  }

  async kill9(): Promise<void> {
    this.child.kill("SIGKILL");
    const end = await this.exited;
    if (end.signal !== "SIGKILL") throw new Error(`not killed: ${JSON.stringify(end)}`);
  }

  async terminate(): Promise<number | null> {
    this.child.kill("SIGTERM");
    return (await this.exited).code;
  }
}
