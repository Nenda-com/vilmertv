// Fetch + parse one source DASH MPD into a `ResolvedItem`.
//
// `ResolvedItem` shape:
//   {
//     sourceUrl: string,            // original URL we were asked to ingest
//     baseUrl: string,              // absolute URL where this asset's segments live
//     measuredDuration: number,     // seconds — see "MIN across AdaptationSets" in CLAUDE.md
//     adaptationSets: object[],     // AdaptationSet objects from source, image tracks dropped
//     fetchedAt: number,            // ms timestamp
//   }

import nodeFetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

export function parseISO8601Duration(str) {
  if (typeof str !== "string") return null;
  const m = str.match(
    /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/
  );
  if (!m) return null;
  const [, h, mi, s] = m;
  const total =
    (Number(h) || 0) * 3600 + (Number(mi) || 0) * 60 + (Number(s) || 0);
  return Number.isFinite(total) && total > 0 ? total : null;
}

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

export function hasContentProtection(node) {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasContentProtection);
  for (const k of Object.keys(node)) {
    if (k === "ContentProtection") return true;
    const v = node[k];
    if (v && typeof v === "object" && hasContentProtection(v)) return true;
  }
  return false;
}

// Image / thumbnail AdaptationSets: upstreams often 404 on these and Shaka
// complains loudly even when playback is otherwise fine. Drop at ingestion.
export function isImageAdaptationSet(as) {
  const ct = as?.["@_contentType"];
  const mt = as?.["@_mimeType"];
  return ct === "image" || (typeof mt === "string" && mt.startsWith("image/"));
}

function extractBaseUrlText(raw) {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const first = raw[0];
    return typeof first === "string" ? first : first?.["#text"] || "";
  }
  if (raw && typeof raw === "object") return raw["#text"] || "";
  return "";
}

// Resolves the absolute base URL for an asset by walking BaseURL elements at
// MPD- and Period-level. AdaptationSet/Representation-level BaseURLs are left
// in the cloned AdaptationSets and resolve relative to this one at playback.
export function resolveBaseUrl(mpdRoot, period, sourceMpdUrl) {
  let base = new URL(".", sourceMpdUrl).toString();
  const mpdBase = extractBaseUrlText(mpdRoot.BaseURL);
  if (mpdBase) base = new URL(mpdBase, base).toString();
  const periodBase = extractBaseUrlText(period?.BaseURL);
  if (periodBase) base = new URL(periodBase, base).toString();
  return base;
}

function durationOfSegmentTemplate(st) {
  const tl = st?.SegmentTimeline;
  if (!tl) return null;
  const ts = Number(st["@_timescale"] || 1);
  if (!(ts > 0)) return null;
  let units = 0;
  for (const s of asArray(tl.S)) {
    const d = Number(s["@_d"] || 0);
    const r = Number(s["@_r"] || 0); // r is repeats AFTER first
    if (d > 0) units += d * (r + 1);
  }
  return units > 0 ? units / ts : null;
}

export function adaptationSetTotalSeconds(as) {
  // Prefer AdaptationSet-level SegmentTemplate (the common case for VOD).
  // Fall back to any Representation-level SegmentTemplate.
  const candidates = [];
  if (as?.SegmentTemplate) candidates.push(as.SegmentTemplate);
  for (const r of asArray(as?.Representation)) {
    if (r?.SegmentTemplate) candidates.push(r.SegmentTemplate);
  }
  for (const st of candidates) {
    const d = durationOfSegmentTemplate(st);
    if (d != null) return d;
  }
  return null;
}

// Per-AdaptationSet timelines may differ by milliseconds; if we use the MAX
// (which is what @mediaPresentationDuration usually is), the shorter track ends
// before Period@duration and Safari MSE silently stalls. Use MIN.
export function measuredDurationFromAdaptationSets(adaptationSets) {
  let min = Infinity;
  for (const as of adaptationSets) {
    const d = adaptationSetTotalSeconds(as);
    if (d != null && d < min) min = d;
  }
  return Number.isFinite(min) && min > 0 ? min : null;
}

export function parseMpd(text, sourceUrl, finalUrl) {
  const parsed = xmlParser.parse(text);
  const mpd = parsed?.MPD;
  if (!mpd) throw new Error("not a valid MPD (missing root)");

  const periods = asArray(mpd.Period);
  if (periods.length === 0) throw new Error("MPD has no Period");
  if (periods.length > 1) {
    throw new Error("multi-period source MPDs not supported");
  }
  const period = periods[0];
  let adaptationSets = asArray(period.AdaptationSet);
  if (adaptationSets.length === 0) {
    throw new Error("MPD Period has no AdaptationSet");
  }

  if (hasContentProtection(period) || hasContentProtection(mpd)) {
    throw new Error("source has ContentProtection (DRM); not allowed");
  }

  // Drop image / thumbnail tracks before we measure or stitch.
  adaptationSets = adaptationSets.filter((as) => !isImageAdaptationSet(as));
  if (adaptationSets.length === 0) {
    throw new Error("no playable AdaptationSets after dropping image tracks");
  }

  // Duration: prefer MIN across AdaptationSets, fall back to @mediaPresentationDuration.
  let duration = measuredDurationFromAdaptationSets(adaptationSets);
  if (!duration) {
    duration = parseISO8601Duration(mpd["@_mediaPresentationDuration"]);
  }
  if (!duration) {
    throw new Error("could not determine duration from source MPD");
  }

  const baseUrl = resolveBaseUrl(mpd, period, finalUrl || sourceUrl);

  return {
    sourceUrl,
    baseUrl,
    measuredDuration: duration,
    adaptationSets,
    fetchedAt: Date.now(),
  };
}

export async function fetchAndResolve(sourceUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || nodeFetch;
  const resp = await fetchImpl(sourceUrl, {
    redirect: "follow",
    signal: opts.signal,
  });
  if (!resp.ok) throw new Error(`fetch failed: HTTP ${resp.status}`);
  const text = await resp.text();
  const finalUrl = resp.url || sourceUrl;
  return parseMpd(text, sourceUrl, finalUrl);
}
