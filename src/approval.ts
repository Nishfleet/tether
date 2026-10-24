import type { Context, JsonValue } from "@earendil-works/chord";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  hook,
  ToolTask,
  type Conversation,
  type Extension,
  type ToolHookCall,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { StateDoc } from "./docs.ts";
import type { Log } from "./log.ts";
import { OwnerDoc } from "./owner.ts";

export type AskFirst<Args = Record<string, unknown>> = true | ((args: Args) => string | undefined);

export type GuardedTool<P extends TSchema = TSchema, D extends JsonValue = JsonValue> = ToolRegistration<P, D> & {
  readonly askFirst?: AskFirst<Static<P>>;
};

export type AnyGuardedTool = ToolRegistration & {
  readonly askFirst?: true | ((args: never) => string | undefined);
};

export function defineAskFirstTool<P extends TSchema, D extends JsonValue = JsonValue>(tool: GuardedTool<P, D>): GuardedTool<P, D> {
  return tool;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export type Approval = {
  key: string;
  summary: string;
  space: string;
  expiresAt: number;
  asked: boolean;
  status: ApprovalStatus;
};

export type ApprovalState = {
  items: Approval[];
};

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
export const SUMMARY_CHARS = 200;
export const MAX_TIMER_MS = 2 ** 31 - 1;
export const BLOCKS: Record<Exclude<ApprovalStatus, "pending" | "approved">, string> = {
  denied: "Blocked: Nish answered NO, so this was not run.",
  expired: "Blocked: Nish did not answer within 24 hours, so this was not run.",
  cancelled: "Blocked: this approval was cancelled, so this was not run.",
};
export const NO_CHAT_BLOCK = "Blocked: there is no chat to ask Nish in, so this was not run.";

export const ApprovalDoc = defineDoc<ApprovalState>({
  kind: "tether.approval",
  version: 1,
  scope: "session",
  initial: () => ({ items: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

export const askText = (summary: string) => `Allow this? ${summary} Reply YES to allow or NO to cancel. No answer within 24 hours cancels it.`;

export type Notify = (tx: Tx, space: string, text: string) => Promise<void>;

const oneLine = (value: string) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS - 1)}…` : flat;
};

export function describeCall(call: Pick<ToolHookCall, "name" | "arguments">): string {
  return oneLine(`Run ${call.name} with ${JSON.stringify(call.arguments)}.`);
}

async function promote(tx: Tx, notify: Notify): Promise<void> {
  const doc = await tx.doc(ApprovalDoc);
  const head = doc.items.find((item) => item.status === "pending");
  if (head && !head.asked) {
    head.asked = true;
    await notify(tx, head.space, askText(head.summary));
  }
}

export async function hasAsked(tx: Tx): Promise<boolean> {
  const doc = await tx.doc(ApprovalDoc);
  return doc.items.some((item) => item.status === "pending" && item.asked);
}

export async function answer(tx: Tx, approve: boolean, notify: Notify, at: number): Promise<"approved" | "denied" | "expired" | "none"> {
  const doc = await tx.doc(ApprovalDoc);
  const head = doc.items.find((item) => item.status === "pending" && item.asked);
  if (!head) return "none";
  head.status = head.expiresAt <= at ? "expired" : approve ? "approved" : "denied";
  await promote(tx, notify);
  return head.status;
}

export async function cancelAll(tx: Tx): Promise<number> {
  const doc = await tx.doc(ApprovalDoc);
  let cancelled = 0;
  for (const item of doc.items) {
    if (item.status !== "pending") continue;
    item.status = "cancelled";
    cancelled += 1;
  }
  return cancelled;
}

export class Wakeups {
  private version = 0;
  private readonly waiting = new Set<() => void>();

  wake(): void {
    this.version += 1;
    for (const resolve of [...this.waiting]) resolve();
  }

  current(): number {
    return this.version;
  }

  wait(seen: number, ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (this.version !== seen || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        this.waiting.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(ms, MAX_TIMER_MS));
      timer.unref();
      this.waiting.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

export type ApprovalOptions = {
  readonly root: () => Conversation;
  readonly context: Context;
  readonly lookup: (name: string) => AnyGuardedTool | undefined;
  readonly notify: Notify;
  readonly wakeups: Wakeups;
  readonly log: Log;
  readonly ttlMs?: number;
  readonly now?: () => number;
};

export function createApprovalExtension(options: ApprovalOptions): Extension {
  const { root: getRoot, context: base, lookup, notify, wakeups, log } = options;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;

  const expire = (key: string) =>
    getRoot().commit(async (tx) => {
      const doc = await tx.doc(ApprovalDoc);
      const item = doc.items.find((entry) => entry.key === key);
      if (item?.status === "pending") {
        item.status = "expired";
        await promote(tx, notify);
      }
    }, base);

  return defineExtension({
    name: "tether-ask-first",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          const tool = lookup(call.name);
          if (!tool) return undefined;
          const rule = tool.askFirst;
          if (rule === undefined) return undefined;
          const summary = rule === true ? describeCall(call) : (rule as (args: typeof call.arguments) => string | undefined)(call.arguments);
          if (!summary) return undefined;
          const key = `${api.taskId}:${call.id}`;
          const { expiresAt } = await api.memo<{ expiresAt: number }>("ask-first", { expiresAt: now() + ttlMs }, context);
          const filed = await getRoot().commit(async (tx) => {
            const doc = await tx.doc(ApprovalDoc);
            const found = doc.items.find((item) => item.key === key);
            if (found) return found.status;
            if ((await tx.doc(StateDoc)).stopped) return "stopped";
            const { space } = await tx.doc(OwnerDoc);
            if (space === null) return "no_chat";
            doc.items.splice(0, doc.items.length, ...doc.items.filter((item) => item.status === "pending" || item.expiresAt > now()));
            doc.items.push({ key, summary: oneLine(summary), space, expiresAt, asked: false, status: "pending" });
            await promote(tx, notify);
            return "pending";
          }, base);
          if (filed === "no_chat") return { block: NO_CHAT_BLOCK };
          if (filed === "stopped") return { block: BLOCKS.cancelled };
          log("approval_filed", { tool: call.name, status: filed });
          for (;;) {
            const seen = wakeups.current();
            const doc = await api.snapshot(ApprovalDoc, context);
            const status = doc?.items.find((item) => item.key === key)?.status ?? "cancelled";
            if (status === "approved") return undefined;
            if (status !== "pending") return { block: BLOCKS[status] };
            const remaining = expiresAt - now();
            if (remaining <= 0) {
              await expire(key);
              continue;
            }
            await wakeups.wait(seen, remaining, context.abortSignal);
            if (context.abortSignal?.aborted) throw context.abortSignal.reason ?? new Error("aborted");
          }
        },
      }),
    ],
  });
}
