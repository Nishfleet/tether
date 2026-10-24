import { defineExtension, type Extension, type Task } from "@earendil-works/pi-durable";
import { briefTools, type BriefTask } from "./brief.ts";
import type { Channel } from "./channel.ts";
import { clockTool } from "./clock.ts";
import { locationTools } from "./location.ts";
import type { Log } from "./log.ts";
import { type Fetch, placesTool } from "./places.ts";
import { createReminderTask, reminderTools } from "./reminders.ts";
import type { ReplyInput, ReplyState } from "./reply.ts";
import { textOwnerTool } from "./texts.ts";

export type AssistOptions = {
  readonly channel: Channel;
  readonly reply: Task<ReplyInput, ReplyState, null, object>;
  readonly timeZone: string;
  readonly fetch: Fetch;
  readonly userAgent: string;
  readonly log: Log;
  readonly brief: BriefTask;
};

export function createAssistExtension(options: AssistOptions): Extension {
  const reminder = createReminderTask({ reply: options.reply });
  return defineExtension({
    name: "tether-assist",
    tools: [
      clockTool(options.timeZone),
      ...reminderTools({ task: reminder, timeZone: options.timeZone }),
      ...briefTools({ task: options.brief, timeZone: options.timeZone }),
      ...locationTools({ reply: options.reply, locations: options.channel.locations }),
      textOwnerTool({ channel: options.channel, log: options.log }),
      placesTool({ fetch: options.fetch, userAgent: options.userAgent, log: options.log, locations: options.channel.locations }),
    ],
    tasks: [reminder, options.brief],
  });
}
