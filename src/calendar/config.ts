import type { Env } from "../config.ts";

export type GoogleConfig = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
};

export type IcloudConfig = {
  readonly appleId: string;
  readonly appPassword: string;
};

export type CalendarConfig = {
  readonly timezone: string;
  readonly google: GoogleConfig | undefined;
  readonly icloud: IcloudConfig | undefined;
};

export const DEFAULT_TIMEZONE = "Asia/Kolkata";

export const GOOGLE_NAMES = ["TETHER_GOOGLE_CLIENT_ID", "TETHER_GOOGLE_CLIENT_SECRET", "TETHER_GOOGLE_REFRESH_TOKEN"] as const;
export const ICLOUD_NAMES = ["TETHER_ICLOUD_APPLE_ID", "TETHER_ICLOUD_APP_PASSWORD"] as const;

function group<const Names extends readonly string[]>(env: Env, names: Names): Record<Names[number], string> | undefined {
  const values = names.map((name) => env[name]?.trim());
  if (values.every((value) => !value)) return undefined;
  const missing = names.filter((_, index) => !values[index]);
  if (missing.length > 0) throw new Error(`incomplete environment: ${missing.join(", ")}`);
  return Object.fromEntries(names.map((name, index) => [name, values[index] as string])) as Record<Names[number], string>;
}

export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function loadCalendarConfig(env: Env): CalendarConfig {
  const timezone = env.TETHER_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
  if (!isValidTimezone(timezone)) throw new Error("invalid environment: TETHER_TIMEZONE");
  const google = group(env, GOOGLE_NAMES);
  const icloud = group(env, ICLOUD_NAMES);
  return {
    timezone,
    google: google && {
      clientId: google.TETHER_GOOGLE_CLIENT_ID,
      clientSecret: google.TETHER_GOOGLE_CLIENT_SECRET,
      refreshToken: google.TETHER_GOOGLE_REFRESH_TOKEN,
    },
    icloud: icloud && { appleId: icloud.TETHER_ICLOUD_APPLE_ID, appPassword: icloud.TETHER_ICLOUD_APP_PASSWORD },
  };
}
