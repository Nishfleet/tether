import { randomUUID } from "node:crypto";
import ICAL from "ical.js";
import { DAVClient } from "tsdav";
import type { IcloudConfig } from "./config.ts";
import { dayParts, parseWhen } from "./time.ts";
import type { Backends, CalendarBackend, CalendarEvent, ContactsBackend, NewEvent, NewPerson, Person } from "./types.ts";

export type IcloudEndpoints = {
  readonly caldavUrl?: string;
  readonly carddavUrl?: string;
};

export const ICLOUD_CALDAV_URL = "https://caldav.icloud.com";
export const ICLOUD_CARDDAV_URL = "https://contacts.icloud.com";


function connect(type: "caldav" | "carddav", url: string, config: IcloudConfig): DAVClient {
  return new DAVClient({
    serverUrl: url,
    credentials: { username: config.appleId, password: config.appPassword },
    authMethod: "Basic",
    defaultAccountType: type,
  });
}

function lazy<T>(open: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= open().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

function eventsOf(data: string, zone: string): CalendarEvent[] {
  const root = new ICAL.Component(ICAL.parse(data));
  for (const vtimezone of root.getAllSubcomponents("vtimezone")) {
    ICAL.TimezoneService.register(new ICAL.Timezone(vtimezone));
  }
  return root.getAllSubcomponents("vevent").flatMap((component) => {
    const event = new ICAL.Event(component);
    if (component.getFirstPropertyValue("status") === "CANCELLED") return [];
    const start = event.startDate;
    if (!start) return [];
    const allDay = start.isDate;
    const first = start.toJSDate();
    const last = event.endDate ? event.endDate.toJSDate() : new Date(first.getTime() + (allDay ? 86_400_000 : 0));
    return [
      {
        sources: ["icloud" as const],
        title: event.summary || "(no title)",
        start: allDay ? localMidnight(start, zone) : first,
        end: allDay ? localMidnight(event.endDate ?? start, zone, event.endDate ? 0 : 1) : last,
        allDay,
        location: event.location || "",
        attendees: event.attendees.length,
      },
    ];
  });
}

function localMidnight(time: ICAL.Time, zone: string, plusDays = 0): Date {
  const day = new Date(Date.UTC(time.year, time.month - 1, time.day + plusDays)).toISOString().slice(0, 10);
  return parseWhen(day, zone)?.date ?? new Date(Number.NaN);
}

function calendarObject(event: NewEvent, zone: string, owner: string): string {
  const root = new ICAL.Component(["vcalendar", [], []]);
  root.addPropertyWithValue("version", "2.0");
  root.addPropertyWithValue("prodid", "-//Tether//Calendar//EN");
  const vevent = new ICAL.Component("vevent");
  vevent.addPropertyWithValue("uid", randomUUID());
  vevent.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  vevent.addPropertyWithValue("summary", event.title);
  const moment = (date: Date) => {
    if (!event.allDay) return ICAL.Time.fromJSDate(date, true);
    const { year, month, day } = dayParts(date, zone);
    return ICAL.Time.fromData({ year, month, day, isDate: true });
  };
  vevent.addPropertyWithValue("dtstart", moment(event.start));
  vevent.addPropertyWithValue("dtend", moment(event.end));
  if (event.location) vevent.addPropertyWithValue("location", event.location);
  if (event.attendees.length > 0) {
    const organizer = vevent.addPropertyWithValue("organizer", `mailto:${owner}`);
    organizer.setParameter("cn", owner);
    for (const email of event.attendees) {
      const attendee = vevent.addPropertyWithValue("attendee", `mailto:${email}`);
      attendee.setParameter("partstat", "NEEDS-ACTION");
      attendee.setParameter("rsvp", "TRUE");
    }
  }
  root.addSubcomponent(vevent);
  return root.toString();
}

function peopleOf(data: string): Person | undefined {
  const card = new ICAL.Component(ICAL.parse(data));
  const name = card.getFirstPropertyValue("fn");
  const phones = card.getAllProperties("tel").map((property) => String(property.getFirstValue()));
  const emails = card.getAllProperties("email").map((property) => String(property.getFirstValue()));
  if (typeof name !== "string" || !name) return undefined;
  return { sources: ["icloud"], name, phones, emails };
}

function cardObject(person: NewPerson): string {
  const card = new ICAL.Component(["vcard", [], []]);
  card.addPropertyWithValue("version", "3.0");
  card.addPropertyWithValue("prodid", "-//Tether//Contacts//EN");
  card.addPropertyWithValue("uid", randomUUID());
  card.addPropertyWithValue("fn", person.name);
  card.addPropertyWithValue("n", [person.name, "", "", "", ""]);
  if (person.phone) card.addPropertyWithValue("tel", person.phone);
  if (person.email) card.addPropertyWithValue("email", person.email);
  return card.toString();
}

export function icloudBackends(config: IcloudConfig, timezone: string, endpoints: IcloudEndpoints = {}): Backends {
  const caldav = lazy(async () => {
    const client = connect("caldav", endpoints.caldavUrl ?? ICLOUD_CALDAV_URL, config);
    await client.login();
    const calendars = (await client.fetchCalendars()).filter((entry) => !entry.components || entry.components.includes("VEVENT"));
    if (calendars.length === 0) throw new Error("no iCloud calendars found");
    return { client, calendars };
  });
  const carddav = lazy(async () => {
    const client = connect("carddav", endpoints.carddavUrl ?? ICLOUD_CARDDAV_URL, config);
    await client.login();
    const books = await client.fetchAddressBooks();
    if (books.length === 0) throw new Error("no iCloud address books found");
    return { client, books };
  });

  const calendars: CalendarBackend = {
    source: "icloud",
    list: async (from, to) => {
      const { client, calendars: all } = await caldav();
      const found: CalendarEvent[] = [];
      for (const calendar of all) {
        const objects = await client.fetchCalendarObjects({ calendar, timeRange: { start: from.toISOString(), end: to.toISOString() }, expand: true });
        for (const object of objects) {
          if (typeof object.data !== "string") continue;
          for (const event of eventsOf(object.data, timezone)) {
            if (event.end > from && event.start < to) found.push(event);
          }
        }
      }
      return found;
    },
    create: async (event) => {
      const { client, calendars: all } = await caldav();
      const target = all.find((entry) => !entry.components || entry.components.includes("VEVENT"));
      if (!target) throw new Error("no iCloud calendar to write to");
      const response = await client.createCalendarObject({
        calendar: target,
        iCalString: calendarObject(event, timezone, config.appleId),
        filename: `${randomUUID()}.ics`,
      });
      if (!response.ok) throw new Error(`iCloud refused the event (${response.status})`);
    },
  };

  const contacts: ContactsBackend = {
    source: "icloud",
    find: async (query) => {
      const { client, books } = await carddav();
      const needle = query.toLowerCase();
      const found: Person[] = [];
      for (const addressBook of books) {
        for (const card of await client.fetchVCards({ addressBook })) {
          if (typeof card.data !== "string") continue;
          const person = peopleOf(card.data);
          if (!person) continue;
          const haystack = [person.name, ...person.phones, ...person.emails].join("\n").toLowerCase();
          if (haystack.includes(needle)) found.push(person);
        }
      }
      return found;
    },
    add: async (person) => {
      const { client, books } = await carddav();
      const target = books[0];
      if (!target) throw new Error("no iCloud address book to write to");
      const response = await client.createVCard({ addressBook: target, vCardString: cardObject(person), filename: `${randomUUID()}.vcf` });
      if (!response.ok) throw new Error(`iCloud refused the contact (${response.status})`);
    },
  };

  return { calendar: [calendars], contacts: [contacts] };
}
