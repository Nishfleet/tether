const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const DAY_MS = 86_400_000;

function offsetMs(instant: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

function wallClock(zone: string, year: number, month: number, day: number, hour: number, minute: number, second: number): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = guess - offsetMs(guess, zone);
  return new Date(guess - offsetMs(first, zone));
}

export type Parsed = { readonly date: Date; readonly dateOnly: boolean };

function real(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day && hour < 24 && minute < 60 && second < 60;
}

export function parseWhen(text: string, zone: string): Parsed | undefined {
  const value = text.trim();
  const day = DATE_ONLY.exec(value);
  if (day && real(Number(day[1]), Number(day[2]), Number(day[3]), 0, 0, 0)) {
    const date = wallClock(zone, Number(day[1]), Number(day[2]), Number(day[3]), 0, 0, 0);
    return Number.isNaN(date.getTime()) ? undefined : { date, dateOnly: true };
  }
  const local = LOCAL.exec(value);
  if (local && real(Number(local[1]), Number(local[2]), Number(local[3]), Number(local[4]), Number(local[5]), Number(local[6] ?? 0))) {
    const date = wallClock(zone, Number(local[1]), Number(local[2]), Number(local[3]), Number(local[4]), Number(local[5]), Number(local[6] ?? 0));
    return Number.isNaN(date.getTime()) ? undefined : { date, dateOnly: false };
  }
  if (day || local || !/(Z|[+-]\d{2}:?\d{2})$/i.test(value) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : { date, dateOnly: false };
}

export const addDays = (date: Date, zone: string, days: number): Date => {
  const parts = dayParts(date, zone);
  return wallClock(zone, parts.year, parts.month, parts.day + days, 0, 0, 0);
};

export function dayParts(date: Date, zone: string): { year: number; month: number; day: number } {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(date)
    .split("-")
    .map(Number);
  return { year: year as number, month: month as number, day: day as number };
}

export const isoDay = (date: Date, zone: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

const dayLabel = (date: Date, zone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(date);
const clock = (date: Date, zone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);

export function describeWhen(start: Date, end: Date, allDay: boolean, zone: string): string {
  if (allDay) {
    const last = new Date(end.getTime() - 1);
    return isoDay(last, zone) > isoDay(start, zone) ? `${dayLabel(start, zone)} to ${dayLabel(last, zone)}, all day` : `${dayLabel(start, zone)}, all day`;
  }
  const sameDay = isoDay(start, zone) === isoDay(end, zone);
  return sameDay
    ? `${dayLabel(start, zone)} ${clock(start, zone)}-${clock(end, zone)}`
    : `${dayLabel(start, zone)} ${clock(start, zone)} to ${dayLabel(end, zone)} ${clock(end, zone)}`;
}

export const MAX_SPAN_DAYS = 62;
export const spanDays = (from: Date, to: Date) => (to.getTime() - from.getTime()) / DAY_MS;
