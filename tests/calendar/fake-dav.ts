import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const APPLE_ID = "nish@icloud.example";
export const APP_PASSWORD = "abcd-efgh-ijkl-mnop";

export type StoredObject = { name: string; data: string };

const xml = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/">${body}</d:multistatus>`;
const ok = (href: string, props: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export class FakeDav {
  readonly calendarObjects: StoredObject[] = [];
  readonly cards: StoredObject[] = [];
  readonly requests: string[] = [];
  readonly badAuth: string[] = [];
  private server: Server | undefined;
  url = "";

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const path = (req.url ?? "/").split("?")[0] as string;
    this.requests.push(`${req.method} ${path}`);
    const expected = `Basic ${Buffer.from(`${APPLE_ID}:${APP_PASSWORD}`).toString("base64")}`;
    if (req.headers.authorization !== expected) {
      this.badAuth.push(String(req.headers.authorization));
      res.writeHead(401, { "www-authenticate": 'Basic realm="fake"' }).end();
      return;
    }
    const send = (status: number, payload: string) => res.writeHead(status, { "content-type": "application/xml; charset=utf-8" }).end(payload);
    const method = req.method ?? "GET";
    if (method === "PUT") {
      const target = path.startsWith("/cards/") ? this.cards : this.calendarObjects;
      target.push({ name: path.split("/").pop() as string, data: body });
      res.writeHead(201).end();
      return;
    }
    if (method === "PROPFIND") {
      if (path === "/" || path === "/.well-known/caldav" || path === "/.well-known/carddav") {
        send(207, xml(ok(path, "<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>")));
      } else if (path === "/principal/") {
        send(
          207,
          xml(
            ok(
              path,
              "<c:calendar-home-set><d:href>/calendars/</d:href></c:calendar-home-set><card:addressbook-home-set><d:href>/cards/</d:href></card:addressbook-home-set><d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal>",
            ),
          ),
        );
      } else if (path === "/calendars/") {
        send(
          207,
          xml(
            ok(
              "/calendars/home/",
              '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Home</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><cs:getctag>1</cs:getctag>',
            ) +
              ok(
                "/calendars/tasks/",
                '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Reminders</d:displayname><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set><cs:getctag>1</cs:getctag>',
              ),
          ),
        );
      } else if (path === "/cards/") {
        send(207, xml(ok("/cards/main/", "<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>Contacts</d:displayname>")));
      } else {
        res.writeHead(404).end();
      }
      return;
    }
    if (method === "REPORT") {
      if (path.startsWith("/calendars/home")) {
        send(207, xml(this.calendarObjects.map((object) => ok(`/calendars/home/${object.name}`, `<d:getetag>"${object.name}"</d:getetag><c:calendar-data>${escapeXml(object.data)}</c:calendar-data>`)).join("")));
      } else if (path.startsWith("/cards/main")) {
        send(207, xml(this.cards.map((card) => ok(`/cards/main/${card.name}`, `<d:getetag>"${card.name}"</d:getetag><card:address-data>${escapeXml(card.data)}</card:address-data>`)).join("")));
      } else {
        res.writeHead(404).end();
      }
      return;
    }
    res.writeHead(405).end();
  }
}
