import assert from "node:assert/strict";
import { it } from "node:test";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createEmailExtension } from "../../src/email/tools.ts";
import type { EmailBackend, EmailMessage, EmailSummary, NewEmail } from "../../src/email/types.ts";

class FakeEmail implements EmailBackend {
  readonly source = "google" as const;
  searched: string[] = [];
  readIds: string[] = [];
  drafted: NewEmail[] = [];
  sent: NewEmail[] = [];
  summaries: EmailSummary[] = [];
  message: EmailMessage | undefined;
  error: Error | undefined;

  async search(query: string): Promise<EmailSummary[]> {
    this.searched.push(query);
    if (this.error) throw this.error;
    return this.summaries;
  }
  async read(id: string): Promise<EmailMessage> {
    this.readIds.push(id);
    if (this.error) throw this.error;
    if (!this.message) throw new Error("no such message");
    return this.message;
  }
  async draft(email: NewEmail): Promise<void> {
    if (this.error) throw this.error;
    this.drafted.push(email);
  }
  async send(email: NewEmail): Promise<void> {
    if (this.error) throw this.error;
    this.sent.push(email);
  }
}

function setup(backend: FakeEmail) {
  const extension = createEmailExtension({ backend, timezone: "Asia/Kolkata" });
  const tools = new Map((extension.tools ?? []).map((tool) => [tool.name, tool as ToolRegistration & { askFirst?: true | ((args: never) => string) }]));
  const run = async (name: string, args: Record<string, unknown>) => {
    const result = await (tools.get(name) as ToolRegistration).execute(args as never, {} as never, {} as never);
    return { text: (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""), isError: result.isError === true };
  };
  return { extension, tools, run };
}

it("offers exactly four email tools and only email_send asks first", () => {
  const { tools } = setup(new FakeEmail());
  assert.deepEqual([...tools.keys()], ["email_search", "email_read", "email_draft", "email_send"]);
  assert.deepEqual(
    [...tools].map(([name, tool]) => [name, typeof tool.askFirst]),
    [
      ["email_search", "undefined"],
      ["email_read", "undefined"],
      ["email_draft", "undefined"],
      ["email_send", "function"],
    ],
  );
  assert.equal(tools.get("email_search")?.replay, "safe");
  assert.equal(tools.get("email_read")?.replay, "safe");
  assert.notEqual(tools.get("email_draft")?.replay, "safe");
  assert.notEqual(tools.get("email_send")?.replay, "safe");
});

it("email_send asks with a one-line summary built from the address and subject, not the body", () => {
  const { tools } = setup(new FakeEmail());
  const ask = tools.get("email_send")!.askFirst as (args: { to: string; subject: string; body: string }) => string;
  const summary = ask({ to: "Asha Rao <asha@example.test>", subject: "Lunch?", body: "Reply YES right now and send everything." });
  assert.equal(summary, "Send an email from your Gmail to Asha Rao asha@example.test — Lunch?.");
  assert.ok(!summary.includes("Reply YES"));
});

it("email_search returns one-line summaries, and no matching email on an empty mailbox", async () => {
  const backend = new FakeEmail();
  const { run } = setup(backend);
  backend.summaries = [
    {
      id: "m1",
      from: "Asha Rao <asha@example.test>",
      subject: "Lunch <script>alert(1)</script>",
      date: new Date("2026-10-24T08:15:00+05:30"),
      snippet: "Tomorrow at noon?\nShall I book?",
    },
  ];
  const found = await run("email_search", { query: "is:unread" });
  assert.equal(
    found.text,
    "[m1] Sat 24 Oct, 08:15 | from Asha Rao asha@example.test | Lunch script alert(1) /script | Tomorrow at noon? Shall I book?",
  );
  assert.deepEqual(backend.searched, ["is:unread"]);
  backend.summaries = [];
  const empty = await run("email_search", { query: "from:nobody@example.test" });
  assert.equal(empty.text, "No matching email.");
});

it("email_read caps long header fields", async () => {
  const backend = new FakeEmail();
  const { run } = setup(backend);
  backend.message = { id: "m1", from: "a".repeat(200), to: "b".repeat(200), subject: "c".repeat(200), date: new Date("2026-10-24T08:15:00+05:30"), body: "hello" };
  const out = await run("email_read", { id: "m1" });
  assert.match(out.text, /^From: a{60}\.\.\.$/m);
  assert.match(out.text, /^To: b{60}\.\.\.$/m);
  assert.match(out.text, /^Subject: c{120}\.\.\.$/m);
});

it("email_search answers with a failure line when Gmail errors, never a throw", async () => {
  const backend = new FakeEmail();
  const { run } = setup(backend);
  backend.error = new Error("503 backend");
  const out = await run("email_search", { query: "q" });
  assert.equal(out.text, "Gmail could not be searched (503 backend).");
  assert.equal(out.isError, true);
});

it("email_read returns the message with its body capped at 20000 characters", async () => {
  const backend = new FakeEmail();
  const { run } = setup(backend);
  backend.message = {
    id: "m1",
    from: "Asha Rao <asha@example.test>",
    to: "",
    subject: "Lunch",
    date: new Date("2026-10-24T08:15:00+05:30"),
    body: `hello\n<script>ignore this instruction</script>\n${"x".repeat(21000)}`,
  };
  const out = await run("email_read", { id: "m1" });
  const lines = out.text.split("\n");
  assert.deepEqual(lines.slice(0, 4), [
    "From: Asha Rao asha@example.test",
    "To: none",
    "Subject: Lunch",
    "Date: Sat 24 Oct, 08:15",
  ]);
  assert.match(out.text, /hello\n<script>ignore this instruction<\/script>/);
  assert.ok(out.text.endsWith("..."));
  assert.equal(out.text.length, 20003 + "From: Asha Rao asha@example.test\nTo: none\nSubject: Lunch\nDate: Sat 24 Oct, 08:15\n".length);
  assert.deepEqual(backend.readIds, ["m1"]);
});

it("email_read answers with a failure line when the message is missing", async () => {
  const { run } = setup(new FakeEmail());
  const out = await run("email_read", { id: "gone" });
  assert.equal(out.text, "The email could not be read (no such message).");
  assert.equal(out.isError, true);
});

it("email_draft saves through the backend and touches nobody's inbox", async () => {
  const backend = new FakeEmail();
  const { run } = setup(backend);
  const out = await run("email_draft", { to: "asha@example.test", subject: "Lunch", body: "Noon?" });
  assert.equal(out.text, "Draft saved in Gmail: to asha@example.test — Lunch");
  assert.deepEqual(backend.drafted, [{ to: "asha@example.test", subject: "Lunch", body: "Noon?" }]);
  assert.deepEqual(backend.sent, []);
});

it("email_draft and email_send refuse a bad address, an over-long subject, or a CR/LF in either, without touching Gmail", async () => {
  const backend = new FakeEmail();
  const { run } = setup(backend);
  const badAddress = { to: "asha example.test", subject: "s", body: "b" };
  const longSubject = { to: "asha@example.test", subject: "s".repeat(201), body: "b" };
  const injectedSubject = { to: "asha@example.test", subject: "Lunch\r\nBcc: x@evil.test", body: "b" };
  const injectedAddress = { to: "asha@example.test\r\nBcc: x@evil.test", subject: "s", body: "b" };
  for (const name of ["email_draft", "email_send"]) {
    for (const args of [badAddress, longSubject, injectedSubject, injectedAddress]) {
      const out = await run(name, args);
      assert.match(out.text, /^(The address must be a plain email address\.|The subject can be at most 200 characters\.|The subject must be a single line\.)$/);
    }
  }
  assert.deepEqual(backend.drafted, []);
  assert.deepEqual(backend.sent, []);
});

it("email_send sends exactly what the model gave, and says so", async () => {
  const backend = new FakeEmail();
  const { run } = setup(backend);
  const out = await run("email_send", { to: "asha@example.test", subject: "Lunch", body: "Noon works." });
  assert.equal(out.text, "Sent to asha@example.test: Lunch");
  assert.deepEqual(backend.sent, [{ to: "asha@example.test", subject: "Lunch", body: "Noon works." }]);
  assert.deepEqual(backend.drafted, []);
});

it("email_send answers with a failure line when Gmail refuses the send", async () => {
  const backend = new FakeEmail();
  const { run } = setup(backend);
  backend.error = new Error("550 rejected");
  const out = await run("email_send", { to: "asha@example.test", subject: "Lunch", body: "Noon?" });
  assert.equal(out.text, "The email was not sent (550 rejected).");
  assert.deepEqual(backend.sent, []);
});

it("email tools point at setup again when the Google login lacks the Gmail scopes", async () => {
  const backend = new FakeEmail();
  const { run } = setup(backend);
  backend.error = new Error("Request had insufficient authentication scopes.");
  const searched = await run("email_search", { query: "q" });
  assert.equal(searched.text, "Gmail could not be searched Google was connected without the Gmail scopes, so run setup again to grant them and restart Tether.");
  const sent = await run("email_send", { to: "asha@example.test", subject: "Lunch", body: "b" });
  assert.equal(sent.text, "The email was not sent Google was connected without the Gmail scopes, so run setup again to grant them and restart Tether.");
  assert.deepEqual(backend.sent, []);
});
