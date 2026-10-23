import type { CalendarConfig } from "./config.ts";
import { googleBackends, type GoogleEndpoints } from "./google.ts";
import { icloudBackends, type IcloudEndpoints } from "./icloud.ts";
import type { CalendarOptions } from "./tools.ts";
import type { Backends } from "./types.ts";

export type Endpoints = { readonly google?: GoogleEndpoints; readonly icloud?: IcloudEndpoints };

export function openCalendar(config: CalendarConfig, endpoints: Endpoints = {}): CalendarOptions | undefined {
  const parts: Backends[] = [
    ...(config.google ? [googleBackends(config.google, config.timezone, endpoints.google)] : []),
    ...(config.icloud ? [icloudBackends(config.icloud, config.timezone, endpoints.icloud)] : []),
  ];
  if (parts.length === 0) return undefined;
  return { timezone: config.timezone, backends: { calendar: parts.flatMap((part) => part.calendar), contacts: parts.flatMap((part) => part.contacts) } };
}
