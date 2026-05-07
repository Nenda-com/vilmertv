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
// CHANNEL_START_TIME is required: a fixed ISO8601 UTC anchor for the channel's
// presentation timeline. Pin it once and never change it — it's the AST.
const CHANNEL_START_TIME = process.env.CHANNEL_START_TIME;
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

    const durationsSec = items.map(getItemDurationSeconds);
    const loopDurationSec = durationsSec.reduce((a, b) => a + b, 0);
    if (loopDurationSec <= 0) {
      return res.status(400).send("Playlist has zero total duration");
    }

    const nowSec = (Date.now() - channelStartMs) / 1000;
    if (nowSec < 0) {
      return res.status(425).send("Channel has not started yet");
    }

    // 2) Locate the item that contains "now" inside the current loop pass.
    //    We use this item's MPD as the template (all VODs share the same shape).
    const currentLoopOffsetSec = nowSec % loopDurationSec;
    let currentItemIdx = 0;
    {
      let acc = 0;
      for (let i = 0; i < items.length; i++) {
        if (acc + durationsSec[i] > currentLoopOffsetSec) {
          currentItemIdx = i;
          break;
        }
        acc += durationsSec[i];
      }
    }

    // 3) Fetch a template MPD (we reuse its AdaptationSets/Representations)
    const templateUrl =
      getItemUrl(items[currentItemIdx]) || getItemUrl(items[0]);
    if (!templateUrl) {
      return res.status(400).send("Playlist item missing MPD url (asset.url)");
    }

    const templateText = await (await fetch(templateUrl)).text();
    const parsed = xmlParser.parse(templateText);

    const templateMpd = parsed?.MPD ? parsed : { MPD: parsed };

    const templatePeriod = Array.isArray(templateMpd.MPD?.Period)
      ? templateMpd.MPD.Period[0]
      : templateMpd.MPD?.Period;

    let adaptationSets = templatePeriod?.AdaptationSet;
    if (!adaptationSets) {
      return res.status(500).send("Template MPD missing Period/AdaptationSet");
    }
    if (!Array.isArray(adaptationSets)) adaptationSets = [adaptationSets];

    // 4) Build stitched MPD with a stable AST anchored at CHANNEL_START_TIME.
    //    Periods carry absolute @start offsets from AST and slide forward as
    //    wall-clock advances, so the player's monotonic presentation clock
    //    always falls inside a published Period.
    const outMpd = deepClone(templateMpd);

    outMpd.MPD["@_type"] = "dynamic";
    outMpd.MPD["@_availabilityStartTime"] = new Date(
      channelStartMs
    ).toISOString();
    outMpd.MPD["@_minimumUpdatePeriod"] = "PT5S";
    outMpd.MPD["@_timeShiftBufferDepth"] = `PT${DVR_WINDOW_SECONDS}S`;
    outMpd.MPD["@_suggestedPresentationDelay"] = `PT${SUGGESTED_DELAY_SECONDS}S`;

    delete outMpd.MPD["@_mediaPresentationDuration"];

    const windowStartAbs = Math.max(0, nowSec - DVR_WINDOW_SECONDS);
    const futureItemsLimit = Math.max(1, WINDOW_ITEMS);

    // Skip directly to the loop iteration containing windowStartAbs.
    let iteration = Math.floor(windowStartAbs / loopDurationSec);
    let absStart = iteration * loopDurationSec;
    let futureItemsCount = 0;

    const periods = [];
    const MAX_PASSES = 10000; // safety cap

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
          const upstreamBase = baseUrlFromMpdUrl(mpdUrl);
          const token = Buffer.from(upstreamBase, "utf8").toString("base64url");
          const proxiedBase = `https://${req.get("host")}/p/${token}/`;

          periods.push({
            "@_id": `${getItemId(it, i)}-${iteration}`,
            "@_start": `PT${absStart}S`,
            "@_duration": `PT${dur}S`,
            BaseURL: proxiedBase,
            AdaptationSet: adaptationSets,
          });
        }

        absStart = absEnd;
      }
      iteration++;
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
