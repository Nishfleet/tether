export type SourceName = "google" | "icloud";

export type CalendarEvent = {
  readonly sources: readonly SourceName[];
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
  readonly allDay: boolean;
  readonly location: string;
  readonly attendees: number;
};

export type NewEvent = {
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
  readonly allDay: boolean;
  readonly location: string | undefined;
  readonly attendees: readonly string[];
};

export type Person = {
  readonly sources: readonly SourceName[];
  readonly name: string;
  readonly phones: readonly string[];
  readonly emails: readonly string[];
};

export type NewPerson = {
  readonly name: string;
  readonly phone: string | undefined;
  readonly email: string | undefined;
};

export interface CalendarBackend {
  readonly source: SourceName;
  list(from: Date, to: Date): Promise<CalendarEvent[]>;
  create(event: NewEvent): Promise<void>;
}

export interface ContactsBackend {
  readonly source: SourceName;
  find(query: string): Promise<Person[]>;
  add(person: NewPerson): Promise<void>;
}

export type Backends = {
  readonly calendar: readonly CalendarBackend[];
  readonly contacts: readonly ContactsBackend[];
};
