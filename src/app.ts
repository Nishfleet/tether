import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  Harness,
  type Conversation,
  type HarnessSettings,
  type ModelRef,
  type Storage,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Channel, Inbound } from "./channel.ts";
import { answer, cancelAll, createApprovalExtension, hasAsked, rememberSpace, Wakeups, type AnyGuardedTool } from "./approval.ts";
import { classify } from "./control.ts";
import { type Pending, SEEN_LIMIT, StateDoc } from "./docs.ts";
import type { Log } from "./log.ts";
import { createMemoryExtension } from "./memory.ts";
import { createReplyTask, type ReplyInput } from "./reply.ts";

export const INSTRUCTIONS = [
  "You are Tether, a personal assistant that chats with one person over iMessage.",
  "Reply in short plain text without markdown.",
  "Each answer you write is sent as one reply and you cannot send a second message of your own, so never promise parts, follow-ups or a continuation later; finish the whole answer now.",
  "You can save and forget short notes with your memory tools; your saved notes are listed under memory.",
  "Save a note only when the person asks you to remember something.",
  "You have no web access, no shell and no other tools. Say so if asked to do something outside chat and memory.",
].join(" ");

export const STOPPED_TEXT = "Stopped. Nothing will run until you text RESUME.";
export const RESUMED_TEXT = "Resumed.";
export const ALREADY_STOPPED_TEXT = "Already stopped. Text RESUME to continue.";
export const NOT_STOPPED_TEXT = "Not stopped.";

export type TetherOptions = {
  readonly channel: Channel;
  readonly models: Models;
  readonly model: ModelRef;
  readonly storage: Storage;
  readonly allowedSender: string;
  readonly salt: string;
  readonly log: Log;
  readonly retryBaseMs?: number;
  readonly settings?: HarnessSettings;
  readonly tools?: readonly AnyGuardedTool[];
  readonly approvalTtlMs?: number;
};

export type Tether = {
  readonly done: Promise<void>;
  stop(): Promise<void>;
};

const fingerprint = (salt: string, value: string) => createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 8);

function reply(item: Pending): ReplyInput {
  return { space: item.space, inbound: item.inbound, prompt: item.prompt, notice: null, run: item.run };
}

function notice(space: string, text: string): ReplyInput {
  return { space, inbound: null, prompt: null, notice: text, run: 0 };
}

export async function startTether(options: TetherOptions): Promise<Tether> {
  const { channel, log, allowedSender, salt } = options;
  const context = BACKGROUND_CONTEXT;
  const task = createReplyTask({ channel, log, retryBaseMs: options.retryBaseMs ?? 5000, group: options.model.modelId });
  const registry = createRegistry();
  registry.install(createMemoryExtension([task]));
  if (options.tools?.length) registry.install(defineExtension({ name: "tether-tools", tools: options.tools }));
  const wakeups = new Wakeups();
  let current: Conversation | undefined;
  const root = (): Conversation => {
    if (!current) throw new Error("root conversation is not open yet");
    return current;
  };
  const notify = (tx: Tx, space: string, text: string) => queue(tx, notice(space, text));
  const lookup = (name: string) => registry.snapshot().tools().find((entry) => entry.tool.name === name)?.tool as AnyGuardedTool | undefined;
  registry.install(createApprovalExtension({ root, context, lookup, notify, wakeups, log, ...(options.approvalTtlMs === undefined ? {} : { ttlMs: options.approvalTtlMs }) }));
  const harness = await Harness.open(
    options.storage,
    {
      models: options.models,
      registry,
      identity: { attribution: null },
      settings: { afterFailedRun: "continue", ...options.settings },
      onReport: (error, info) => log("harness_report", { type: info.type, error: error instanceof Error ? error.name : "unknown" }),
    },
    context,
  );
  current = await harness.root(context, { agent: { model: options.model, instructions: INSTRUCTIONS } });
  const chat = current;
  await chat.configure({ model: options.model, instructions: INSTRUCTIONS }, context);

  const claim = (state: { seen: string[] }, id: string): boolean => {
    if (state.seen.includes(id)) return false;
    state.seen.push(id);
    if (state.seen.length > SEEN_LIMIT) state.seen.splice(0, state.seen.length - SEEN_LIMIT);
    return true;
  };

  const queue = async (tx: Tx, input: ReplyInput) => {
    await tx.createTask(task, input, { ownership: { kind: "conversation" }, conversationId: chat.id });
  };

  const onChat = (message: Inbound, text: string) =>
    chat.commit(async (tx) => {
      const state = await tx.doc(StateDoc);
      if (!claim(state, message.id)) return "duplicate";
      if (state.stopped) return "stopped";
      const item: Pending = { inbound: message.id, space: message.space, prompt: text, run: 0 };
      state.inflight.push(item);
      await rememberSpace(tx, message.space);
      await queue(tx, reply(item));
      return "accepted";
    }, context);

  const onStop = async (message: Inbound) => {
    const outcome = await chat.commit(async (tx) => {
      const state = await tx.doc(StateDoc);
      if (!claim(state, message.id)) return "duplicate";
      if (state.stopped) {
        await queue(tx, notice(message.space, ALREADY_STOPPED_TEXT));
        return "already_stopped";
      }
      state.stopped = true;
      await cancelAll(tx);
      state.held.push(...state.inflight.map((item) => ({ ...item })));
      state.inflight.splice(0, state.inflight.length);
      return "stopped";
    }, context);
    if (outcome !== "stopped") return outcome;
    await chat.abort(context);
    await chat.commit((tx) => queue(tx, notice(message.space, STOPPED_TEXT)), context);
    return outcome;
  };

  const onAnswer = (message: Inbound, approve: boolean) =>
    chat.commit(async (tx) => {
      if (!(await hasAsked(tx))) return "none";
      const state = await tx.doc(StateDoc);
      if (!claim(state, message.id)) return "duplicate";
      return answer(tx, approve, notify);
    }, context);

  const onResume = (message: Inbound) =>
    chat.commit(async (tx) => {
      const state = await tx.doc(StateDoc);
      if (!claim(state, message.id)) return "duplicate";
      if (!state.stopped) {
        await queue(tx, notice(message.space, NOT_STOPPED_TEXT));
        return "not_stopped";
      }
      state.stopped = false;
      const held = state.held.map((item) => ({ ...item, run: item.run + 1 }));
      state.held.splice(0, state.held.length);
      for (const item of held) {
        state.inflight.push(item);
        await queue(tx, reply(item));
      }
      await queue(tx, notice(message.space, RESUMED_TEXT));
      return "resumed";
    }, context);

  const handle = async (message: Inbound): Promise<void> => {
    const verdict = classify(message, allowedSender);
    if (verdict.kind === "ignore") {
      log("ignored", { id: message.id, reason: verdict.reason, from: fingerprint(salt, message.sender) });
      return;
    }
    let outcome: string;
    if (verdict.kind === "stop") outcome = await onStop(message);
    else if (verdict.kind === "resume") outcome = await onResume(message);
    else if (verdict.kind === "yes" || verdict.kind === "no") {
      outcome = await onAnswer(message, verdict.kind === "yes");
      if (outcome === "none") outcome = await onChat(message, verdict.text);
    } else outcome = await onChat(message, verdict.text);
    wakeups.wake();
    log("handled", { id: message.id, kind: verdict.kind, outcome });
  };

  if ((await harness.snapshot(StateDoc, context))?.stopped) await chat.abort(context);
  harness.resume();
  log("started");

  let stopping = false;
  const consume = async (): Promise<void> => {
    for await (const message of channel.messages()) await handle(message);
    if (!stopping) throw new Error("channel ended");
  };
  const failed = harness.closed.then((end) => {
    if (end.reason === "failed") throw new Error("storage failed");
  });
  const done = Promise.race([consume(), failed]);

  return {
    done,
    stop: async () => {
      stopping = true;
      await channel.stop();
      await harness.close(context);
      log("stopped");
    },
  };
}
