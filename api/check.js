// api/check.js
// Converted from your server.js for Vercel serverless functions

const BASE = "https://leaderboard-bice-mu.vercel.app/api/zama";
const TIMEFRAMES = [
  { key: "24h", label: "Last 24 hours" },
  { key: "7d", label: "Last 7 days" },
  { key: "month", label: "Last 30 days" }
];
const CACHE_TTL_SECONDS = 60 * 5; // 5 minutes

// Simple in-memory cache using Map with expiry
const cache = new Map();
function cacheSet(key, value, ttl = CACHE_TTL_SECONDS) {
  const expiresAt = Date.now() + ttl * 1000;
  cache.set(key, { value, expiresAt });
}
function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

// Helper fetch JSON
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch failed ${r.status} ${url}`);
  return r.json();
}

// Try to detect list container in the JSON and return an array
function getArrayFromResponse(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.items)) return json.items;
  for (const v of Object.values(json || {})) {
    if (Array.isArray(v)) return v;
  }
  return [];
}

// Normalize entry object -> { rank, username, mindshare, raw }
function normalize(entry, pageIdx, idxInPage, fallbackPageSize = 100) {
  if (!entry || typeof entry !== "object") return null;

  const keys = Object.keys(entry);
  let username = null;
  for (const k of keys) {
    const lk = k.toLowerCase();
    if (lk.includes("username") || lk.includes("user") || lk.includes("handle") || lk.includes("twitter") || lk.includes("name") || lk.includes("creator")) {
      username = String(entry[k]);
      break;
    }
  }

  let mindshare = null;
  for (const k of keys) {
    const lk = k.toLowerCase();
    if (lk.includes("mindshare") || lk.includes("score") || lk.includes("ms") || lk.includes("value") || lk.includes("points")) {
      const v = Number(entry[k]);
      if (!Number.isNaN(v)) {
        mindshare = v;
        break;
      }
    }
  }

  let rank = null;
  for (const k of keys) {
    const lk = k.toLowerCase();
    if (lk.includes("rank") || lk.includes("position")) {
      const v = Number(entry[k]);
      if (!Number.isNaN(v)) {
        rank = v;
        break;
      }
    }
  }

  if (!Number.isFinite(rank)) {
    rank = (pageIdx - 1) * fallbackPageSize + (idxInPage + 1);
  }

  if (typeof username === "string") {
    username = username.trim().replace(/^@/, "");
  } else {
    for (const v of Object.values(entry)) {
      if (typeof v === "string" && v.startsWith("@")) {
        username = v.replace(/^@/, "");
        break;
      }
    }
  }

  return {
    rank: Number(rank),
    username: username || null,
    mindshare: Number.isFinite(mindshare) ? mindshare : null,
    raw: entry
  };
}

// Fetch all pages for a timeframe.
async function fetchAllPagesForTimeframe(timeframeKey, maxPages = 20, pageSizeHint = 100) {
  const cacheKey = `tf:${timeframeKey}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const results = [];
  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = `${BASE}?timeframe=${encodeURIComponent(timeframeKey)}&sortBy=mindshare&page=${page}`;
      const json = await fetchJson(url);
      const arr = getArrayFromResponse(json);
      if (!arr || arr.length === 0) break;
      for (let i = 0; i < arr.length; i++) {
        const normalized = normalize(arr[i], page, i, pageSizeHint);
        if (normalized && normalized.username) results.push(normalized);
      }
    } catch (err) {
      // log in serverless environment to Vercel logs
      console.warn("fetch page error", err.message);
      break;
    }
  }

  cacheSet(cacheKey, results);
  return results;
}

// Vercel serverless handler
export default async function handler(req, res) {
  try {
    const raw = String((req.query && req.query.username) || "").trim();
    if (!raw) return res.status(400).json({ error: "missing username" });
    const username = raw.replace(/^@/, "").toLowerCase();

    const timeframePromises = TIMEFRAMES.map(async (tf) => {
      const entries = await fetchAllPagesForTimeframe(tf.key, 20, 100);
      return { key: tf.key, label: tf.label, entries };
    });

    const all = await Promise.all(timeframePromises);
    const output = { username, results: {} };

    for (const bucket of all) {
      const entries = bucket.entries || [];
      const you = entries.find(e => e.username && e.username.toLowerCase() === username);

      let rank100 = entries.find(e => Number(e.rank) === 100);
      if (!rank100) {
        const withMs = entries.filter(e => Number.isFinite(e.mindshare));
        if (withMs.length >= 100) {
          withMs.sort((a,b) => b.mindshare - a.mindshare);
          rank100 = withMs[99];
        } else {
          const sortedByRank = entries.slice().sort((a,b) => a.rank - b.rank);
          if (sortedByRank.length >= 100) rank100 = sortedByRank[99];
        }
      }

      const obj = {
        totalFetched: entries.length,
        rank100_mindshare: rank100 ? rank100.mindshare : null
      };

      if (!you) {
        obj.found = false;
      } else {
        obj.found = true;
        obj.rank = you.rank;
        obj.mindshare = you.mindshare;
        obj.needed_mindshare = (rank100 && Number.isFinite(rank100.mindshare) && Number.isFinite(you.mindshare))
          ? Math.max(0, rank100.mindshare - you.mindshare)
          : null;
      }

      output.results[bucket.key] = obj;
    }

    return res.json(output);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}