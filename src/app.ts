import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  type Conversation,
  type HarnessSettings,
  type ModelRef,
  type Storage,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Channel, Inbound } from "./channel.ts";
import { classify } from "./control.ts";
import { type Pending, SEEN_LIMIT, StateDoc } from "./docs.ts";
import type { Log } from "./log.ts";
import { createMemoryExtension } from "./memory.ts";
import { createReplyTask, type ReplyInput } from "./reply.ts";

export const INSTRUCTIONS = [
  "You are Tether, a personal assistant that chats with one person over iMessage.",
  "Reply in short plain text without markdown.",
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
  const task = createReplyTask({ channel, log, retryBaseMs: options.retryBaseMs ?? 5000 });
  const registry = createRegistry();
  registry.install(createMemoryExtension([task]));
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
  const root: Conversation = await harness.root(context, { agent: { model: options.model, instructions: INSTRUCTIONS } });
  await root.configure({ model: options.model, instructions: INSTRUCTIONS }, context);

  const claim = (state: { seen: string[] }, id: string): boolean => {
    if (state.seen.includes(id)) return false;
    state.seen.push(id);
    if (state.seen.length > SEEN_LIMIT) state.seen.splice(0, state.seen.length - SEEN_LIMIT);
    return true;
  };

  const queue = async (tx: Tx, input: ReplyInput) => {
    await tx.createTask(task, input, { ownership: { kind: "conversation" }, conversationId: root.id });
  };

  const onChat = (message: Inbound, text: string) =>
    root.commit(async (tx) => {
      const state = await tx.doc(StateDoc);
      if (!claim(state, message.id)) return "duplicate";
      if (state.stopped) return "stopped";
      const item: Pending = { inbound: message.id, space: message.space, prompt: text, run: 0 };
      state.inflight.push(item);
      await queue(tx, reply(item));
      return "accepted";
    }, context);

  const onStop = async (message: Inbound) => {
    const outcome = await root.commit(async (tx) => {
      const state = await tx.doc(StateDoc);
      if (!claim(state, message.id)) return "duplicate";
      if (state.stopped) {
        await queue(tx, notice(message.space, ALREADY_STOPPED_TEXT));
        return "already_stopped";
      }
      state.stopped = true;
      state.held.push(...state.inflight.map((item) => ({ ...item })));
      state.inflight.splice(0, state.inflight.length);
      return "stopped";
    }, context);
    if (outcome !== "stopped") return outcome;
    await root.abort(context);
    await root.commit((tx) => queue(tx, notice(message.space, STOPPED_TEXT)), context);
    return outcome;
  };

  const onResume = (message: Inbound) =>
    root.commit(async (tx) => {
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
    const outcome =
      verdict.kind === "stop" ? await onStop(message) : verdict.kind === "resume" ? await onResume(message) : await onChat(message, verdict.text);
    log("handled", { id: message.id, kind: verdict.kind, outcome });
  };

  if ((await harness.snapshot(StateDoc, context))?.stopped) await root.abort(context);
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
