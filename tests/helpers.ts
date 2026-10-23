import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Channel, Inbound } from "../src/channel.ts";

export const KEY = "test-router-key";
export const ALLOWED = "owner@example.test";
export const SPACE = "space-1";

export type ChatRequest = {
  model: string;
  stream?: boolean;
  max_tokens?: number;
  messages: { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
};

export type Via = { model: string; headers: Record<string, string> };

export const PRIMARY_VIA: Via = { model: "claude-sonnet-5-5", headers: { "x-litellm-model-id": "deployment-claude" } };
export const BACKUP_VIA: Via = {
  model: "deepseek-v4.1-flash",
  headers: { "x-litellm-model-id": "deployment-backup", "x-litellm-attempted-fallbacks": "1" },
};

export type Reply = (
  | { kind: "text"; text: string }
  | { kind: "cut"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "toolText"; text: string; name: string; args: Record<string, unknown> }
  | { kind: "tools"; calls: { name: string; args: Record<string, unknown> }[] }
  | { kind: "hold" }
  | { kind: "fail" }
) & { via?: Via };

export const via = <T extends Reply>(reply: T, served: Via): T => ({ ...reply, via: served });

export const say = (text: string): Reply => ({ kind: "text", text });
export const cut = (text: string): Reply => ({ kind: "cut", text });
export const call = (name: string, args: Record<string, unknown>): Reply => ({ kind: "tool", name, args });
export const fail = (): Reply => ({ kind: "fail" });
export const hold = (): Reply => ({ kind: "hold" });

export function flatten(request: ChatRequest): string {
  return JSON.stringify(request.messages);
}

export class FakeModel {
  readonly requests: ChatRequest[] = [];
  fallback: ((request: ChatRequest) => Reply) | undefined;
  readonly closed: number[] = [];
  readonly badAuth: string[] = [];
  private readonly script: Reply[] = [];
  private readonly closeWaiters: { count: number; resolve: () => void }[] = [];
  private readonly waiters: { count: number; resolve: () => void }[] = [];
  private server: Server | undefined;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  enqueue(...replies: Reply[]): void {
    this.script.push(...replies);
  }

  async requestCount(count: number): Promise<void> {
    if (this.requests.length >= count) return;
    await new Promise<void>((resolve) => this.waiters.push({ count, resolve }));
  }

  async closedCount(count: number): Promise<void> {
    if (this.closed.length >= count) return;
    await new Promise<void>((resolve) => this.closeWaiters.push({ count, resolve }));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (req.headers.authorization !== `Bearer ${KEY}`) this.badAuth.push(String(req.headers.authorization));
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    const index = this.requests.length;
    this.requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest);
    res.on("close", () => {
      this.closed.push(index);
      for (const waiter of this.closeWaiters.splice(0)) {
        if (this.closed.length >= waiter.count) waiter.resolve();
        else this.closeWaiters.push(waiter);
      }
    });
    for (const waiter of this.waiters.splice(0)) {
      if (this.requests.length >= waiter.count) waiter.resolve();
      else this.waiters.push(waiter);
    }
    const request = this.requests[index] as ChatRequest;
    const reply = this.script.shift() ?? this.fallback?.(request) ?? say("(no scripted reply)");
    if (reply.kind === "fail") {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "upstream down" } }));
      return;
    }
    if (reply.kind === "hold") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(chunkOf(PRIMARY_VIA.model, { role: "assistant", content: "" }, null))}\n\n`);
      return;
    }
    const served = reply.via ?? PRIMARY_VIA;
    const chunk = (delta: Record<string, unknown>, finish: string | null) => chunkOf(served.model, delta, finish);
    res.writeHead(200, { "content-type": "text/event-stream", ...served.headers });
    if (reply.kind === "toolText") {
      const delta = {
        role: "assistant",
        content: reply.text,
        tool_calls: [{ index: 0, id: `call_${index}`, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) } }],
      };
      res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, "tool_calls"))}\n\n`);
    } else if (reply.kind === "tools") {
      const delta = {
        role: "assistant",
        tool_calls: reply.calls.map((entry, position) => ({
          index: position,
          id: `call_${index}_${position}`,
          type: "function",
          function: { name: entry.name, arguments: JSON.stringify(entry.args) },
        })),
      };
      res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, "tool_calls"))}\n\n`);
    } else if (reply.kind === "text" || reply.kind === "cut") {
      res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: reply.text }, null))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, reply.kind === "cut" ? "length" : "stop"))}\n\n`);
    } else {
      const delta = {
        role: "assistant",
        tool_calls: [{ index: 0, id: `call_${index}`, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) } }],
      };
      res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, "tool_calls"))}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

function chunkOf(model: string, delta: Record<string, unknown>, finish: string | null) {
  return { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] };
}

export function inbound(id: string, text: string | undefined, overrides: Partial<Inbound> = {}): Inbound {
  return { id, sender: ALLOWED, space: SPACE, direct: true, text, ...overrides };
}

export class FakeChannel implements Channel {
  readonly sent: { space: string; text: string }[] = [];
  failures = 0;
  private readonly pending: Inbound[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  private readonly sentWaiters: { count: number; resolve: () => void }[] = [];

  push(message: Inbound): void {
    this.pending.push(message);
    this.wake?.();
  }

  async *messages(): AsyncGenerator<Inbound> {
    while (true) {
      const next = this.pending.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  async send(space: string, text: string): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("send refused");
    }
    this.sent.push({ space, text });
    for (const waiter of this.sentWaiters.splice(0)) {
      if (this.sent.length >= waiter.count) waiter.resolve();
      else this.sentWaiters.push(waiter);
    }
  }

  async sentCount(count: number): Promise<void> {
    if (this.sent.length >= count) return;
    await new Promise<void>((resolve) => this.sentWaiters.push({ count, resolve }));
  }

  async stop(): Promise<void> {
    this.ended = true;
    this.wake?.();
  }
}
