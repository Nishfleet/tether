import { calendar, type calendar_v3 } from "@googleapis/calendar";
import { people, type people_v1 } from "@googleapis/people";
import { OAuth2Client } from "google-auth-library";
import type { GoogleConfig } from "./config.ts";
import { isoDay, parseWhen } from "./time.ts";
import type { Backends, CalendarBackend, CalendarEvent, ContactsBackend, NewEvent, NewPerson, Person } from "./types.ts";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/contacts",
] as const;

export type GoogleEndpoints = {
  readonly tokenUrl?: string;
  readonly calendarRoot?: string;
  readonly peopleRoot?: string;
};

const MAX_EVENTS = 250;
const MAX_CALENDARS = 50;
const MAX_CONTACTS = 30;
const PERSON_FIELDS = "names,phoneNumbers,emailAddresses";

function dayStart(value: string | null | undefined, zone: string): Date | undefined {
  return value ? parseWhen(value, zone)?.date : undefined;
}

export function googleBackends(config: GoogleConfig, timezone: string, endpoints: GoogleEndpoints = {}): Backends {
  const auth = new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    ...(endpoints.tokenUrl ? { endpoints: { oauth2TokenUrl: endpoints.tokenUrl } } : {}),
  });
  auth.setCredentials({ refresh_token: config.refreshToken });
  const events = calendar({ version: "v3", auth, ...(endpoints.calendarRoot ? { rootUrl: endpoints.calendarRoot } : {}) });
  const book = people({ version: "v1", auth, ...(endpoints.peopleRoot ? { rootUrl: endpoints.peopleRoot } : {}) });
  let warmed = false;

  const toEvent = (item: calendar_v3.Schema$Event): CalendarEvent | undefined => {
    if (item.status === "cancelled") return undefined;
    const allDay = Boolean(item.start?.date);
    const start = allDay ? dayStart(item.start?.date, timezone) : item.start?.dateTime ? new Date(item.start.dateTime) : undefined;
    const end = allDay ? dayStart(item.end?.date, timezone) : item.end?.dateTime ? new Date(item.end.dateTime) : undefined;
    if (!start || !end) return undefined;
    return {
      sources: ["google"],
      title: item.summary ?? "(no title)",
      start,
      end,
      allDay,
      location: item.location ?? "",
      attendees: (item.attendees ?? []).filter((person) => !person.self).length,
    };
  };

  const calendars: CalendarBackend = {
    source: "google",
    list: async (from, to) => {
      const listed = await events.calendarList.list({ maxResults: MAX_CALENDARS, minAccessRole: "reader" });
      const ids = (listed.data.items ?? []).filter((entry) => entry.selected !== false).map((entry) => entry.id).filter((id): id is string => Boolean(id));
      const found: CalendarEvent[] = [];
      for (const calendarId of ids.length > 0 ? ids : ["primary"]) {
        const page = await events.events.list({
          calendarId,
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          singleEvents: true,
          orderBy: "startTime",
          maxResults: MAX_EVENTS,
        });
        for (const item of page.data.items ?? []) {
          const mapped = toEvent(item);
          if (mapped) found.push(mapped);
        }
      }
      return found;
    },
    create: async (event: NewEvent) => {
      const body: calendar_v3.Schema$Event = {
        summary: event.title,
        ...(event.location ? { location: event.location } : {}),
        ...(event.allDay
          ? { start: { date: isoDay(event.start, timezone) }, end: { date: isoDay(event.end, timezone) } }
          : { start: { dateTime: event.start.toISOString(), timeZone: timezone }, end: { dateTime: event.end.toISOString(), timeZone: timezone } }),
        ...(event.attendees.length > 0 ? { attendees: event.attendees.map((email) => ({ email })) } : {}),
      };
      await events.events.insert({ calendarId: "primary", requestBody: body, sendUpdates: event.attendees.length > 0 ? "all" : "none" });
    },
  };

  const toPerson = (item: people_v1.Schema$Person): Person => ({
    sources: ["google"],
    name: item.names?.[0]?.displayName ?? "(no name)",
    phones: (item.phoneNumbers ?? []).map((phone) => phone.value ?? "").filter(Boolean),
    emails: (item.emailAddresses ?? []).map((email) => email.value ?? "").filter(Boolean),
  });

  const contacts: ContactsBackend = {
    source: "google",
    find: async (query) => {
      if (!warmed) {
        await book.people.searchContacts({ query: "", readMask: PERSON_FIELDS });
        warmed = true;
      }
      const found = await book.people.searchContacts({ query, readMask: PERSON_FIELDS, pageSize: MAX_CONTACTS });
      return (found.data.results ?? []).flatMap((result) => (result.person ? [toPerson(result.person)] : []));
    },
    add: async (person: NewPerson) => {
      await book.people.createContact({
        personFields: PERSON_FIELDS,
        requestBody: {
          names: [{ unstructuredName: person.name }],
          ...(person.phone ? { phoneNumbers: [{ value: person.phone }] } : {}),
          ...(person.email ? { emailAddresses: [{ value: person.email }] } : {}),
        },
      });
    },
  };

  return { calendar: [calendars], contacts: [contacts] };
}
