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
const CHANNEL_START_TIME = process.env.CHANNEL_START_TIME; // ISO8601 UTC, required
const DVR_WINDOW_SECONDS = Number(process.env.DVR_WINDOW_SECONDS || 3600);
const SUGGESTED_DELAY_SECONDS = Number(process.env.SUGGESTED_DELAY_SECONDS || 20);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  // Keep explicit boolean attribute values (DASH MPD must be valid XML)
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
  // support a couple of common shapes
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

// Derive BaseURL from an MPD URL by trimming to the directory
function baseUrlFromMpdUrl(mpdUrl) {
  const u = new URL(mpdUrl);
  u.hash = "";
  u.search = "";
  u.pathname = u.pathname.replace(/[^/]*$/, "");
  return u.toString();
}
/**
 * Sanitize boolean-ish DASH attributes so the produced XML is valid.
 * Converts valueless boolean attributes into explicit ="true".
 */
function sanitizeDashXmlBooleans(node) {
  if (!node || typeof node !== "object") return;

  const booleanAttrs = new Set([
    "segmentAlignment",
    "subsegmentAlignment",
    "bitstreamSwitching",
  ]);

  for (const k of Object.keys(node)) {
    const v = node[k];

    // Bare key -> attribute with value
    if (booleanAttrs.has(k) && (v === "" || v === true || v === null)) {
      node[`@_${k}`] = "true";
      delete node[k];
      continue;
    }

    // Attribute key but valueless -> set value
    if (k.startsWith("@_") && (v === "" || v === true || v === null)) {
      node[k] = "true";
      continue;
    }

    if (typeof v === "object") sanitizeDashXmlBooleans(v);
  }
}

// --- Path-based proxy (DASH-player compatible) ---

function b64urlEncode(str) {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64").toString("utf8");
}

/**
 * GET /p/:b64/<path>
 * - :b64 is base64url(upstreamBaseUrl) (must end with "/")
 * - <path> is appended by DASH client (e.g. video_x/init.cmfv)
 *
 * Supports Range requests and follows redirects.
 */
app.get("/p/:b64/*", async (req, res) => {
  try {
    const upstreamBase = b64urlDecode(req.params.b64);

    if (!/^https?:\/\//i.test(upstreamBase)) {
      return res.status(400).send("Invalid upstream base");
    }
    if (!upstreamBase.endsWith("/")) {
      return res.status(400).send("Upstream base must end with /");
    }

    const suffix = req.params[0] || "";
    const upstreamUrl = upstreamBase + suffix;

    const headers = {
      "user-agent": "osc-vod2live-proxy/2.0",
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

    // 2) Determine schedule rotation point (loop forever)
    const durationsSec = items.map(getItemDurationSeconds);
    const totalMs = durationsSec.reduce((a, b) => a + b, 0) * 1000;
    const now = Date.now();
    const offsetMs = totalMs > 0 ? now % totalMs : 0;

    let acc = 0;
    let startIdx = 0;
    for (let i = 0; i < durationsSec.length; i++) {
      const dMs = durationsSec[i] * 1000;
      if (acc + dMs > offsetMs) {
        startIdx = i;
        break;
      }
      acc += dMs;
    }

    // 3) Fetch a template MPD (we reuse its AdaptationSets/Representations)
    const templateUrl = getItemUrl(items[startIdx]) || getItemUrl(items[0]);
    if (!templateUrl) {
      return res.status(400).send("Playlist item missing MPD url (asset.url)");
    }

    const templateText = await (await fetch(templateUrl)).text();
    const parsed = xmlParser.parse(templateText);

    // MPD root may be parsed as { MPD: {...} }
    const templateMpd = parsed?.MPD ? parsed : { MPD: parsed };

    // Find AdaptationSet structure from the template
    const templatePeriod = Array.isArray(templateMpd.MPD?.Period)
      ? templateMpd.MPD.Period[0]
      : templateMpd.MPD?.Period;

    let adaptationSets = templatePeriod?.AdaptationSet;
    if (!adaptationSets) {
      return res.status(500).send("Template MPD missing Period/AdaptationSet");
    }

    // Normalize AdaptationSet to array
    if (!Array.isArray(adaptationSets)) adaptationSets = [adaptationSets];

    // 4) Build stitched MPD
    const outMpd = deepClone(templateMpd);

    // Live-like MPD (real wall clock)
    outMpd.MPD["@_type"] = "dynamic";
    outMpd.MPD["@_availabilityStartTime"] = CHANNEL_START_TIME;
    outMpd.MPD["@_minimumUpdatePeriod"] = "PT5S";
    outMpd.MPD["@_timeShiftBufferDepth"] = `PT${DVR_WINDOW_SECONDS}S`;
    outMpd.MPD["@_suggestedPresentationDelay"] = `PT${SUGGESTED_DELAY_SECONDS}S`;

    // Remove static duration if present
    delete outMpd.MPD["@_mediaPresentationDuration"];

    // Build rolling window of Periods
    const periods = [];
    let periodStart = 0;

    const count = Math.min(WINDOW_ITEMS, items.length);
    for (let k = 0; k < count; k++) {
      const idx = (startIdx + k) % items.length;
      const it = items[idx];
      const mpdUrl = getItemUrl(it);
      if (!mpdUrl) continue;

      const dur = getItemDurationSeconds(it);

      const upstreamBase = baseUrlFromMpdUrl(mpdUrl);
      const b64 = b64urlEncode(upstreamBase);

      // IMPORTANT: always https (req.protocol may be http behind ingress)
const proxiedBase = `https://${req.get("host")}/p/${b64}/`;
      periods.push({
        "@_id": getItemId(it, idx),
        "@_start": `PT${periodStart}S`,
        "@_duration": `PT${dur}S`,
        BaseURL: proxiedBase,
        AdaptationSet: adaptationSets,
      });

      periodStart += dur;
    }

    // Replace Period completely with our stitched periods
    outMpd.MPD.Period = periods;

    // Ensure output XML is valid
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
