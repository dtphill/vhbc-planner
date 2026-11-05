import assert from "node:assert/strict";
import test from "node:test";
import { parseBggId, searchBgg } from "../src/bgg.mjs";

const XML = `<?xml version="1.0" encoding="utf-8"?>
<items total="2">
  <item type="boardgame" id="40354"><name type="primary" value="Maria"/><yearpublished value="2009"/></item>
  <item type="boardgame" id="249590"><name type="primary" value="Nevsky: Teutons &amp; Rus"/><yearpublished value="2019"/></item>
</items>`;
const ENV = { BGG_TOKEN: "test-token-only" };

test("parseBggId accepts BGG game pages, slugs and mobile-safe query fragments", () => {
  for (const link of [
    "https://boardgamegeek.com/boardgame/40354",
    "https://www.boardgamegeek.com/boardgame/40354/maria",
    "http://boardgamegeek.com/boardgame/40354/maria?ref=group#description",
    " HTTPS://BOARDGAMEGEEK.COM/boardgame/40354/maria ",
  ]) assert.equal(parseBggId(link), 40354, link);
});

test("parseBggId rejects non-BGG and deceptive URLs, credentials and non-game pages", () => {
  for (const link of [
    "https://boardgamegeek.com.attacker.test/boardgame/40354/maria",
    "https://attacker.test/boardgame/40354",
    "https://boardgamegeek.com@attacker.test/boardgame/40354",
    "https://user:password@boardgamegeek.com/boardgame/40354",
    "https://user@boardgamegeek.com/boardgame/40354",
    "https://boardgamegeek.com:8080/boardgame/40354",
    "https://boardgamegeek.com./boardgame/40354",
    "https://boardgamegeek.com/boardgameversion/40354",
    "https://boardgamegeek.com/thread/40354",
    "https://boardgamegeek.com/boardgame/0",
    "https://boardgamegeek.com/boardgame/-1",
    "https://boardgamegeek.com/boardgame/1.5",
    "https://boardgamegeek.com/boardgame/1bad",
    "https://boardgamegeek.com/boardgame/9007199254740992",
    "https://boardgamegeek.com/boardgame/%34%30%33%35%34",
    "https://boardgamegeek.com\\@attacker.test/boardgame/40354",
    "https://boardgamegeek.com/boardgame/40354\n/maria",
    "https:boardgamegeek.com/boardgame/40354",
    "//boardgamegeek.com/boardgame/40354",
    "boardgamegeek.com/boardgame/40354",
    "javascript:alert(1)",
    "ftp://boardgamegeek.com/boardgame/40354",
    "", null, undefined, 40354,
  ]) assert.equal(parseBggId(link), null, String(link));
});

test("missing token never performs network access or returns invented results", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Network request should not occur"));
  const result = await searchBgg("Maria", {});
  assert.deepEqual(result.results, []);
  assert.equal(result.externalAvailable, false);
  assert.match(result.message, /not been connected/);
  assert.match(result.message, /pasting.*link/);
});

test("invalid search terms do not produce API requests", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Network request should not occur"));
  for (const query of [null, "", "a", "a".repeat(121), "bad\u0000query"]) {
    const result = await searchBgg(query, ENV);
    assert.deepEqual(result.results, []);
    assert.match(result.message, /2 and 120/);
  }
});

test("search uses the fixed HTTPS XML API, authorised header and parsed result shape", async (t) => {
  let received;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    received = { url: new URL(url), options };
    return new Response(XML, { headers: { "Content-Type": "text/xml" } });
  });
  const result = await searchBgg("  Maria & Nevsky  ", ENV);
  assert.equal(received.url.origin, "https://boardgamegeek.com");
  assert.equal(received.url.pathname, "/xmlapi2/search");
  assert.equal(received.url.searchParams.get("query"), "Maria & Nevsky");
  assert.equal(received.url.searchParams.get("type"), "boardgame");
  assert.equal(received.options.headers.Authorization, "Bearer test-token-only");
  assert.equal(received.options.redirect, "manual");
  assert.ok(received.options.signal instanceof AbortSignal);
  assert.deepEqual(result, {
    results: [
      { title: "Maria", bggId: 40354, year: 2009 },
      { title: "Nevsky: Teutons & Rus", bggId: 249590, year: 2019 },
    ], externalAvailable: true, message: "",
  });
});

test("single results and absent years are supported, invalid items and duplicate IDs are omitted", async (t) => {
  const xml = `<items total="5">
    <item type="boardgame" id="17"><name type="alternate" value="Alternate"/><name type="primary" value="Primary title"/></item>
    <item type="boardgame" id="17"><name type="primary" value="Duplicate"/></item>
    <item type="boardgame" id="9999999999999999999"><name type="primary" value="Bad ID"/></item>
    <item type="boardgameexpansion" id="18"><name type="primary" value="Expansion"/></item>
    <item type="boardgame" id="19"><name type="primary" value=""/></item>
  </items>`;
  t.mock.method(globalThis, "fetch", async () => new Response(xml));
  assert.deepEqual((await searchBgg("Primary", ENV)).results, [
    { title: "Primary title", bggId: 17, year: null },
  ]);
});

test("a singleton XML item is handled without assuming an array", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response('<items total="1"><item type="boardgame" id="12750"><name type="primary" value="1860"/><yearpublished value="2004"/></item></items>'));
  assert.deepEqual((await searchBgg("1860", ENV)).results, [{ title: "1860", bggId: 12750, year: 2004 }]);
});

test("empty successful search differs from unavailable external search", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response('<items total="0"/>'));
  const result = await searchBgg("Unmatched", ENV);
  assert.equal(result.externalAvailable, true);
  assert.deepEqual(result.results, []);
  assert.match(result.message, /No matching/);
});

test("malformed, unexpected and entity-declaration XML returns a manual fallback", async (t) => {
  let xml;
  t.mock.method(globalThis, "fetch", async () => new Response(xml));
  for (xml of [
    "<items><item></items>",
    "<html><body>Sign in</body></html>",
    "<!DOCTYPE items [<!ENTITY x 'expanded'>]><items total='0'/>",
    "<!ENTITY x 'value'><items total='0'/>",
    "<errors><error message='Invalid token'/></errors>",
    "",
  ]) {
    const result = await searchBgg("Maria", ENV);
    assert.equal(result.externalAvailable, false, xml);
    assert.deepEqual(result.results, []);
    assert.match(result.message, /pasting.*link/);
  }
});

test("API failures never expose token or upstream response text", async (t) => {
  let status;
  t.mock.method(globalThis, "fetch", async () => new Response("Private upstream diagnostic test-token-only", { status }));
  for (status of [202, 401, 403, 429, 500, 503]) {
    const result = await searchBgg("Maria", ENV);
    assert.equal(result.externalAvailable, false);
    assert.deepEqual(result.results, []);
    assert.doesNotMatch(result.message, /test-token-only|Private upstream/);
  }
});

test("network errors return the manual fallback", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unavailable"); });
  const result = await searchBgg("Maria", ENV);
  assert.equal(result.externalAvailable, false);
  assert.match(result.message, /pasting.*link/);
});

test("a stalled upstream request is aborted after six seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  t.mock.method(globalThis, "fetch", (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    started();
  }));
  const pending = searchBgg("Maria", ENV);
  await requestStarted;
  t.mock.timers.tick(6000);
  const result = await pending;
  assert.equal(result.externalAvailable, false);
  assert.deepEqual(result.results, []);
  assert.match(result.message, /took too long/);
});

test("response body is bounded even without content-length", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(" ".repeat(256 * 1024 + 1)));
  const result = await searchBgg("Maria", ENV);
  assert.equal(result.externalAvailable, false);
  assert.deepEqual(result.results, []);
});

test("oversized declared response is rejected before reading", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(XML, { headers: { "Content-Length": String(256 * 1024 + 1) } }));
  assert.equal((await searchBgg("Maria", ENV)).externalAvailable, false);
});

test("valid cache avoids repeated network access and strips unknown stored fields", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Cached result should not fetch"));
  let readArgs;
  const DB = {
    prepare(sql) {
      assert.match(sql, /expires_at > \?/);
      return { bind(...args) {
        readArgs = args;
        return { first: async () => ({ response: JSON.stringify([{ title: "Maria", bggId: 40354, year: 2009, extra: "unused" }]) }) };
      } };
    },
  };
  const result = await searchBgg(" MARIA ", { ...ENV, DB });
  assert.equal(readArgs[0], "search:v2:maria");
  assert.ok(Number.isSafeInteger(readArgs[1]));
  assert.deepEqual(result.results, [{ title: "Maria", bggId: 40354, year: 2009 }]);
});

test("bad cached data is ignored and successful results receive a bounded cache expiry", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(XML));
  let written;
  const DB = {
    prepare(sql) {
      return { bind(...args) {
        return sql.startsWith("SELECT")
          ? { first: async () => ({ response: "not json" }) }
          : { run: async () => { written = args; } };
      } };
    },
  };
  const before = Date.now();
  const result = await searchBgg("Maria", { ...ENV, DB });
  assert.equal(result.externalAvailable, true);
  assert.equal(written[0], "search:v2:maria");
  assert.deepEqual(JSON.parse(written[1]), result.results);
  assert.ok(written[2] >= before + 24 * 60 * 60 * 1000);
  assert.ok(written[2] <= Date.now() + 24 * 60 * 60 * 1000);
});

test("cache table failures do not suppress a successful upstream result", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(XML));
  const DB = { prepare() { throw new Error("no such table"); } };
  assert.equal((await searchBgg("Maria", { ...ENV, DB })).externalAvailable, true);
});

test("result list is capped at 25 unique games", async (t) => {
  const items = Array.from({ length: 30 }, (_, i) => `<item type="boardgame" id="${i + 1}"><name type="primary" value="Game ${i + 1}"/></item>`).join("");
  t.mock.method(globalThis, "fetch", async () => new Response(`<items total="30">${items}</items>`));
  assert.equal((await searchBgg("Game", ENV)).results.length, 25);
});

test("search redirects are rejected without forwarding the token", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    assert.equal(options.redirect, "manual");
    return new Response("", {status: 302, headers: {Location: "https://elsewhere.invalid/"}});
  });
  const result = await searchBgg("Root", ENV);
  assert.equal(result.externalAvailable, false);
  assert.deepEqual(result.results, []);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /test-token-only/);
});
