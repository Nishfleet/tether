export type Inbound = {
  readonly id: string;
  readonly sender: string;
  readonly space: string;
  readonly direct: boolean;
  readonly text: string | undefined;
};

export type LiveLocation = {
  readonly latitude: number;
  readonly longitude: number;
  readonly label: string | null;
  readonly at: number;
};

export interface Locations {
  current(): Promise<LiveLocation | undefined>;
  request(space: string): Promise<boolean>;
}

export interface Channel {
  readonly locations?: Locations;
  messages(): AsyncIterable<Inbound>;
  send(space: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

export function normalizeHandle(handle: string): string {
  const trimmed = handle.trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : trimmed.replace(/[^\d+]/g, "");
}
