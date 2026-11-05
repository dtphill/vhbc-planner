import { XMLParser, XMLValidator } from "fast-xml-parser";
import { rankSearchResults } from "./search-ranking.mjs";

const SEARCH_ENDPOINT = "https://boardgamegeek.com/xmlapi2/search";
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RESULTS = 25;
const REQUEST_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MANUAL_FALLBACK = "You can still add a game by pasting its BoardGameGeek game-page link and entering its title.";

/** Extract a BGG game ID without accepting a user-controlled fetch destination. */
export function parseBggId(link) {
  if (typeof link !== "string" || link.length > 2048) return null;
  const input = link.trim();
  // URL() normalises backslashes and control characters; reject those first.
  if (!input || /[\u0000-\u0020\u007f\\]/u.test(input)) return null;

  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(input)) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!["boardgamegeek.com", "www.boardgamegeek.com"].includes(url.hostname.toLowerCase())) return null;
  if (url.username || url.password || url.port) return null;

  const match = /^\/boardgame\/([1-9]\d*)(?:\/[^\s]*)?$/u.exec(url.pathname);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function unavailable(message) {
  return { results: [], externalAvailable: false, message: `${message} ${MANUAL_FALLBACK}` };
}

function validResult(result) {
  return result && typeof result === "object"
    && typeof result.title === "string" && result.title.trim().length > 0 && result.title.length <= 300
    && Number.isSafeInteger(result.bggId) && result.bggId > 0
    && (result.year === null || (Number.isSafeInteger(result.year) && result.year !== 0 && Math.abs(result.year) <= 9999));
}

async function cachedResults(db, query) {
  if (!db?.prepare) return null;
  try {
    const row = await db.prepare(
      "SELECT response FROM bgg_cache WHERE query = ? AND expires_at > ? LIMIT 1",
    ).bind(query, Date.now()).first();
    if (typeof row?.response !== "string" || row.response.length > MAX_RESPONSE_BYTES) return null;
    const results = JSON.parse(row.response);
    if (!Array.isArray(results) || results.length > MAX_RESULTS || !results.every(validResult)) return null;
    return results.map(({ title, bggId, year }) => ({ title, bggId, year }));
  } catch {
    // Cache availability must not block a configured BGG search.
    return null;
  }
}

async function cacheResults(db, query, results) {
  if (!db?.prepare) return;
  try {
    await db.prepare(
      "INSERT INTO bgg_cache (query, response, expires_at) VALUES (?, ?, ?) "
      + "ON CONFLICT(query) DO UPDATE SET response = excluded.response, expires_at = excluded.expires_at",
    ).bind(query, JSON.stringify(results), Date.now() + CACHE_TTL_MS).run();
  } catch {
    // A missing/unavailable cache table does not turn a successful lookup into an error.
  }
}

async function readBoundedBody(response) {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    if (response.body) await response.body.cancel().catch(() => {});
    throw new Error("BGG response exceeded the size limit");
  }
  if (!response.body) throw new Error("BGG returned an empty response");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("BGG response exceeded the size limit");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function parseSearchXml(xml, query) {
  // The search endpoint has no need for DTDs or custom entities. Reject them
  // before the validator/parser can process any entity declarations.
  if (!xml.trim() || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error("Unsupported XML declaration");
  if (XMLValidator.validate(xml) !== true) throw new Error("Invalid XML response");

  const parser = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
    processEntities: true,
    htmlEntities: false,
    maxNestedTags: 12,
    maxEntityCount: 10000,
  });
  const parsed = parser.parse(xml);
  const roots = Object.keys(parsed).filter((key) => !key.startsWith("?"));
  if (roots.length !== 1 || roots[0] !== "items" || !parsed.items || typeof parsed.items !== "object" || Array.isArray(parsed.items)) {
    throw new Error("Unexpected XML response");
  }

  const items = parsed.items.item == null ? [] : (Array.isArray(parsed.items.item) ? parsed.items.item : [parsed.items.item]);
  const results = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || item["@_type"] !== "boardgame" || !/^[1-9]\d*$/.test(String(item["@_id"] ?? ""))) continue;
    const bggId = Number(item["@_id"]);
    if (!Number.isSafeInteger(bggId) || seen.has(bggId)) continue;
    const names = Array.isArray(item.name) ? item.name : [item.name];
    const name = names.find((entry) => entry?.["@_type"] === "primary" && typeof entry?.["@_value"] === "string")
      ?? names.find((entry) => typeof entry?.["@_value"] === "string");
    const title = name?.["@_value"]?.replace(/\s+/gu, " ").trim();
    const rawYear = item.yearpublished?.["@_value"];
    const numericYear = /^-?\d+$/.test(String(rawYear ?? "")) ? Number(rawYear) : NaN;
    const year = Number.isSafeInteger(numericYear) && numericYear !== 0 && Math.abs(numericYear) <= 9999 ? numericYear : null;
    const result = { title, bggId, year };
    if (!validResult(result)) continue;
    results.push(result);
    seen.add(bggId);
  }
  // Rank the complete bounded response before limiting it, so exact matches are not lost.
  return rankSearchResults(results, query).slice(0, MAX_RESULTS);
}

/** Search BGG's authorised XML API2. All returned metadata comes from BGG. */
export async function searchBgg(query, env = {}) {
  const token = typeof env?.BGG_TOKEN === "string" ? env.BGG_TOKEN.trim() : "";
  if (!token) return unavailable("BoardGameGeek search has not been connected yet.");

  const term = typeof query === "string" ? query.replace(/\s+/gu, " ").trim() : "";
  if (term.length < 2 || term.length > 120 || /[\u0000-\u001f\u007f]/u.test(term)) {
    return { results: [], externalAvailable: true, message: "Enter between 2 and 120 characters to search BoardGameGeek." };
  }

  const key = "search:v2:" + term.toLowerCase();
  const cached = await cachedResults(env?.DB, key);
  if (cached !== null) {
    return { results: cached, externalAvailable: true, message: cached.length ? "" : "No matching BoardGameGeek titles found. Try another title or add a game using its BGG link." };
  }

  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("query", term);
  url.searchParams.set("type", "boardgame");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/xml, text/xml" },
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.status === 401 || response.status === 403) {
      if (response.body) await response.body.cancel().catch(() => {});
      return unavailable("BoardGameGeek could not authorise the app's search access.");
    }
    if (response.status === 429 || response.status === 202) {
      if (response.body) await response.body.cancel().catch(() => {});
      return unavailable("BoardGameGeek is busy or has temporarily limited searches. Please try again later.");
    }
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});
      return unavailable("BoardGameGeek search is temporarily unavailable.");
    }
    const results = parseSearchXml(await readBoundedBody(response), term);
    await cacheResults(env?.DB, key, results);
    return { results, externalAvailable: true, message: results.length ? "" : "No matching BoardGameGeek titles found. Try another title or add a game using its BGG link." };
  } catch {
    return unavailable(controller.signal.aborted
      ? "BoardGameGeek search took too long to respond. Please try again later."
      : "BoardGameGeek search could not return usable results. Please try again later.");
  } finally {
    clearTimeout(timeout);
  }
}
