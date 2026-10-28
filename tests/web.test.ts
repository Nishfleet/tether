import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Links, NOTE, MAX_HTML_BYTES, MAX_PAGE_CHARS, SEARCH_RESULTS, SEARCH_URL, SNIPPET_CHARS, clean, formatResults, pageTarget, readPage, reason, searchWeb, webTools } from "../src/web.ts";

type Seen = { url: string; init: { headers: Record<string, string>; redirect: string; method?: string; body?: string } };

const exa = (body: unknown, seen: Seen[] = [], status = 200) => async (url: string, init: Seen["init"]) => {
  seen.push({ url, init });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
};

const page = (body: string, seen: Seen[] = [], type = "text/html; charset=utf-8", status = 200) => async (url: string, init: Seen["init"]) => {
  seen.push({ url, init });
  return new Response(body, { status, headers: { "content-type": type } });
};

const ARTICLE = [
  "<!doctype html><html><head><title>Tea Notes</title></head><body>",
  "<nav>Home About Subscribe</nav>",
  "<article><h1>Tea Notes</h1>",
  `<p>${"Kombucha is a fermented tea. ".repeat(20)}</p>`,
  `<p>${"It grows a culture on the surface. ".repeat(20)}</p>`,
  "</article><footer>All rights reserved</footer><script>alert(1)</script></body></html>",
].join("");

const row = (title: string, url: string, text = `${title} body`, publishedDate = "2026-10-01T00:00:00.000Z") => ({ title, url, text, publishedDate });

describe("web search", () => {
  it("posts the query to Exa and shapes the rows into results", async () => {
    const seen: Seen[] = [];
    const results = await searchWeb(exa({ results: [row("One", "https://one.test/a"), row("Two", "https://two.test/b")] }, seen), "exa-key", "tea");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, SEARCH_URL);
    assert.equal(seen[0]?.init.method, "POST");
    assert.equal(seen[0]?.init.redirect, "error");
    assert.equal(seen[0]?.init.headers["x-api-key"], "exa-key");
    const sent = JSON.parse(seen[0]?.init.body ?? "{}");
    assert.equal(sent.query, "tea");
    assert.equal(sent.numResults, SEARCH_RESULTS);
    assert.deepEqual(results, [
      { title: "One", url: "https://one.test/a", published: "2026-10-01", snippet: "One body" },
      { title: "Two", url: "https://two.test/b", published: "2026-10-01", snippet: "Two body" },
    ]);
  });

  it("keeps rank, drops rows without a link, and caps snippets", async () => {
    const long = "x".repeat(SNIPPET_CHARS * 2);
    const rows = [row("A", "https://a.test"), { title: "no link" }, row("B", "https://b.test", long), row("C", ""), row("D", "https://d.test")];
    const results = await searchWeb(exa({ results: rows }), "k", "q");
    assert.deepEqual(results.map((result) => result.title), ["A", "B", "D"]);
    assert.equal(results[1]?.snippet.length, SNIPPET_CHARS);
  });

  it("returns nothing for a body without results", async () => {
    assert.deepEqual(await searchWeb(exa({}), "k", "q"), []);
    assert.deepEqual(await searchWeb(exa({ results: "nope" }), "k", "q"), []);
  });

  it("reports a failed search", async () => {
    await assert.rejects(searchWeb(exa({ results: [] }, [], 401), "k", "q"), /search status 401/);
    await assert.rejects(
      searchWeb(async () => {
        throw new Error("network down");
      }, "k", "q"),
      /network down/,
    );
  });

  it("formats the results for the model, dated and marked as data", () => {
    const shown = formatResults("tea", [
      { title: "One", url: "https://one.test/a", published: "2026-10-01", snippet: "First." },
      { title: "Two", url: "https://two.test/b", published: "", snippet: "" },
    ]);
    assert.match(shown, /^2 result\(s\) for "tea":/);
    assert.match(shown, /1\. One \(2026-10-01\)\nhttps:\/\/one\.test\/a\nFirst\./);
    assert.match(shown, /2\. Two\nhttps:\/\/two\.test\/b$/m);
    assert.ok(shown.endsWith(NOTE));
  });
});

describe("page target", () => {
  it("accepts an ordinary public link", () => {
    assert.equal(pageTarget("https://example.com/a?b=c")?.hostname, "example.com");
    assert.equal(pageTarget("  http://example.com  ")?.protocol, "http:");
  });

  it("refuses anything that is not a public web link", () => {
    for (const bad of [
      "not a url",
      "",
      "file:///etc/passwd",
      "ftp://example.com/x",
      "javascript:alert(1)",
      "http://localhost:4000/health/readiness",
      "http://api.localhost/",
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fd00::1]:4000/health/readiness",
      "http://printer.local/",
    ]) {
      assert.equal(pageTarget(bad), undefined, bad);
    }
  });
});

describe("web read", () => {
  it("returns the readable article as text, without menus or scripts", async () => {
    const seen: Seen[] = [];
    const read = await readPage(page(ARTICLE, seen), "tether-test", new URL("https://tea.test/notes"));
    assert.equal(seen[0]?.url, "https://tea.test/notes");
    assert.equal(seen[0]?.init.redirect, "follow");
    assert.equal(seen[0]?.init.headers["user-agent"], "tether-test");
    assert.equal(read.url, "https://tea.test/notes");
    assert.equal(read.title, "Tea Notes");
    assert.match(read.text, /Kombucha is a fermented tea/);
    assert.doesNotMatch(read.text, /Home About Subscribe|All rights reserved|alert/);
    assert.ok(read.text.length < 2000);
  });

  it("keeps a plain text page as it is", async () => {
    const read = await readPage(page("  plain\n\n\n\ntext  ", [], "text/plain"), "ua", new URL("https://tea.test/t.txt"));
    assert.equal(read.text, "plain\n\ntext");
  });

  it("stops at the byte cap", async () => {
    const read = await readPage(page("y".repeat(MAX_HTML_BYTES * 2), [], "text/plain"), "ua", new URL("https://tea.test/big.txt"));
    assert.equal(read.text.length, MAX_HTML_BYTES);
    assert.ok(MAX_HTML_BYTES > MAX_PAGE_CHARS);
  });

  it("refuses a page it cannot read as text", async () => {
    await assert.rejects(readPage(page("%PDF-1.7", [], "application/pdf"), "ua", new URL("https://tea.test/a.pdf")), /not a readable page/);
    await assert.rejects(readPage(page("gone", [], "text/html", 404), "ua", new URL("https://tea.test/missing")), /read status 404/);
  });

  it("tidies whitespace", () => {
    assert.equal(clean(" a  b \n\n\n\n c \n"), "a b\n\nc");
  });
});

describe("web tools", () => {
  it("names the reason a call failed, so a dead host is not just a type name", () => {
    assert.equal(reason(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })), "ENOTFOUND");
    assert.equal(reason(new TypeError("fetch failed")), "TypeError");
    assert.equal(reason(new Error("search status 500")), "Error");
    assert.equal(reason("nope"), "unknown");
  });

  it("offers two read-only tools, and only web_read can ask first", () => {
    const tools = webTools({ fetch: async () => new Response(""), userAgent: "tether-test", log: () => {}, links: new Links(), searchApiKey: "k" });
    assert.deepEqual(tools.map((tool) => tool.name), ["web_search", "web_read"]);
    assert.equal("askFirst" in tools[0], false);
    assert.equal("askFirst" in tools[1], true);
    for (const tool of tools) assert.equal(tool.replay, "safe");
  });

  it("asks only for a public link that came from neither the owner nor a search", () => {
    const links = new Links();
    const [, read] = webTools({ fetch: async () => new Response(""), userAgent: "t", log: () => {}, links });
    const rule = (url: string) => (read.askFirst as (args: { url: string }) => string | undefined)({ url });
    assert.match(rule("https://evil.test/?d=notes") ?? "", /^Open this link\? It did not come from you or a search: https:\/\/evil\.test\/\?d=notes$/);
    assert.equal(rule("http://127.0.0.1/"), undefined, "a refused link needs no ask");
    links.fromOwner("read https://tea.test/a#top, please");
    links.fromSearch([{ title: "t", url: "https://found.test/b", published: "", snippet: "" }]);
    assert.equal(rule("https://tea.test/a"), undefined);
    assert.equal(rule("https://found.test/b"), undefined);
    assert.ok(rule("https://tea.test/a/other"));
    links.newTask();
    assert.ok(rule("https://found.test/b"), "a search result counts for its own task only");
    assert.equal(rule("https://tea.test/a"), undefined, "the owner's text stays");
    links.fromOwner("see (https://en.wikipedia.org/wiki/Foo_(bar)) and https://tea.test/b).");
    assert.equal(rule("https://en.wikipedia.org/wiki/Foo_(bar)"), undefined);
    assert.equal(rule("https://tea.test/b"), undefined);
  });
});
