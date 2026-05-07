import express from "express";
import fetch from "node-fetch";
import { XMLParser, XMLBuilder } from "fast-xml-parser";

const app = express();
const PORT = process.env.PORT || 8080;

// Playlist JSON URL (set via OSC parameter store)
const PLAYLIST_URL =
  process.env.PLAYLIST_URL || "https://static.nenda.com/misc/vilmer_tv.json";

// Fallback if an item does not include durationSeconds
const DEFAULT_ITEM_DURATION_SECONDS = Number(
  process.env.DEFAULT_ITEM_DURATION_SECONDS || 1800
);

// How many seconds of future content to expose as Periods in the MPD at any
// time. Item count is a bad cap because a single 5h VOD blows the lookahead
// way past wall-clock, letting the player jump to a future live edge that
// doesn't exist yet.
const LOOKAHEAD_SECONDS = Number(process.env.LOOKAHEAD_SECONDS || 120);

// Live tune-in config
// CHANNEL_START_TIME is the fixed AST anchor for the channel's presentation
// timeline. Pin it once and never change it — changing it resets the timeline.
const CHANNEL_START_TIME =
  process.env.CHANNEL_START_TIME || "2026-05-07T10:00:00+02:00";
const DVR_WINDOW_SECONDS = Number(process.env.DVR_WINDOW_SECONDS || 3600);
const SUGGESTED_DELAY_SECONDS = Number(
  process.env.SUGGESTED_DELAY_SECONDS || 30
);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressBooleanAttributes: false,
});

// --- CORS + Range support (needed for Shaka / browser playback) ---
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

// Basic request logging
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function pickItems(playlistJson) {
  if (Array.isArray(playlistJson?.items)) return playlistJson.items;
  if (Array.isArray(playlistJson?.programs)) return playlistJson.programs;
  if (Array.isArray(playlistJson)) return playlistJson;
  return [];
}

function getItemUrl(item) {
  return item?.asset?.url || item?.url || item?.mpdUrl;
}

function getItemId(item, idx) {
  return item?.id || item?.assetId || `vod-${idx}`;
}

function getItemDurationSeconds(item) {
  const d = Number(item?.durationSeconds);
  return Number.isFinite(d) && d > 0 ? d : DEFAULT_ITEM_DURATION_SECONDS;
}

function baseUrlFromMpdUrl(mpdUrl) {
  const u = new URL(mpdUrl);
  u.hash = "";
  u.search = "";
  u.pathname = u.pathname.replace(/[^/]*$/, "");
  return u.toString();
}

// Fetch with per-attempt timeout + retry on 5xx / network errors. A slow or
// briefly-unavailable upstream shouldn't take down a request — Shaka's retry
// budget is limited and a single failed fetch can stall playback.
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
      const resp = await fetch(url, {
        redirect: "follow",
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

// Cache parsed upstream MPDs so /channel.mpd doesn't refetch every request.
const MPD_CACHE_TTL_MS = 60_000;
const mpdCache = new Map(); // mpdUrl -> { parsed, fetchedAt }

async function fetchMpdParsed(mpdUrl) {
  const now = Date.now();
  const cached = mpdCache.get(mpdUrl);
  if (cached && now - cached.fetchedAt < MPD_CACHE_TTL_MS) return cached.parsed;
  const resp = await fetchWithRetry(mpdUrl, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`Failed to fetch upstream MPD ${mpdUrl}: ${resp.status}`);
  }
  const text = await resp.text();
  const parsedRaw = xmlParser.parse(text);
  const parsed = parsedRaw?.MPD ? parsedRaw : { MPD: parsedRaw };
  mpdCache.set(mpdUrl, { parsed, fetchedAt: now });
  return parsed;
}

function isImageAdaptationSet(as) {
  const ct = as?.["@_contentType"];
  const mt = as?.["@_mimeType"];
  return ct === "image" || (typeof mt === "string" && mt.startsWith("image/"));
}

function adaptationSetsFromParsed(parsed) {
  const period = Array.isArray(parsed.MPD?.Period)
    ? parsed.MPD.Period[0]
    : parsed.MPD?.Period;
  let as = period?.AdaptationSet;
  if (!as) return null;
  if (!Array.isArray(as)) as = [as];
  // Drop thumbnail/image tracks — upstream 404s on them and Shaka complains.
  as = as.filter((a) => !isImageAdaptationSet(a));
  return as.length ? as : null;
}

function parseIso8601DurationToSeconds(s) {
  if (!s) return null;
  const m = /^PT(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/.exec(s);
  if (!m) return null;
  const h = parseFloat(m[1] || 0);
  const min = parseFloat(m[2] || 0);
  const sec = parseFloat(m[3] || 0);
  const total = h * 3600 + min * 60 + sec;
  return Number.isFinite(total) && total > 0 ? total : null;
}

function adaptationSetTotalSeconds(as) {
  const st = as?.SegmentTemplate;
  if (!st) return null;
  const ts = parseInt(st["@_timescale"] || "1", 10);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const tl = st.SegmentTimeline;
  if (!tl) return null;
  let sList = tl.S;
  if (!sList) return null;
  if (!Array.isArray(sList)) sList = [sList];
  let totalTicks = 0;
  for (const s of sList) {
    const d = parseInt(s?.["@_d"], 10);
    const r = parseInt(s?.["@_r"] || "0", 10);
    if (Number.isFinite(d) && d > 0) {
      totalTicks += d * (Number.isFinite(r) ? r + 1 : 1);
    }
  }
  return totalTicks > 0 ? totalTicks / ts : null;
}

// Use the MINIMUM of all AdaptationSet timeline lengths in the upstream MPD.
// mediaPresentationDuration is typically the MAX (longest track), which leaves
// shorter tracks under-covered at the period boundary — Safari MSE silently
// stalls when audio outruns video by even a few milliseconds.
function upstreamDurationSeconds(parsed) {
  const adaptationSets = adaptationSetsFromParsed(parsed);
  if (adaptationSets) {
    let minDur = Infinity;
    for (const as of adaptationSets) {
      const d = adaptationSetTotalSeconds(as);
      if (d && d < minDur) minDur = d;
    }
    if (Number.isFinite(minDur) && minDur > 0) return minDur;
  }
  // Fallbacks (less accurate, in this order):
  const fromMpd = parseIso8601DurationToSeconds(
    parsed.MPD?.["@_mediaPresentationDuration"]
  );
  if (fromMpd) return fromMpd;
  const period = Array.isArray(parsed.MPD?.Period)
    ? parsed.MPD.Period[0]
    : parsed.MPD?.Period;
  return parseIso8601DurationToSeconds(period?.["@_duration"]);
}

function sanitizeDashXmlBooleans(node) {
  if (!node || typeof node !== "object") return;

  const booleanAttrs = new Set([
    "segmentAlignment",
    "subsegmentAlignment",
    "bitstreamSwitching",
  ]);

  for (const k of Object.keys(node)) {
    const v = node[k];

    if (booleanAttrs.has(k) && (v === "" || v === true || v === null)) {
      node[`@_${k}`] = "true";
      delete node[k];
      continue;
    }

    if (k.startsWith("@_") && (v === "" || v === true || v === null)) {
      node[k] = "true";
      continue;
    }

    if (typeof v === "object") sanitizeDashXmlBooleans(v);
  }
}
/**
 * GET /p/:token/<path>
 *
 * :token is base64url(upstreamBaseUrl) — URL-path-safe alphabet, no encoding needed.
 * <path> is appended by the DASH client (e.g. video_x/init.cmfv)
 */
app.get("/p/:token/*", async (req, res) => {
  try {
    const token = req.params.token; // base64url string (no / + =)
    const upstreamBase = Buffer.from(token, "base64url").toString("utf8");

    if (!/^https?:\/\//i.test(upstreamBase)) {
      return res.status(400).send("Invalid upstream base");
    }
    if (!upstreamBase.endsWith("/")) {
      return res.status(400).send("Upstream base must end with /");
    }

    const suffix = req.params[0] || "";
    const upstreamUrl = upstreamBase + suffix;

    const headers = {
      "user-agent": "osc-vod2live-proxy/3.0",
      accept: "*/*",
    };
    if (req.headers.range) headers["range"] = req.headers.range;

    const upstreamResp = await fetchWithRetry(
      upstreamUrl,
      { method: "GET", headers },
      // Segment fetches: a bit more aggressive than MPDs since Shaka retries
      // are themselves expensive (manifest reparse, buffer reset).
      { timeoutMs: 20_000, maxAttempts: 3, backoffMs: 300 }
    );

    res.status(upstreamResp.status);

    const passthrough = [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "etag",
      "cache-control",
      "last-modified",
    ];
    for (const h of passthrough) {
      const v = upstreamResp.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    // Ensure CORS + expose range headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges, ETag"
    );
    res.setHeader("Accept-Ranges", "bytes");

    if (!upstreamResp.body) return res.end();
    upstreamResp.body.pipe(res);
  } catch (e) {
    console.error(e);
    res.status(502).send(`Proxy error: ${e?.message || e}`);
  }
});
app.get("/channel.mpd", async (req, res) => {
  try {
    if (!CHANNEL_START_TIME) {
      return res.status(500).send("Missing env CHANNEL_START_TIME");
    }
    const channelStartMs = Date.parse(CHANNEL_START_TIME);
    if (Number.isNaN(channelStartMs)) {
      return res
        .status(500)
        .send("Invalid env CHANNEL_START_TIME (must be ISO8601)");
    }

    // 1) Load playlist
    const playlistResp = await fetch(PLAYLIST_URL, { redirect: "follow" });
    if (!playlistResp.ok) {
      return res
        .status(502)
        .send(`Failed to fetch playlist: ${playlistResp.status}`);
    }
    const playlistJson = await playlistResp.json();
    const items = pickItems(playlistJson);

    if (!items.length) return res.status(400).send("Playlist has no items");

    // 2) Fetch every item's upstream MPD in parallel (60s cache) so we can
    //    use each VOD's true media duration — playlist durationSeconds is
    //    integer-rounded and causes sub-frame gaps at period boundaries.
    const allItemUrls = items.map(getItemUrl);
    const fetched = await Promise.all(
      allItemUrls.map(async (u) => (u ? [u, await fetchMpdParsed(u)] : null))
    );
    const mpdByUrl = new Map(fetched.filter(Boolean));

    // Real per-item durations (fall back to playlist durationSeconds).
    const durationsSec = items.map((it) => {
      const u = getItemUrl(it);
      const parsed = u ? mpdByUrl.get(u) : null;
      const real = parsed ? upstreamDurationSeconds(parsed) : null;
      return real && real > 0 ? real : getItemDurationSeconds(it);
    });
    const loopDurationSec = durationsSec.reduce((a, b) => a + b, 0);
    if (loopDurationSec <= 0) {
      return res.status(400).send("Playlist has zero total duration");
    }

    const nowSec = (Date.now() - channelStartMs) / 1000;
    if (nowSec < 0) {
      return res.status(425).send("Channel has not started yet");
    }

    // 3) Walk the loop and collect period specs overlapping the DVR window
    //    plus up to WINDOW_ITEMS upcoming items.
    const windowStartAbs = Math.max(0, nowSec - DVR_WINDOW_SECONDS);
    // Stop emitting once the next period would START past now + lookahead.
    // We always emit at least one period whose @start >= nowSec so the player
    // has something to chain into, even if a single item is longer than the
    // lookahead window.
    const lookaheadEndAbs = nowSec + LOOKAHEAD_SECONDS;

    let iteration = Math.floor(windowStartAbs / loopDurationSec);
    let absStart = iteration * loopDurationSec;
    let emittedFuturePeriod = false;

    const specs = []; // { id, absStart, dur, mpdUrl }
    const MAX_PASSES = 10000;

    walk: for (let pass = 0; pass < MAX_PASSES; pass++) {
      for (let i = 0; i < items.length; i++) {
        const dur = durationsSec[i];
        const absEnd = absStart + dur;

        if (absEnd <= windowStartAbs) {
          absStart = absEnd;
          continue;
        }

        if (absStart >= lookaheadEndAbs && emittedFuturePeriod) break walk;
        if (absStart >= nowSec) emittedFuturePeriod = true;

        const it = items[i];
        const mpdUrl = getItemUrl(it);
        if (mpdUrl) {
          specs.push({
            id: `${getItemId(it, i)}-${iteration}`,
            absStart,
            dur,
            mpdUrl,
          });
        }
        absStart = absEnd;
      }
      iteration++;
    }

    if (!specs.length) {
      return res.status(500).send("No periods to publish");
    }

    // 4) Build stitched MPD with stable AST anchored at CHANNEL_START_TIME.
    //    Use the first item's parsed MPD as the shell (gives us root attrs).
    const outMpd = deepClone(mpdByUrl.get(specs[0].mpdUrl));

    outMpd.MPD["@_type"] = "dynamic";
    outMpd.MPD["@_availabilityStartTime"] = new Date(
      channelStartMs
    ).toISOString();
    outMpd.MPD["@_minimumUpdatePeriod"] = "PT5S";
    outMpd.MPD["@_timeShiftBufferDepth"] = `PT${DVR_WINDOW_SECONDS}S`;
    outMpd.MPD["@_suggestedPresentationDelay"] = `PT${SUGGESTED_DELAY_SECONDS}S`;

    delete outMpd.MPD["@_mediaPresentationDuration"];

    // Assign a stable AdaptationSet @id per canonical rendition (contentType +
    // mimeType + resolution + lang + trick-play flag) and tag each set with
    // urn:mpeg:dash:period-continuity:2015 so Shaka can chain the same logical
    // rendition across periods. Without this, two periods both labelling their
    // 720p set as id="1" while another period labels id="1" as 540p breaks the
    // boundary transition.
    const stableAsIds = new Map();
    let nextStableId = 1;
    const getStableAsId = (as) => {
      const key = [
        as["@_contentType"] || "",
        as["@_mimeType"] || "",
        `${as["@_maxWidth"] || ""}x${as["@_maxHeight"] || ""}`,
        as["@_lang"] || "",
        as["@_codingDependency"] === "false" ? "trick" : "main",
      ].join("|");
      let id = stableAsIds.get(key);
      if (id === undefined) {
        id = nextStableId++;
        stableAsIds.set(key, id);
      }
      return id;
    };
    const periods = [];
    for (const spec of specs) {
      const itemMpd = mpdByUrl.get(spec.mpdUrl);
      const itemAdaptationSets = adaptationSetsFromParsed(itemMpd);
      if (!itemAdaptationSets) continue;

      const upstreamBase = baseUrlFromMpdUrl(spec.mpdUrl);
      const token = Buffer.from(upstreamBase, "utf8").toString("base64url");
      const proxiedBase = `https://${req.get("host")}/p/${token}/`;

      // Stable AS @id by canonical content lets Shaka match the same logical
      // rendition across periods. Default multi-period transitions (no
      // continuity/connectivity hint) reset the SourceBuffer and timestampOffset
      // per period — which is what we need for VODs from different encoder
      // sessions with slightly different SPS/PPS.
      const adaptationSetsForPeriod = itemAdaptationSets.map((as) => {
        const cloned = deepClone(as);
        const stableId = getStableAsId(cloned);
        cloned["@_id"] = String(stableId);
        return cloned;
      });

      periods.push({
        "@_id": spec.id,
        "@_start": `PT${spec.absStart}S`,
        "@_duration": `PT${spec.dur}S`,
        BaseURL: proxiedBase,
        AdaptationSet: adaptationSetsForPeriod,
      });
    }

    outMpd.MPD.Period = periods;

    sanitizeDashXmlBooleans(outMpd);

    const xml = xmlBuilder.build(outMpd);

    res.set("Content-Type", "application/dash+xml; charset=utf-8");
    res.status(200).send(xml);
  } catch (e) {
    console.error(e);
    res.status(500).send(`Error generating MPD: ${e?.message || e}`);
  }
});
app.listen(PORT, "0.0.0.0", () => {
  console.log(`vilmertv listening on 0.0.0.0:${PORT}`);
  console.log(`PLAYLIST_URL=${PLAYLIST_URL}`);
  console.log(`LOOKAHEAD_SECONDS=${LOOKAHEAD_SECONDS}`);
  console.log(`DEFAULT_ITEM_DURATION_SECONDS=${DEFAULT_ITEM_DURATION_SECONDS}`);
  console.log(`CHANNEL_START_TIME=${CHANNEL_START_TIME}`);
  console.log(`DVR_WINDOW_SECONDS=${DVR_WINDOW_SECONDS}`);
  console.log(`SUGGESTED_DELAY_SECONDS=${SUGGESTED_DELAY_SECONDS}`);
});
