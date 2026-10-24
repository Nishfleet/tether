import assert from "node:assert/strict";
import { it } from "node:test";
import { CLIENT_ID, CLIENT_SECRET, FakeGoogle, REFRESH_TOKEN, type FakeGoogleMessage } from "../calendar/fake-google.ts";
import { gmailBackend } from "../../src/email/gmail.ts";
import { GOOGLE_SCOPES } from "../../src/calendar/google.ts";

const b64u = (text: string) => Buffer.from(text, "utf8").toString("base64url");

const plain = (id: string, from: string, subject: string, body: string, when: string, snippet = body): FakeGoogleMessage => ({
  id,
  snippet,
  internalDate: when,
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: from },
      { name: "To", value: "Nish <nish@example.test>" },
      { name: "Subject", value: subject },
    ],
    body: { data: b64u(body), size: body.length },
  },
});

it("gmail search asks only for the two gmail scopes on top of the calendar and contact scopes", () => {
  assert.deepEqual([...GOOGLE_SCOPES].filter((scope) => scope.includes("gmail")), [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ]);
});

it("gmail search lists messages and reads only From and Subject headers for each hit", async () => {
  const google = new FakeGoogle();
  await google.start();
  try {
    google.messageList = ["m1", "m2"];
    google.messagesById = {
      m1: plain("m1", "Asha Rao <asha@example.test>", "Lunch", "Lunch tomorrow?", "1797560702000"),
      m2: plain("m2", "notifications@bank.example", "Statement", "Your statement is ready.", "1797560802000"),
    };
    const backend = gmailBackend(
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN },
      { tokenUrl: `${google.url}token`, gmailRoot: google.url },
    );
    const found = await backend.search("is:unread");
    assert.deepEqual(
      found.map((email) => [email.id, email.from, email.subject, email.snippet]),
      [
        ["m1", "Asha Rao <asha@example.test>", "Lunch", "Lunch tomorrow?"],
        ["m2", "notifications@bank.example", "Statement", "Your statement is ready."],
      ],
    );
    assert.equal(found[0]?.date?.getTime(), 1797560702000);
    const seen = google.seen.filter((call) => call.path.startsWith("/gmail/"));
    assert.deepEqual(seen.map((call) => call.path), ["/gmail/v1/users/me/messages", "/gmail/v1/users/me/messages/m1", "/gmail/v1/users/me/messages/m2"]);
    assert.equal(seen[0]?.query.get("q"), "is:unread");
    assert.equal(seen[0]?.query.get("maxResults"), "10");
    for (const call of seen.slice(1)) {
      assert.equal(call.query.get("format"), "metadata");
      assert.deepEqual(call.query.getAll("metadataHeaders"), ["From", "Subject"]);
    }
  } finally {
    await google.stop();
  }
});

it("gmail read decodes a text/plain body, walks a multipart body, and falls back to the snippet", async () => {
  const google = new FakeGoogle();
  await google.start();
  try {
    google.messagesById = {
      p1: plain("p1", "asha@example.test", "Lunch", "Lunch tomorrow at noon?", "1797560702000"),
      multi: {
        id: "multi",
        snippet: "see attachment",
        internalDate: "1797560702000",
        payload: {
          mimeType: "multipart/mixed",
          headers: [
            { name: "From", value: "asha@example.test" },
            { name: "Subject", value: "Files" },
          ],
          parts: [
            { mimeType: "text/html", body: { data: b64u("<b>ignore</b>") } },
            { mimeType: "text/plain", body: { data: b64u("Files attached.") } },
          ],
        },
      },
      empty: {
        id: "empty",
        snippet: "just a snippet",
        internalDate: "1797560702000",
        payload: { mimeType: "text/html", headers: [{ name: "From", value: "x@example.test" }], body: { data: b64u("<b>html</b>") } },
      },
    };
    const backend = gmailBackend(
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN },
      { tokenUrl: `${google.url}token`, gmailRoot: google.url },
    );
    const one = await backend.read("p1");
    assert.deepEqual([one.from, one.to, one.subject, one.body], ["asha@example.test", "Nish <nish@example.test>", "Lunch", "Lunch tomorrow at noon?"]);
    const many = await backend.read("multi");
    assert.equal(many.body, "Files attached.");
    const none = await backend.read("empty");
    assert.equal(none.body, "just a snippet");
  } finally {
    await google.stop();
  }
});

it("gmail draft and send encode a non-ASCII subject as RFC 2047 words and leave an ASCII subject alone", async () => {
  const google = new FakeGoogle();
  await google.start();
  try {
    const backend = gmailBackend(
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN },
      { tokenUrl: `${google.url}token`, gmailRoot: google.url },
    );
    await backend.send({ to: "asha@example.test", subject: "Réunion déjeuner", body: "À midi ?" });
    await backend.send({ to: "asha@example.test", subject: "Lunch", body: "Noon works." });
    const subjects = google.sent.map((call) => Buffer.from(call.raw ?? "", "base64url").toString("utf8").split("\r\n").find((line) => line.startsWith("Subject:")) ?? "");
    const words = (subjects[0] ?? "").match(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g) ?? [];
    assert.ok(words.length > 0);
    assert.equal(
      words.map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8")).join(""),
      "Réunion déjeuner",
    );
    for (const word of words) assert.ok(word.length <= 75);
    assert.ok((subjects[0] ?? "").startsWith("Subject: =?UTF-8?B?"));
    assert.equal(subjects[1], "Subject: Lunch");
  } finally {
    await google.stop();
  }
});

it("gmail draft and send hand the model's email to Gmail as one base64url MIME message and never deliver a draft", async () => {
  const google = new FakeGoogle();
  await google.start();
  try {
    const backend = gmailBackend(
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN },
      { tokenUrl: `${google.url}token`, gmailRoot: google.url },
    );
    const email = { to: "asha@example.test", subject: "Lunch", body: "Yes, noon works." };
    await backend.draft(email);
    await backend.send(email);
    assert.equal(google.drafts.length, 1);
    assert.equal(google.sent.length, 1);
    const draft = Buffer.from(google.drafts[0]?.message.raw ?? "", "base64url").toString("utf8");
    const sent = Buffer.from(google.sent[0]?.raw ?? "", "base64url").toString("utf8");
    const expected = `To: asha@example.test\r\nSubject: Lunch\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\nYes, noon works.`;
    assert.equal(draft, expected);
    assert.equal(sent, expected);
    assert.deepEqual(
      google.seen.filter((call) => call.path.startsWith("/gmail/")).map((call) => [call.method, call.path]),
      [
        ["POST", "/gmail/v1/users/me/drafts"],
        ["POST", "/gmail/v1/users/me/messages/send"],
      ],
    );
  } finally {
    await google.stop();
  }
});
