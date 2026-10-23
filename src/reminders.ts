import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineTask, defineTool, type ConversationId, type Task, type Tx } from "@earendil-works/pi-durable";
import { humanInZone } from "./clock.ts";
import { StateDoc } from "./docs.ts";
import { OwnerDoc } from "./owner.ts";
import type { ReplyInput, ReplyState } from "./reply.ts";
import { failure, text } from "./tool.ts";

export type Reminder = {
  id: string;
  text: string;
  at: number;
  call: string;
  held?: true;
  space?: string;
};

export type Reminders = {
  next: number;
  items: Reminder[];
};

export type ReminderInput = {
  id: string;
  text: string;
  at: number;
  space: string;
};

export type ReminderState = { phase: "wait" };

export const REMINDER_LIMIT = 100;
export const REMINDER_CHARS = 500;
export const MAX_MINUTES = 525600;
export const REMINDER_PREFIX = "Reminder: ";

export const RemindersDoc = defineDoc<Reminders>({
  kind: "tether.reminders",
  version: 1,
  scope: "session",
  initial: () => ({ next: 1, items: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

export type ReminderTask = Task<ReminderInput, ReminderState, null, object>;

export function createReminderTask(options: { reply: Task<ReplyInput, ReplyState, null, object> }): ReminderTask {
  const { reply } = options;
  return defineTask<ReminderInput, ReminderState, null>({
    name: "tether.reminder",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, runtime, context) => {
        const { id, text: body, at, space } = task.input;
        const live = await runtime.snapshot(RemindersDoc, context);
        if (!live?.items.some((item) => item.id === id)) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "cancelled" } }), context);
          return;
        }
        if (runtime.now() < at) {
          await runtime.sleepUntil(at, { phase: "wait" }, context);
          return;
        }
        await runtime.commit(async (tx) => {
          const reminders = await tx.doc(RemindersDoc);
          const item = reminders.items.find((entry) => entry.id === id);
          if (!item) return { status: "terminal", outcome: { status: "aborted", reason: "cancelled" } };
          if ((await tx.doc(StateDoc)).stopped) {
            item.held = true;
            item.space = space;
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }
          reminders.items.splice(reminders.items.indexOf(item), 1);
          await tx.createTask(reply, noticeOf(space, body), { ownership: { kind: "conversation" }, conversationId: runtime.conversationId });
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
}

const noticeOf = (space: string, body: string): ReplyInput => ({ space, inbound: null, prompt: null, notice: `${REMINDER_PREFIX}${body}`, run: 0 });

export async function releaseHeldReminders(tx: Tx, reply: Task<ReplyInput, ReplyState, null, object>, conversationId: ConversationId): Promise<number> {
  const reminders = await tx.doc(RemindersDoc);
  const owner = await tx.doc(OwnerDoc);
  const held = reminders.items.filter((item) => item.held);
  for (const item of held) {
    const space = item.space ?? owner.space;
    reminders.items.splice(reminders.items.indexOf(item), 1);
    if (space) await tx.createTask(reply, noticeOf(space, item.text), { ownership: { kind: "conversation" }, conversationId });
  }
  return held.length;
}

const OFFSET_END = /(Z|[+-]\d{2}:?\d{2})$/i;

export function parseInstant(value: string): number | undefined {
  const trimmed = value.trim();
  if (!OFFSET_END.test(trimmed)) return undefined;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function reminderTools(options: { task: ReminderTask; timeZone: string }) {
  const { task, timeZone } = options;

  const set = defineTool({
    name: "reminder_set",
    description:
      "Set a reminder or alarm. Tether texts the owner your `text` at the due time, even after a restart. Give exactly one of `inMinutes` (a number from now) or `at` (ISO 8601 with a UTC offset, for example 2026-10-24T09:00:00+05:30). Call time_now first when you need today's date.",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: REMINDER_CHARS }),
      inMinutes: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_MINUTES })),
      at: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      if ((args.inMinutes === undefined) === (args.at === undefined)) return failure("Give exactly one of inMinutes or at.");
      const now = api.now();
      const due = args.inMinutes !== undefined ? now + args.inMinutes * 60000 : parseInstant(args.at ?? "");
      if (due === undefined) return failure("at must be ISO 8601 with a UTC offset, like 2026-10-24T09:00:00+05:30.");
      if (due <= now) return failure("That time has already passed.");
      const at = Math.round(due);
      const outcome = await api.commit(async (tx) => {
        const owner = await tx.doc(OwnerDoc);
        const reminders = await tx.doc(RemindersDoc);
        const prior = reminders.items.find((item) => item.call === api.callId);
        if (prior) return prior;
        if (owner.space === null) return "no_space" as const;
        if (reminders.items.length >= REMINDER_LIMIT) return "full" as const;
        const item: Reminder = { id: `r${reminders.next}`, text: args.text, at, call: api.callId };
        reminders.next += 1;
        reminders.items.push(item);
        const input: ReminderInput = { id: item.id, text: item.text, at: item.at, space: owner.space };
        await tx.createTask(task, input, { ownership: { kind: "conversation" }, conversationId: api.conversationId, background: true });
        return item;
      }, context);
      if (outcome === "no_space") return failure("No chat to text yet. The owner has to message first.");
      if (outcome === "full") return failure(`Too many reminders (${REMINDER_LIMIT}). Cancel one first.`);
      return text(`Reminder ${outcome.id} set for ${humanInZone(outcome.at, timeZone)} (${timeZone}). I will text it then.`);
    },
  });

  const list = defineTool({
    name: "reminder_list",
    description: "List the pending reminders and alarms with their ids and due times.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const reminders = await api.snapshot(RemindersDoc, context);
      const items = [...(reminders?.items ?? [])].sort((a, b) => a.at - b.at);
      if (items.length === 0) return text("No pending reminders.");
      return text(items.map((item) => `${item.id}: ${humanInZone(item.at, timeZone)} (${timeZone}) - ${item.text}`).join("\n"));
    },
  });

  const cancel = defineTool({
    name: "reminder_cancel",
    description: "Cancel one pending reminder or alarm by its id, as shown by reminder_list.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    replay: "safe",
    execute: async (args, api, context) => {
      const removed = await api.commit(async (tx) => {
        const reminders = await tx.doc(RemindersDoc);
        const index = reminders.items.findIndex((item) => item.id === args.id);
        if (index < 0) return false;
        reminders.items.splice(index, 1);
        return true;
      }, context);
      return removed ? text(`Cancelled ${args.id}.`) : failure(`No reminder ${args.id}.`);
    },
  });

  return [set, list, cancel];
}
