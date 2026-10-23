export type InboundAttachment = {
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  read(): Promise<Buffer>;
};

export type Inbound = {
  readonly id: string;
  readonly sender: string;
  readonly space: string;
  readonly direct: boolean;
  readonly text: string | undefined;
  readonly attachments?: readonly InboundAttachment[];
};

export interface Channel {
  messages(): AsyncIterable<Inbound>;
  send(space: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

export function normalizeHandle(handle: string): string {
  const trimmed = handle.trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : trimmed.replace(/[^\d+]/g, "");
}
