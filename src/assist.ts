import { defineExtension, type Extension, type Task } from "@earendil-works/pi-durable";
import { clockTool } from "./clock.ts";
import { locationTools } from "./location.ts";
import type { Log } from "./log.ts";
import { type Fetch, placesTool } from "./places.ts";
import { createReminderTask, reminderTools } from "./reminders.ts";
import type { ReplyInput, ReplyState } from "./reply.ts";

export type AssistOptions = {
  readonly reply: Task<ReplyInput, ReplyState, null, object>;
  readonly timeZone: string;
  readonly fetch: Fetch;
  readonly userAgent: string;
  readonly stoppedRecheckMs: number;
  readonly log: Log;
};

export function createAssistExtension(options: AssistOptions): Extension {
  const reminder = createReminderTask({ reply: options.reply, stoppedRecheckMs: options.stoppedRecheckMs });
  return defineExtension({
    name: "tether-assist",
    tools: [
      clockTool(options.timeZone),
      ...reminderTools({ task: reminder, timeZone: options.timeZone }),
      ...locationTools({ reply: options.reply }),
      placesTool({ fetch: options.fetch, userAgent: options.userAgent, log: options.log }),
    ],
    tasks: [reminder],
  });
}
