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

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});
const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
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
    "Content-Length, Content-Range, Accept-Ranges"
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
  try {
    const u = new URL(mpdUrl);
    u.hash = "";
    u.search = "";
    u.pathname = u.pathname.replace(/[^/]*$/, "");
    return u.toString();
  } catch {
    return mpdUrl.replace(/\/[^/]*$/, "/");
  }
}

/**
 * Ensure a valueless/boolean-ish key becomes a proper XML attribute with a value.
 * Example:
 *   segmentAlignment            -> @_segmentAlignment="true"
 *   @_segmentAlignment=""|true  -> @_segmentAlignment="true"
 */
function forceXmlAttrTrue(obj, key) {
  if (!obj || typeof obj !== "object") return;

  // If it exists as a bare key (segmentAlignment) -> move to attribute form
  if (obj[key] === "" || obj[key] === true || obj[key] === null) {
    obj[`@_${key}`] = "true";
    delete obj[key];
  }

  // If it exists as an attribute but is valueless -> set value
  const attrKey = `@_${key}`;
  if (obj[attrKey] === "" || obj[attrKey] === true || obj[attrKey] === null) {
    obj[attrKey] = "true";
  }

  for (const v of Object.values(obj)) {
    if (typeof v === "object") forceXmlAttrTrue(v, key);
  }
}

app.get("/channel.mpd", async (_req, res) => {
  try {
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

    // Fix invalid XML boolean attrs like segmentAlignment (must have a value in XML)
    for (const as of adaptationSets) {
      forceXmlAttrTrue(as, "segmentAlignment");
      forceXmlAttrTrue(as, "subsegmentAlignment");
      forceXmlAttrTrue(as, "bitstreamSwitching");
    }

    // 4) Build stitched MPD
    const outMpd = deepClone(templateMpd);

    // Make it live-like
    outMpd.MPD["@_type"] = "dynamic";
    outMpd.MPD["@_minimumUpdatePeriod"] =
      outMpd.MPD["@_minimumUpdatePeriod"] || "PT5S";
    outMpd.MPD["@_timeShiftBufferDepth"] =
      outMpd.MPD["@_timeShiftBufferDepth"] || "PT3600S";
    outMpd.MPD["@_suggestedPresentationDelay"] =
      outMpd.MPD["@_suggestedPresentationDelay"] || "PT20S";

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

      periods.push({
        "@_id": getItemId(it, idx),
        "@_start": `PT${periodStart}S`,
        "@_duration": `PT${dur}S`,
        BaseURL: baseUrlFromMpdUrl(mpdUrl),
        AdaptationSet: adaptationSets,
      });

      periodStart += dur;
    }

    // IMPORTANT: replace Period completely with our stitched periods
    outMpd.MPD.Period = periods;

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
});
