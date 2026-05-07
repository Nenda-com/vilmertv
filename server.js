import express from "express";
import fetch from "node-fetch";
import { XMLParser, XMLBuilder } from "fast-xml-parser";

const app = express();
const PORT = process.env.PORT || 8080;

// Your playlist JSON (the one you host)
const PLAYLIST_URL = process.env.PLAYLIST_URL || "https://static.nenda.com/misc/vilmer_tv.json";

// How long each VOD “plays” in the channel timeline.
// If you can’t reliably read durations from MPDs, we need this in the playlist.
// For now: require durationSeconds per item (recommended).
const DEFAULT_ITEM_DURATION_SECONDS = Number(process.env.DEFAULT_ITEM_DURATION_SECONDS || 1800);

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
const xmlBuilder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@_", format: true });

app.get("/healthz", (_, res) => res.status(200).send("ok"));

app.get("/channel.mpd", async (req, res) => {
  try {
    const playlist = await (await fetch(PLAYLIST_URL)).json();
    const items = playlist.items || playlist.programs || [];
    if (!items.length) return res.status(400).send("Playlist has no items");

    // Looping “channel”: compute a rotating window based on wall-clock time.
    // We build an MPD with multiple Periods, one per VOD, and rotate which one is “first”.
    const now = Date.now();

    // Fetch and parse the *first* item MPD to use as template (AdaptationSets/Representations)
    const firstUrl = items[0]?.asset?.url || items[0]?.url;
    if (!firstUrl) return res.status(400).send("First item missing asset.url");

    const firstMpdText = await (await fetch(firstUrl)).text();
    const firstMpd = xmlParser.parse(firstMpdText);

    // Build a simple dynamic MPD with Periods pointing at each VOD MPD BaseURL.
    // Note: This is a pragmatic stitcher; it assumes uniform encoding/segmenting (your Encore profile).
    const mpd = firstMpd.MPD ? structuredClone(firstMpd) : { MPD: firstMpd };

    // Force dynamic (live-like)
    mpd.MPD["@_type"] = "dynamic";
    mpd.MPD["@_minimumUpdatePeriod"] = "PT5S";
    mpd.MPD["@_timeShiftBufferDepth"] = "PT3600S";
    mpd.MPD["@_suggestedPresentationDelay"] = "PT20S";

    // Remove static-only fields if present
    delete mpd.MPD["@_mediaPresentationDuration"];

    // Compute durations (prefer explicit durationSeconds in playlist)
    const durations = items.map((it) => Number(it.durationSeconds || DEFAULT_ITEM_DURATION_SECONDS));
    const total = durations.reduce((a, b) => a + b, 0) * 1000;

    const offset = now % total;

    // Find starting index based on offset
    let acc = 0;
    let startIdx = 0;
    for (let i = 0; i < durations.length; i++) {
      const d = durations[i] * 1000;
      if (acc + d > offset) { startIdx = i; break; }
      acc += d;
    }

    // Build a window of N periods ahead (keep MPD small)
    const WINDOW_ITEMS = Number(process.env.WINDOW_ITEMS || 5);
    const periods = [];

    let periodStartSeconds = 0;
    for (let k = 0; k < Math.min(WINDOW_ITEMS, items.length); k++) {
      const idx = (startIdx + k) % items.length;
      const it = items[idx];
      const url = it?.asset?.url || it?.url;
      const dur = durations[idx];

      periods.push({
        "@_id": it.id || `vod-${idx}`,
        "@_start": `PT${periodStartSeconds}S`,
        "@_duration": `PT${dur}S`,
        BaseURL: url.replace(/\/manifest\.mpd.*$/, "/"), // base path heuristic
        // Keep the same AdaptationSet structure as the template MPD
        AdaptationSet: mpd.MPD.Period?.AdaptationSet || mpd.MPD.Period?.[0]?.AdaptationSet
      });

      periodStartSeconds += dur;
    }

    // Replace Period with our stitched periods
    mpd.MPD.Period = periods;

    const out = xmlBuilder.build(mpd);
    res.set("Content-Type", "application/dash+xml");
    res.status(200).send(out);
  } catch (e) {
    res.status(500).send(`Error generating MPD: ${e?.message || e}`);
  }
});

app.listen(PORT, () => {
  console.log(`vilmertv listening on :${PORT}`);
  console.log(`PLAYLIST_URL=${PLAYLIST_URL}`);
});
