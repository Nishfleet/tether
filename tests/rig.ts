import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { startTether, type Tether, type TetherOptions } from "../src/app.ts";
import { createModelAccess } from "../src/model.ts";
import { ALLOWED, FakeChannel, FakeModel, KEY } from "./helpers.ts";

export class Rig {
  readonly dir = mkdtempSync(join(tmpdir(), "tether-rig-"));
  readonly model = new FakeModel();
  channel = new FakeChannel();
  readonly logs: { event: string; fields: Record<string, unknown> }[] = [];
  tether: Tether | undefined;
  private readonly waiters: { event: string; resolve: () => void }[] = [];

  async open(): Promise<void> {
    await this.model.start();
  }

  async boot(extra: Partial<Pick<TetherOptions, "fetch" | "timeZone" | "calendar" | "now" | "setTimer" | "searchApiKey">> = {}): Promise<Tether> {
    const { models, ref } = createModelAccess({ baseUrl: this.model.url, apiKey: KEY });
    this.tether = await startTether({
      channel: this.channel,
      models,
      model: ref,
      storage: await openNodeSqliteStorage(join(this.dir, "t.sqlite")),
      allowedSender: ALLOWED,
      log: (event, fields) => {
        this.logs.push({ event, fields: { ...fields } });
        for (const waiter of this.waiters.splice(0)) {
          if (event === waiter.event) waiter.resolve();
          else this.waiters.push(waiter);
        }
      },
      retryBaseMs: 5,
      settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 5 }, stream: { maxRetries: 0 } },
      ...extra,
    });
    return this.tether;
  }

  logged(event: string): Promise<void> {
    if (this.logs.some((entry) => entry.event === event)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ event, resolve }));
  }

  texts(): string[] {
    return this.channel.sent.map((sent) => sent.text);
  }

  async close(): Promise<void> {
    await this.tether?.stop();
    this.tether = undefined;
    await this.model.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
