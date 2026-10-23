import { withAbortSignal } from "@earendil-works/chord/context";
import { defineTask, type EntryId, type Task, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Channel } from "./channel.ts";
import { StateDoc, TierDoc } from "./docs.ts";
import type { Log } from "./log.ts";
import { classifyTier, DEPLOYMENT_HEADER, FALLBACKS_HEADER, ROUTER_DIAGNOSTIC, switchNotice, type Served, type Tier } from "./tier.ts";

export type ReplyInput = {
  space: string;
  inbound: string | null;
  prompt: string | null;
  notice: string | null;
  run: number;
};

export type ReplyState =
  | { phase: "ask" }
  | { phase: "send"; text: string; attempt: number; parts?: string[]; next?: number };

export const FAILURE_TEXT = "Sorry, I could not get an answer just now. Please try again.";
export const SEND_ATTEMPTS = 8;
export const MAX_PART_CHARS = 3500;
export const TRUNCATED_MARKER = "(truncated: this reply hit my length limit)";

export function splitReply(text: string, limit: number = MAX_PART_CHARS): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    let cut = -1;
    for (const boundary of ["\n\n", "\n", ". ", " "]) {
      const at = window.lastIndexOf(boundary);
      if (at >= limit / 2) {
        cut = at + (boundary === ". " ? 1 : 0);
        break;
      }
    }
    if (cut < 0) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== "" || parts.length === 0) parts.push(rest);
  return parts;
}

type Runtime = TaskRuntime<ReplyInput, ReplyState, null, object>;

async function haltedByStop(input: ReplyInput, runtime: Runtime, context: Context): Promise<boolean> {
  if (input.inbound === null) return false;
  const state = await runtime.snapshot(StateDoc, context);
  if (!state?.stopped) return false;
  await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "stopped" } }), context);
  return true;
}

const release = async (tx: Tx, inbound: string | null) => {
  if (inbound === null) return;
  const state = await tx.doc(StateDoc);
  const index = state.inflight.findIndex((item) => item.inbound === inbound);
  if (index >= 0) state.inflight.splice(index, 1);
};

type Answer = { text: string; tier: Tier; served: Served };

function servedBy(last: AssistantMessage): Served {
  const details = last.diagnostics?.find((entry) => entry.type === ROUTER_DIAGNOSTIC)?.details;
  const header = (name: string) => (typeof details?.[name] === "string" ? details[name] : undefined);
  return { model: last.responseModel, deployment: header(DEPLOYMENT_HEADER), fallbacks: header(FALLBACKS_HEADER) };
}

async function readAnswer(runtime: Runtime, entry: EntryId, context: Context): Promise<Answer | undefined> {
  const record = await runtime.entry(entry, context);
  const last = (record?.model ?? []).findLast((message) => message.role === "assistant");
  if (last?.role !== "assistant") return undefined;
  const joined = last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
  if (joined === "") return undefined;
  const served = servedBy(last);
  return { text: last.stopReason === "length" ? `${joined}\n\n${TRUNCATED_MARKER}` : joined, tier: classifyTier(served.model), served };
}

export function createReplyTask(options: { channel: Channel; log: Log; retryBaseMs: number }): Task<ReplyInput, ReplyState, null, object> {
  const { channel, log, retryBaseMs } = options;
  const self: Task<ReplyInput, ReplyState, null, object> = defineTask<ReplyInput, ReplyState, null>({
    name: "tether.reply",
    version: 1,
    initial: (input) => (input.prompt === null ? { phase: "send", text: input.notice ?? "", attempt: 0 } : { phase: "ask" }),
    phases: {
      ask: async (task, runtime, context) => {
        if (await haltedByStop(task.input, runtime, context)) return;
        const aborting = withAbortSignal(runtime.signal, context);
        const conversation = await runtime.conversation(runtime.conversationId, aborting);
        if (!conversation || task.input.prompt === null) throw new Error("reply task has no conversation or prompt");
        const submission = await conversation.submit(
          { type: "input", content: task.input.prompt, requestId: `${task.input.inbound}:${task.input.run}` },
          aborting,
        );
        const settled = await submission.wait(aborting);
        const answer = settled.status === "done" ? settled.answer : undefined;
        const read = answer === undefined ? undefined : await readAnswer(runtime, answer, aborting);
        if (settled.status !== "done") log("model_unanswered", { reason: settled.reason });
        if (read) log("model_served", { tier: read.tier, model: read.served.model ?? "", deployment: read.served.deployment ?? "", fallbacks: read.served.fallbacks ?? "" });
        const { space } = task.input;
        await runtime.commit(async (tx) => {
          if (read) {
            const tiers = await tx.doc(TierDoc);
            const text = switchNotice(tiers.tier, read.tier);
            tiers.tier = read.tier;
            if (text !== null) {
              const input: ReplyInput = { space, inbound: null, prompt: null, notice: text, run: 0 };
              await tx.createTask(self, input, { ownership: { kind: "conversation" }, conversationId: runtime.conversationId });
            }
          }
          return { status: "running", checkpoint: { phase: "send", text: read?.text ?? FAILURE_TEXT, attempt: 0 } };
        }, context);
      },
      send: async (task, runtime, context) => {
        const { text, attempt } = task.state.checkpoint;
        const parts = task.state.checkpoint.parts ?? splitReply(text);
        const index = task.state.checkpoint.next ?? 0;
        if (await haltedByStop(task.input, runtime, context)) return;
        const aborting = withAbortSignal(runtime.signal, context);
        try {
          await channel.send(task.input.space, parts[index] ?? text);
        } catch (error) {
          log("send_failed", { attempt, error: error instanceof Error ? error.name : "unknown" });
          if (attempt + 1 >= SEND_ATTEMPTS) {
            await runtime.commit(async (tx) => {
              await release(tx, task.input.inbound);
              return { status: "terminal", outcome: { status: "failed", error: { message: "send attempts exhausted" } } };
            }, aborting);
            log("send_gave_up", { inbound: task.input.inbound ?? "notice" });
            return;
          }
          const until = runtime.now() + retryBaseMs * 2 ** attempt;
          await runtime.sleepUntil(until, { phase: "send", text, attempt: attempt + 1, parts, next: index }, aborting);
          return;
        }
        if (index + 1 < parts.length) {
          await runtime.commit(() => ({ status: "running", checkpoint: { phase: "send", text, attempt: 0, parts, next: index + 1 } }), aborting);
          return;
        }
        await runtime.commit(async (tx) => {
          await release(tx, task.input.inbound);
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, aborting);
        log("reply_sent", { inbound: task.input.inbound ?? "notice", attempt });
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
  return self;
}
