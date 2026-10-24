import { gmail, type gmail_v1 } from "@googleapis/gmail";
import { OAuth2Client } from "google-auth-library";
import type { GoogleConfig } from "../calendar/config.ts";
import type { GoogleEndpoints } from "../calendar/google.ts";
import type { EmailBackend, EmailMessage, EmailSummary, NewEmail } from "./types.ts";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"] as const;

const MAX_RESULTS = 10;
const SEARCH_HEADERS = ["From", "Subject"];

function header(item: gmail_v1.Schema$Message, name: string): string {
  const found = item.payload?.headers?.find((entry) => entry.name?.toLowerCase() === name.toLowerCase());
  return found?.value ?? "";
}

const decode = (data: string | null | undefined) => (data ? Buffer.from(data, "base64url").toString("utf8") : "");

function plainText(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain") return decode(part.body?.data);
  for (const child of part.parts ?? []) {
    const found = plainText(child);
    if (found) return found;
  }
  return "";
}

const named = (item: gmail_v1.Schema$Message) => ({
  from: header(item, "From"),
  to: header(item, "To"),
  subject: header(item, "Subject"),
});

const sentAt = (item: gmail_v1.Schema$Message): Date | undefined => {
  const ms = Number(item.internalDate);
  return Number.isFinite(ms) && item.internalDate !== undefined ? new Date(ms) : undefined;
};

const mimeSubject = (subject: string): string => {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  const words: string[] = [];
  let chunk = "";
  let used = 0;
  for (const char of subject) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > 45 && chunk) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
      chunk = "";
      used = 0;
    }
    chunk += char;
    used += size;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
  return words.join("\r\n ");
};

const raw = (email: NewEmail) =>
  Buffer.from(`To: ${email.to}\r\nSubject: ${mimeSubject(email.subject)}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${email.body}`, "utf8").toString(
    "base64url",
  );

export function gmailBackend(config: GoogleConfig, endpoints: GoogleEndpoints = {}): EmailBackend {
  const auth = new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    ...(endpoints.tokenUrl ? { endpoints: { oauth2TokenUrl: endpoints.tokenUrl } } : {}),
  });
  auth.setCredentials({ refresh_token: config.refreshToken });
  const client = gmail({ version: "v1", auth, ...(endpoints.gmailRoot ? { rootUrl: endpoints.gmailRoot } : {}) });

  const search = async (query: string): Promise<EmailSummary[]> => {
    const listed = await client.users.messages.list({ userId: "me", q: query, maxResults: MAX_RESULTS });
    const found: EmailSummary[] = [];
    for (const entry of listed.data.messages ?? []) {
      if (!entry.id) continue;
      const item = (await client.users.messages.get({ userId: "me", id: entry.id, format: "metadata", metadataHeaders: SEARCH_HEADERS })).data;
      found.push({ id: entry.id, ...named(item), date: sentAt(item), snippet: item.snippet ?? "" });
    }
    return found;
  };

  const read = async (id: string): Promise<EmailMessage> => {
    const item = (await client.users.messages.get({ userId: "me", id, format: "full" })).data;
    const body = plainText(item.payload) || item.snippet || "";
    return { id, ...named(item), date: sentAt(item), body };
  };

  return {
    source: "google",
    search,
    read,
    draft: async (email) => {
      await client.users.drafts.create({ userId: "me", requestBody: { message: { raw: raw(email) } } });
    },
    send: async (email) => {
      await client.users.messages.send({ userId: "me", requestBody: { raw: raw(email) } });
    },
  };
}
