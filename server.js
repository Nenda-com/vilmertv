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

// How many upcoming VODs to expose as Periods in the MPD at any time
const WINDOW_ITEMS = Number(process.env.WINDOW_ITEMS || 5);

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

// Cache parsed upstream MPDs so /channel.mpd doesn't refetch every request.
const MPD_CACHE_TTL_MS = 60_000;
const mpdCache = new Map(); // mpdUrl -> { parsed, fetchedAt }

async function fetchMpdParsed(mpdUrl) {
  const now = Date.now();
  const cached = mpdCache.get(mpdUrl);
  if (cached && now - cached.fetchedAt < MPD_CACHE_TTL_MS) return cached.parsed;
  const resp = await fetch(mpdUrl);
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

function upstreamDurationSeconds(parsed) {
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

    const upstreamResp = await fetch(upstreamUrl, {
      method: "GET",
      headers,
      redirect: "follow",
    });

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
    const futureItemsLimit = Math.max(1, WINDOW_ITEMS);

    let iteration = Math.floor(windowStartAbs / loopDurationSec);
    let absStart = iteration * loopDurationSec;
    let futureItemsCount = 0;

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

        if (absStart >= nowSec) {
          if (futureItemsCount >= futureItemsLimit) break walk;
          futureItemsCount++;
        }

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

    const periods = [];
    for (const spec of specs) {
      const itemMpd = mpdByUrl.get(spec.mpdUrl);
      const itemAdaptationSets = adaptationSetsFromParsed(itemMpd);
      if (!itemAdaptationSets) continue;

      const upstreamBase = baseUrlFromMpdUrl(spec.mpdUrl);
      const token = Buffer.from(upstreamBase, "utf8").toString("base64url");
      const proxiedBase = `https://${req.get("host")}/p/${token}/`;

      periods.push({
        "@_id": spec.id,
        "@_start": `PT${spec.absStart}S`,
        "@_duration": `PT${spec.dur}S`,
        BaseURL: proxiedBase,
        AdaptationSet: deepClone(itemAdaptationSets),
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
  console.log(`WINDOW_ITEMS=${WINDOW_ITEMS}`);
  console.log(`DEFAULT_ITEM_DURATION_SECONDS=${DEFAULT_ITEM_DURATION_SECONDS}`);
  console.log(`CHANNEL_START_TIME=${CHANNEL_START_TIME}`);
  console.log(`DVR_WINDOW_SECONDS=${DVR_WINDOW_SECONDS}`);
  console.log(`SUGGESTED_DELAY_SECONDS=${SUGGESTED_DELAY_SECONDS}`);
});
