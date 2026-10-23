import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const CLIENT_ID = "client-id.example";
export const CLIENT_SECRET = "client-secret";
export const REFRESH_TOKEN = "refresh-token";
export const ACCESS_TOKEN = "access-token";

export type Seen = { method: string; path: string; query: URLSearchParams; body: unknown };

export class FakeGoogle {
  readonly seen: Seen[] = [];
  readonly tokenForms: URLSearchParams[] = [];
  readonly badAuth: string[] = [];
  calendars: unknown[] = [{ id: "primary", selected: true }, { id: "family", selected: true }, { id: "hidden", selected: false }];
  eventsByCalendar: Record<string, unknown[]> = {};
  contacts: unknown[] = [];
  grantedScopes: string[] = [];
  private server: Server | undefined;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}/`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", this.url);
    const json = (payload: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
    if (url.pathname === "/token") {
      const form = new URLSearchParams(raw);
      this.tokenForms.push(form);
      json(
        form.get("grant_type") === "authorization_code"
          ? { access_token: ACCESS_TOKEN, expires_in: 3600, token_type: "Bearer", refresh_token: REFRESH_TOKEN, scope: this.grantedScopes.join(" ") }
          : { access_token: ACCESS_TOKEN, expires_in: 3600, token_type: "Bearer" },
      );
      return;
    }
    if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) this.badAuth.push(String(req.headers.authorization));
    const body = raw ? (JSON.parse(raw) as unknown) : undefined;
    this.seen.push({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, body });
    if (url.pathname === "/calendar/v3/users/me/calendarList") {
      json({ items: this.calendars });
      return;
    }
    const listed = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
    if (listed && req.method === "GET") {
      json({ items: this.eventsByCalendar[decodeURIComponent(listed[1] as string)] ?? [] });
      return;
    }
    if (listed && req.method === "POST") {
      json({ id: "new", ...(body as object) });
      return;
    }
    if (url.pathname === "/v1/people:searchContacts") {
      json({ results: url.searchParams.get("query") === "" ? [] : this.contacts });
      return;
    }
    if (url.pathname === "/v1/people:createContact") {
      json({ resourceName: "people/new", ...(body as object) });
      return;
    }
    res.writeHead(404).end();
  }
}
