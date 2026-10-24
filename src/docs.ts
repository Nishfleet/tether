import { defineDoc } from "@earendil-works/pi-durable";
import type { Tier } from "./tier.ts";

export type Pending = {
  inbound: string;
  space: string;
  prompt: string;
  run: number;
};

export type State = {
  stopped: boolean;
  held: Pending[];
  inflight: Pending[];
  seen: string[];
};

export type TierState = {
  tier: Tier | null;
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
};

export const SEEN_LIMIT = 500;
export const NOTE_LIMIT = 100;
export const NOTE_CHARS = 500;

export const StateDoc = defineDoc<State>({
  kind: "tether.state",
  version: 1,
  scope: "session",
  initial: () => ({ stopped: false, held: [], inflight: [], seen: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

export const MemoryDoc = defineDoc<Memory>({
  kind: "tether.memory",
  version: 1,
  scope: "session",
  initial: () => ({ notes: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

export const TierDoc = defineDoc<TierState>({
  kind: "tether.tier",
  version: 1,
  scope: "session",
  initial: () => ({ tier: null }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});

export const CapsDoc = defineDoc<Caps>({
  kind: "tether.caps",
  version: 1,
  scope: "session",
  initial: () => ({ textedOn: null }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 20,
});
