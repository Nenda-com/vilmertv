// Build a dynamic multi-period DASH MPD from scheduler Periods + cache.
//
// Each Period embeds *its own* AdaptationSets (deep-cloned from the source)
// with absolute BaseURL — that is what lets the channel mix resolutions,
// framerates, codecs, and audio layouts across items.
//
// Two non-obvious load-bearing transformations happen here (see CLAUDE.md
// "Hard-won lessons" for the why):
//
//   1. SegmentTimeline trim — Shaka uses the timeline's last-segment-end as
//      the live edge, NOT Period@duration. Trim each AS's SegmentTimeline.S
//      to the Period's effective duration.
//
//   2. Canonical AdaptationSet @id — same logical rendition (e.g. "1080p video")
//      gets the same @id across every Period. Otherwise Shaka mismatches
//      renditions across boundaries and the transition fails.

import { XMLBuilder } from "fast-xml-parser";

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressBooleanAttributes: false,
});

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function ptStr(seconds) {
  return `PT${seconds}S`;
}

function isoString(t) {
  return t instanceof Date ? t.toISOString() : new Date(t).toISOString();
}

function sanitizeBooleans(node) {
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
    if (v && typeof v === "object") sanitizeBooleans(v);
  }
}

// Trim a (cloned) AdaptationSet's SegmentTimeline.S so the timeline covers at
// most `maxSeconds` of period-relative time. Without this, Shaka picks the
// timeline's final segment end as the live edge.
//
// Trims both AS-level SegmentTemplate and per-Representation SegmentTemplate
// when present.
export function trimSegmentTimeline(as, maxSeconds) {
  const templates = [];
  if (as?.SegmentTemplate) templates.push(as.SegmentTemplate);
  for (const r of asArray(as?.Representation)) {
    if (r?.SegmentTemplate) templates.push(r.SegmentTemplate);
  }
  for (const st of templates) {
    const tl = st.SegmentTimeline;
    if (!tl) continue;
    const ts = Number(st["@_timescale"] || 1);
    if (!(ts > 0)) continue;

    const maxTicks = Math.floor(maxSeconds * ts);
    if (maxTicks <= 0) {
      st.SegmentTimeline = { S: [] };
      continue;
    }

    let runningT = 0;
    const newS = [];
    for (const s of asArray(tl.S)) {
      const tAttr = s?.["@_t"];
      const t = tAttr !== undefined ? Number(tAttr) : runningT;
      const d = Number(s?.["@_d"]);
      const r = Number(s?.["@_r"] || 0);
      if (!Number.isFinite(d) || d <= 0) continue;
      const count = Number.isFinite(r) && r >= 0 ? r + 1 : 1;
      const fullEnd = t + d * count;
      if (t >= maxTicks) break;
      if (fullEnd <= maxTicks) {
        newS.push(s);
        runningT = fullEnd;
      } else {
        const keepCount = Math.floor((maxTicks - t) / d);
        if (keepCount > 0) {
          const partial = { ...s };
          if (keepCount === 1) delete partial["@_r"];
          else partial["@_r"] = String(keepCount - 1);
          newS.push(partial);
          runningT = t + d * keepCount;
        }
        break;
      }
    }
    st.SegmentTimeline.S = newS;
  }
  return as;
}

// Canonical fingerprint for an AdaptationSet — same logical rendition gets the
// same fingerprint regardless of which Period it lives in. Used so the same
// `@id` can be assigned across Periods for matching renditions.
export function canonicalAdaptationSetKey(as) {
  return [
    as["@_contentType"] || "",
    as["@_mimeType"] || "",
    `${as["@_maxWidth"] || ""}x${as["@_maxHeight"] || ""}`,
    as["@_lang"] || "",
    as["@_codingDependency"] === "false" ? "trick" : "main",
  ].join("|");
}

// Allocator that returns a stable id for each unique canonical key.
// Keep one per buildMpd call; same instance across periods within that build.
export function canonicalIdAllocator() {
  const ids = new Map();
  let next = 1;
  return (as) => {
    const key = canonicalAdaptationSetKey(as);
    let id = ids.get(key);
    if (id === undefined) {
      id = next++;
      ids.set(key, id);
    }
    return String(id);
  };
}

/**
 * Build the MPD XML string.
 *
 * @param {object}        args
 * @param {string|Date}   args.epoch         channel epoch → MPD@availabilityStartTime
 * @param {Array}         args.periods       from scheduler.windowPeriods()
 * @param {object}        args.cache         object with getResolvedItem(sourceUrl)
 * @param {object}        [args.settings]
 * @param {number}        [args.settings.minUpdatePeriodSec=4]
 * @param {number}        [args.settings.timeShiftSec=30]
 * @param {number}        [args.settings.suggestedDelaySec=12]
 * @param {number}        [args.settings.minBufferTimeSec=2]
 * @param {string}        [args.utcTimingUrl]
 * @param {Function}      [args.transformBaseUrl]   (upstreamBaseUrl) => string
 *                                                   (e.g. through a segment proxy)
 * @param {Date}          [args.now=new Date()]
 */
export function buildMpd({
  epoch,
  periods,
  cache,
  settings,
  utcTimingUrl,
  transformBaseUrl,
  now,
}) {
  const {
    minUpdatePeriodSec = 4,
    timeShiftSec = 30,
    suggestedDelaySec = 12,
    minBufferTimeSec = 2,
  } = settings || {};

  const allocateId = canonicalIdAllocator();

  const periodEls = periods.map((p) => {
    const resolved = cache.getResolvedItem(p.sourceUrl);
    if (!resolved) {
      throw new Error(`buildMpd: cache miss for ${p.sourceUrl}`);
    }
    const adaptationSets = resolved.adaptationSets.map((as) => {
      const cloned = deepClone(as);
      trimSegmentTimeline(cloned, p.duration);
      cloned["@_id"] = allocateId(cloned);
      return cloned;
    });

    const baseUrl = transformBaseUrl
      ? transformBaseUrl(resolved.baseUrl)
      : resolved.baseUrl;

    return {
      "@_id": p.id,
      "@_start": ptStr(p.start),
      "@_duration": ptStr(p.duration),
      BaseURL: baseUrl,
      AdaptationSet: adaptationSets,
    };
  });

  const mpdBody = {
    "@_xmlns": "urn:mpeg:dash:schema:mpd:2011",
    "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
    "@_xsi:schemaLocation":
      "urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd",
    "@_profiles": "urn:mpeg:dash:profile:isoff-live:2011",
    "@_type": "dynamic",
    "@_availabilityStartTime": isoString(epoch),
    "@_publishTime": isoString(now || new Date()),
    "@_minimumUpdatePeriod": ptStr(minUpdatePeriodSec),
    "@_timeShiftBufferDepth": ptStr(timeShiftSec),
    "@_suggestedPresentationDelay": ptStr(suggestedDelaySec),
    "@_minBufferTime": ptStr(minBufferTimeSec),
  };

  if (utcTimingUrl) {
    mpdBody.UTCTiming = {
      "@_schemeIdUri": "urn:mpeg:dash:utc:http-iso:2014",
      "@_value": utcTimingUrl,
    };
  }

  mpdBody.Period = periodEls;

  const root = { MPD: mpdBody };
  sanitizeBooleans(root);

  return '<?xml version="1.0" encoding="UTF-8"?>\n' + xmlBuilder.build(root);
}
