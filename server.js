// vilmertv — DASH FAST channel server.
//
// Modules:
//   scheduler.js   — pure: epoch-anchored playlist → Period descriptors
//   sourceMpd.js   — fetch + parse one source MPD → ResolvedItem
//   cache.js       — refresh loop + failure tracking
//   mpd.js         — emit dynamic multi-period DASH XML
//
// This file:
//   - Express wiring + CORS
//   - HTTP keep-alive + retry-with-backoff (used by both ingestion and proxy)
//   - Segment proxy at /p/<base64url(upstreamBase)>/<path> so playback works
//     across origins without depending on upstream CORS
//   - Manifest cache + single-in-flight build (herd dedup)

import express from "express";
import nodeFetch from "node-fetch";
import http from "http";
import https from "https";
import { SourceCache } from "./cache.js";
import { windowPeriods } from "./scheduler.js";
import { buildMpd } from "./mpd.js";

// --- env ---
const PORT = Number(process.env.PORT || 8080);
const PLAYLIST_URL = process.env.PLAYLIST_URL;
const CHANNEL_EPOCH =
  process.env.CHANNEL_EPOCH || process.env.CHANNEL_START_TIME;
const MIN_UPDATE_PERIOD_SECONDS = Number(
  process.env.MIN_UPDATE_PERIOD_SECONDS || 4
);
const TIME_SHIFT_SECONDS = Number(process.env.TIME_SHIFT_SECONDS || 30);
const SUGGESTED_DELAY_SECONDS = Number(
  process.env.SUGGESTED_DELAY_SECONDS || 12
);
const LOOKAHEAD_SECONDS = Number(process.env.LOOKAHEAD_SECONDS || 30);
const PLAYLIST_REFRESH_SECONDS = Number(
  process.env.PLAYLIST_REFRESH_SECONDS || 300
);
const FAILURE_WEBHOOK_URL = process.env.FAILURE_WEBHOOK_URL || null;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || null;
const MANIFEST_CACHE_TTL_MS = Number(process.env.MANIFEST_CACHE_TTL_MS || 1500);
// PROXY_SEGMENTS=true  → BaseURL rewritten to /p/<token>/ (browsers / cross-origin embeds)
// PROXY_SEGMENTS=false → BaseURL points straight at upstream (native players, no CORS)
const PROXY_SEGMENTS = (process.env.PROXY_SEGMENTS ?? "true").toLowerCase() !== "false";

if (!PLAYLIST_URL) {
  console.error("FATAL: PLAYLIST_URL is required");
  process.exit(1);
}
if (!CHANNEL_EPOCH) {
  console.error(
    "FATAL: CHANNEL_EPOCH is required (ISO 8601 UTC, e.g. 2026-01-01T00:00:00Z)"
  );
  process.exit(1);
}
if (!Number.isFinite(new Date(CHANNEL_EPOCH).getTime())) {
  console.error(`FATAL: CHANNEL_EPOCH is not a valid ISO 8601 instant: ${CHANNEL_EPOCH}`);
  process.exit(1);
}

// --- HTTP client: keep-alive + retry ---
// Keep-alive is non-optional for the segment proxy: every TLS handshake adds
// ~100ms+ and visibly stalls Period transitions on Shaka.
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
});
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
});
const pickAgent = (url) => (url.startsWith("https:") ? httpsAgent : httpAgent);

async function fetchWithRetry(url, fetchOpts = {}, retryOpts = {}) {
  const {
    timeoutMs = 15_000,
    maxAttempts = 3,
    backoffMs = 400,
  } = retryOpts;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await nodeFetch(url, {
        redirect: "follow",
        agent: pickAgent(url),
        ...fetchOpts,
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (resp.status >= 500 && attempt < maxAttempts) {
        try {
          resp.body?.destroy?.();
        } catch {}
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
        continue;
      }
      return resp;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// --- cache ---
const cache = new SourceCache({
  playlistUrl: PLAYLIST_URL,
  refreshIntervalMs: PLAYLIST_REFRESH_SECONDS * 1000,
  failureWebhookUrl: FAILURE_WEBHOOK_URL,
  fetchImpl: fetchWithRetry,
});

// --- express ---
const app = express();
app.set("trust proxy", true);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, Range, Accept, Content-Type"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, ETag"
  );
  res.setHeader("Accept-Ranges", "bytes");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// UTCTiming source — clients use this to align their clocks to ours so they
// converge on the same Period at the same wall time.
app.get("/time", (_req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.status(200).send(new Date().toISOString());
});

app.get("/health/sources", (_req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(cache.health());
});

// --- segment proxy ---
// Tokens are base64url-encoded so they're URL-path-safe with no further
// encoding. We pass through Range/Content-Range/ETag for byte-range playback.
app.get("/p/:token/*", async (req, res) => {
  try {
    const upstreamBase = Buffer.from(req.params.token, "base64url").toString(
      "utf8"
    );
    if (!/^https?:\/\//i.test(upstreamBase)) {
      return res.status(400).send("Invalid upstream base");
    }
    if (!upstreamBase.endsWith("/")) {
      return res.status(400).send("Upstream base must end with /");
    }

    const suffix = req.params[0] || "";
    const upstreamUrl = upstreamBase + suffix;

    const headers = { "user-agent": "vilmertv/0.2", accept: "*/*" };
    if (req.headers.range) headers.range = req.headers.range;

    const upstreamResp = await fetchWithRetry(
      upstreamUrl,
      { method: "GET", headers },
      { timeoutMs: 20_000, maxAttempts: 3, backoffMs: 300 }
    );

    res.status(upstreamResp.status);
    for (const h of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "etag",
      "cache-control",
      "last-modified",
    ]) {
      const v = upstreamResp.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges, ETag"
    );
    res.setHeader("Accept-Ranges", "bytes");

    if (!upstreamResp.body) return res.end();
    upstreamResp.body.pipe(res);
  } catch (e) {
    console.error("[/p]", e);
    res.status(502).send(`Proxy error: ${e?.message || e}`);
  }
});

// --- manifest ---
function publicSchemeAndHost(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return { proto, host };
}

function utcTimingUrlFor(req) {
  if (PUBLIC_BASE_URL) return `${PUBLIC_BASE_URL.replace(/\/$/, "")}/time`;
  const { proto, host } = publicSchemeAndHost(req);
  return `${proto}://${host}/time`;
}

function proxyBaseUrlFn(proto, host) {
  return (upstreamBase) => {
    const token = Buffer.from(upstreamBase, "utf8").toString("base64url");
    return `${proto}://${host}/p/${token}/`;
  };
}

// Per-host cache + single-in-flight build to keep a herd of refreshing clients
// from each rebuilding the same MPD.
const manifestCache = new Map(); // key: `${proto}://${host}` -> { xml, at }
const manifestInflight = new Map(); // key -> Promise<xml>

async function getManifestXml(req) {
  const { proto, host } = publicSchemeAndHost(req);
  const key = `${proto}://${host}`;
  const now = Date.now();
  const cached = manifestCache.get(key);
  if (cached && now - cached.at < MANIFEST_CACHE_TTL_MS) return cached.xml;
  const inflight = manifestInflight.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    const items = cache.getActiveItems();
    if (items.length === 0) {
      const e = new Error(
        "Channel cache is empty (no resolved sources yet). Try again shortly."
      );
      e.status = 503;
      throw e;
    }
    const t = new Date();
    const periods = windowPeriods(CHANNEL_EPOCH, items, t, {
      lookbehindSec: TIME_SHIFT_SECONDS,
      lookaheadSec: LOOKAHEAD_SECONDS,
    });
    if (periods.length === 0) {
      const e = new Error("Channel has not started yet.");
      e.status = 503;
      throw e;
    }
    const xml = buildMpd({
      epoch: CHANNEL_EPOCH,
      periods,
      cache,
      settings: {
        minUpdatePeriodSec: MIN_UPDATE_PERIOD_SECONDS,
        timeShiftSec: TIME_SHIFT_SECONDS,
        suggestedDelaySec: SUGGESTED_DELAY_SECONDS,
      },
      utcTimingUrl: utcTimingUrlFor(req),
      transformBaseUrl: PROXY_SEGMENTS ? proxyBaseUrlFn(proto, host) : undefined,
      now: t,
    });
    manifestCache.set(key, { xml, at: Date.now() });
    return xml;
  })().finally(() => {
    manifestInflight.delete(key);
  });
  manifestInflight.set(key, promise);
  return promise;
}

app.get("/channel.mpd", async (req, res) => {
  try {
    const xml = await getManifestXml(req);
    res.setHeader("Content-Type", "application/dash+xml; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.status(200).send(xml);
  } catch (e) {
    if (e?.status === 503) {
      res.setHeader("Retry-After", "5");
      return res.status(503).send(e.message);
    }
    console.error("[/channel.mpd]", e);
    res.status(500).send(`Error generating MPD: ${e?.message || e}`);
  }
});

// --- boot ---
await cache.start();

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`vilmertv listening on 0.0.0.0:${PORT}`);
  console.log(`PLAYLIST_URL=${PLAYLIST_URL}`);
  console.log(`CHANNEL_EPOCH=${CHANNEL_EPOCH}`);
  console.log(
    `refresh=${PLAYLIST_REFRESH_SECONDS}s lookahead=${LOOKAHEAD_SECONDS}s ` +
      `timeshift=${TIME_SHIFT_SECONDS}s minUpdate=${MIN_UPDATE_PERIOD_SECONDS}s ` +
      `proxySegments=${PROXY_SEGMENTS}`
  );
});

function shutdown(sig) {
  console.log(`[${sig}] shutting down`);
  cache.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
