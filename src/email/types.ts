export type EmailSummary = {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly date: Date | undefined;
  readonly snippet: string;
};

export type EmailMessage = {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly date: Date | undefined;
  readonly body: string;
};

export type NewEmail = {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
};

export type EmailBackend = {
  readonly source: "google";
  search(query: string): Promise<EmailSummary[]>;
  read(id: string): Promise<EmailMessage>;
  draft(email: NewEmail): Promise<void>;
  send(email: NewEmail): Promise<void>;
};
