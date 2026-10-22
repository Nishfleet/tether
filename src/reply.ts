import { withAbortSignal } from "@earendil-works/chord/context";
import { defineTask, type EntryId, type Task, type TaskRuntime, type Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { Channel } from "./channel.ts";
import { StateDoc } from "./docs.ts";
import type { Log } from "./log.ts";

export type ReplyInput = {
  space: string;
  inbound: string | null;
  prompt: string | null;
  notice: string | null;
  run: number;
};

export type ReplyState =
  | { phase: "ask" }
  | { phase: "send"; text: string; attempt: number };

export const FAILURE_TEXT = "Sorry, I could not get an answer just now. Please try again.";
export const SEND_ATTEMPTS = 8;

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

async function answerText(runtime: Runtime, entry: EntryId, context: Context): Promise<string | undefined> {
  const record = await runtime.entry(entry, context);
  const last = (record?.model ?? []).findLast((message) => message.role === "assistant");
  if (last?.role !== "assistant") return undefined;
  const joined = last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
  return joined === "" ? undefined : joined;
}

export function createReplyTask(options: { channel: Channel; log: Log; retryBaseMs: number }): Task<ReplyInput, ReplyState, null, object> {
  const { channel, log, retryBaseMs } = options;
  return defineTask<ReplyInput, ReplyState, null>({
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
        const text = answer === undefined ? undefined : await answerText(runtime, answer, aborting);
        if (settled.status !== "done") log("model_unanswered", { reason: settled.reason });
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "send", text: text ?? FAILURE_TEXT, attempt: 0 } }),
          context,
        );
      },
      send: async (task, runtime, context) => {
        const { text, attempt } = task.state.checkpoint;
        if (await haltedByStop(task.input, runtime, context)) return;
        const aborting = withAbortSignal(runtime.signal, context);
        try {
          await channel.send(task.input.space, text);
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
          await runtime.sleepUntil(until, { phase: "send", text, attempt: attempt + 1 }, aborting);
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
}
