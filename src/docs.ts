import { defineDoc } from "@earendil-works/pi-durable";

export type State = {
  stopped: boolean;
  seen: string[];
};

export type Caps = {
  textedOn: string | null;
};

export type Note = {
  id: string;
  text: string;
  at: number;
};

export type Memory = {
  notes: Note[];
  next?: number;
};

export const SEEN_LIMIT = 500;
export const NOTE_LIMIT = 100;
export const NOTE_CHARS = 500;

export const StateDoc = defineDoc<State>({
  kind: "tether.state",
  version: 1,
  scope: "session",
  initial: () => ({ stopped: false, seen: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

export const MemoryDoc = defineDoc<Memory>({
  kind: "tether.memory",
  version: 1,
  scope: "session",
  initial: () => ({ notes: [], next: 1 }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

export const CapsDoc = defineDoc<Caps>({
  kind: "tether.caps",
  version: 1,
  scope: "session",
  initial: () => ({ textedOn: null }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});
