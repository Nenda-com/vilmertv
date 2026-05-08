import test from "node:test";
import assert from "node:assert/strict";
import { XMLParser } from "fast-xml-parser";
import {
  buildMpd,
  trimSegmentTimeline,
  canonicalAdaptationSetKey,
  canonicalIdAllocator,
} from "./mpd.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

const EPOCH = "2026-01-01T00:00:00Z";
const NOW = new Date("2026-05-08T12:00:00Z");

const fakeAdaptationSet720 = {
  "@_id": "v",
  "@_contentType": "video",
  "@_mimeType": "video/mp4",
  "@_segmentAlignment": "true",
  Representation: {
    "@_id": "v0",
    "@_bandwidth": "2000000",
    "@_width": "1280",
    "@_height": "720",
    "@_codecs": "avc1.4d401f",
  },
  SegmentTemplate: {
    "@_timescale": "90000",
    "@_initialization": "$RepresentationID$/init.mp4",
    "@_media": "$RepresentationID$/$Number$.m4s",
    "@_startNumber": "1",
    "@_duration": "180000",
  },
};

const fakeAdaptationSet1080 = {
  "@_id": "v",
  "@_contentType": "video",
  "@_mimeType": "video/mp4",
  Representation: {
    "@_id": "v0",
    "@_bandwidth": "5000000",
    "@_width": "1920",
    "@_height": "1080",
    "@_codecs": "avc1.640028",
  },
  SegmentTemplate: {
    "@_timescale": "90000",
    "@_initialization": "$RepresentationID$/init.mp4",
    "@_media": "$RepresentationID$/$Number$.m4s",
    "@_startNumber": "1",
    "@_duration": "360000",
  },
};

function makeCache(map) {
  return {
    getResolvedItem(url) {
      return map.get(url);
    },
  };
}

test("buildMpd: produces a valid dynamic MPD with one Period", () => {
  const cache = makeCache(
    new Map([
      [
        "https://cdn/a.mpd",
        {
          sourceUrl: "https://cdn/a.mpd",
          baseUrl: "https://cdn/asset-a/",
          measuredDuration: 30,
          adaptationSets: [fakeAdaptationSet720],
        },
      ],
    ])
  );

  const xml = buildMpd({
    epoch: EPOCH,
    periods: [
      {
        id: "0-0",
        start: 0,
        duration: 30,
        sourceUrl: "https://cdn/a.mpd",
      },
    ],
    cache,
    now: NOW,
  });

  // Round-trip through parser to assert structure
  const parsed = parser.parse(xml);
  const mpd = parsed.MPD;

  assert.equal(mpd["@_type"], "dynamic");
  assert.equal(mpd["@_availabilityStartTime"], "2026-01-01T00:00:00.000Z");
  assert.equal(mpd["@_minimumUpdatePeriod"], "PT4S");
  assert.equal(mpd["@_timeShiftBufferDepth"], "PT30S");
  assert.equal(mpd["@_suggestedPresentationDelay"], "PT12S");
  assert.equal(mpd["@_minBufferTime"], "PT2S");

  const period = mpd.Period;
  assert.equal(period["@_id"], "0-0");
  assert.equal(period["@_start"], "PT0S");
  assert.equal(period["@_duration"], "PT30S");
  assert.equal(period.BaseURL, "https://cdn/asset-a/");
  // AdaptationSet id is the canonical stable id (1 for the first unique rendition)
  assert.equal(period.AdaptationSet["@_id"], "1");
});

test("buildMpd: each Period gets its own AdaptationSet copy (mixed resolutions)", () => {
  const cache = makeCache(
    new Map([
      [
        "https://cdn/a.mpd",
        {
          sourceUrl: "https://cdn/a.mpd",
          baseUrl: "https://cdn/asset-a/",
          measuredDuration: 30,
          adaptationSets: [fakeAdaptationSet720],
        },
      ],
      [
        "https://cdn/b.mpd",
        {
          sourceUrl: "https://cdn/b.mpd",
          baseUrl: "https://cdn/asset-b/",
          measuredDuration: 60,
          adaptationSets: [fakeAdaptationSet1080],
        },
      ],
    ])
  );

  const xml = buildMpd({
    epoch: EPOCH,
    periods: [
      { id: "0-0", start: 0, duration: 30, sourceUrl: "https://cdn/a.mpd" },
      { id: "0-1", start: 30, duration: 60, sourceUrl: "https://cdn/b.mpd" },
    ],
    cache,
    now: NOW,
  });

  const parsed = parser.parse(xml);
  const periods = parsed.MPD.Period;
  assert.equal(periods.length, 2);
  assert.equal(periods[0].BaseURL, "https://cdn/asset-a/");
  assert.equal(periods[1].BaseURL, "https://cdn/asset-b/");
  // Period 0 keeps 720p Representation; Period 1 keeps 1080p
  assert.equal(periods[0].AdaptationSet.Representation["@_height"], "720");
  assert.equal(periods[1].AdaptationSet.Representation["@_height"], "1080");
  // Both are video AdaptationSets → SAME canonical id, so Shaka threads them
  // as the same logical rendition across Periods.
  assert.equal(
    periods[0].AdaptationSet["@_id"],
    periods[1].AdaptationSet["@_id"]
  );
});

test("buildMpd: same logical rendition gets the same @id across Periods", () => {
  // Two periods using the SAME source → same canonical fingerprint → same id
  const cache = makeCache(
    new Map([
      [
        "https://cdn/a.mpd",
        {
          baseUrl: "https://cdn/a/",
          adaptationSets: [fakeAdaptationSet720],
          measuredDuration: 30,
        },
      ],
    ])
  );
  const xml = buildMpd({
    epoch: EPOCH,
    periods: [
      { id: "0-0", start: 0, duration: 30, sourceUrl: "https://cdn/a.mpd" },
      { id: "0-1", start: 30, duration: 30, sourceUrl: "https://cdn/a.mpd" },
    ],
    cache,
    now: NOW,
  });
  const periods = parser.parse(xml).MPD.Period;
  assert.equal(
    periods[0].AdaptationSet["@_id"],
    periods[1].AdaptationSet["@_id"]
  );
});

test("buildMpd: transformBaseUrl rewrites Period BaseURL (e.g. proxy)", () => {
  const cache = makeCache(
    new Map([
      [
        "https://cdn/a.mpd",
        {
          baseUrl: "https://upstream.cdn/asset-a/",
          adaptationSets: [fakeAdaptationSet720],
          measuredDuration: 30,
        },
      ],
    ])
  );
  const xml = buildMpd({
    epoch: EPOCH,
    periods: [
      { id: "0-0", start: 0, duration: 30, sourceUrl: "https://cdn/a.mpd" },
    ],
    cache,
    transformBaseUrl: (u) => `https://proxy/p/${Buffer.from(u).toString("base64url")}/`,
    now: NOW,
  });
  const period = parser.parse(xml).MPD.Period;
  assert.match(period.BaseURL, /^https:\/\/proxy\/p\//);
  assert.match(period.BaseURL, /\/$/);
});

test("buildMpd: trims SegmentTimeline to Period duration", () => {
  // SegmentTemplate has 10 × 5s segments = 50s total.
  // Period duration = 12s → trim to 3 segments (15s of timeline; closest <=12s is 2 segments=10s).
  // Actually with d=5s units in timescale 1: floor(12/5) = 2 segments.
  const sourceAS = {
    "@_id": "v",
    "@_contentType": "video",
    Representation: { "@_id": "v0", "@_bandwidth": "1000000" },
    SegmentTemplate: {
      "@_timescale": "1",
      "@_initialization": "init.mp4",
      "@_media": "$Number$.m4s",
      SegmentTimeline: { S: [{ "@_d": "5", "@_r": "9" }] }, // 10 × 5s
    },
  };
  const cache = makeCache(
    new Map([
      [
        "https://cdn/a.mpd",
        {
          baseUrl: "https://cdn/a/",
          adaptationSets: [sourceAS],
          measuredDuration: 50,
        },
      ],
    ])
  );
  const xml = buildMpd({
    epoch: EPOCH,
    periods: [{ id: "0-0", start: 0, duration: 12, sourceUrl: "https://cdn/a.mpd" }],
    cache,
    now: NOW,
  });
  const tl = parser.parse(xml).MPD.Period.AdaptationSet.SegmentTemplate.SegmentTimeline;
  // floor(12 / 5) = 2 segments → r="1" (which means 2 total)
  assert.equal(tl.S["@_d"], "5");
  assert.equal(tl.S["@_r"], "1");
});

test("buildMpd: deep-clones AdaptationSets — mutating output does not affect cache", () => {
  const sharedAS = JSON.parse(JSON.stringify(fakeAdaptationSet720));
  const cache = makeCache(
    new Map([
      [
        "https://cdn/a.mpd",
        {
          sourceUrl: "https://cdn/a.mpd",
          baseUrl: "https://cdn/asset-a/",
          measuredDuration: 30,
          adaptationSets: [sharedAS],
        },
      ],
    ])
  );

  buildMpd({
    epoch: EPOCH,
    periods: [
      { id: "0-0", start: 0, duration: 30, sourceUrl: "https://cdn/a.mpd" },
      { id: "0-1", start: 30, duration: 30, sourceUrl: "https://cdn/a.mpd" },
    ],
    cache,
    now: NOW,
  });

  // Cache's AdaptationSet @_id is unchanged (build() rewrote on its clone)
  assert.equal(sharedAS["@_id"], "v");
});

test("buildMpd: emits UTCTiming when utcTimingUrl provided", () => {
  const cache = makeCache(
    new Map([
      [
        "https://cdn/a.mpd",
        {
          baseUrl: "https://cdn/a/",
          adaptationSets: [fakeAdaptationSet720],
          measuredDuration: 30,
        },
      ],
    ])
  );
  const xml = buildMpd({
    epoch: EPOCH,
    periods: [{ id: "0-0", start: 0, duration: 30, sourceUrl: "https://cdn/a.mpd" }],
    cache,
    utcTimingUrl: "https://example/time",
    now: NOW,
  });
  const parsed = parser.parse(xml);
  assert.equal(
    parsed.MPD.UTCTiming["@_schemeIdUri"],
    "urn:mpeg:dash:utc:http-iso:2014"
  );
  assert.equal(parsed.MPD.UTCTiming["@_value"], "https://example/time");
});

test("buildMpd: throws on cache miss", () => {
  const cache = makeCache(new Map());
  assert.throws(
    () =>
      buildMpd({
        epoch: EPOCH,
        periods: [{ id: "0-0", start: 0, duration: 30, sourceUrl: "https://x" }],
        cache,
        now: NOW,
      }),
    /cache miss/
  );
});

test("buildMpd: empty periods array → MPD with no Period", () => {
  const cache = makeCache(new Map());
  const xml = buildMpd({
    epoch: EPOCH,
    periods: [],
    cache,
    now: NOW,
  });
  const parsed = parser.parse(xml);
  assert.equal(parsed.MPD.Period, undefined);
  assert.equal(parsed.MPD["@_type"], "dynamic");
});

test("buildMpd: round-trip preserves SegmentTemplate attributes", () => {
  const cache = makeCache(
    new Map([
      [
        "https://cdn/a.mpd",
        {
          baseUrl: "https://cdn/a/",
          adaptationSets: [fakeAdaptationSet720],
          measuredDuration: 30,
        },
      ],
    ])
  );
  const xml = buildMpd({
    epoch: EPOCH,
    periods: [{ id: "0-0", start: 0, duration: 30, sourceUrl: "https://cdn/a.mpd" }],
    cache,
    now: NOW,
  });
  const parsed = parser.parse(xml);
  const st = parsed.MPD.Period.AdaptationSet.SegmentTemplate;
  assert.equal(st["@_timescale"], "90000");
  assert.equal(st["@_media"], "$RepresentationID$/$Number$.m4s");
  assert.equal(st["@_startNumber"], "1");
});

test("trimSegmentTimeline: keeps full S elements that fit", () => {
  const as = {
    SegmentTemplate: {
      "@_timescale": "1000",
      SegmentTimeline: { S: [{ "@_d": "1000", "@_r": "4" }] }, // 5s
    },
  };
  trimSegmentTimeline(as, 5);
  assert.deepEqual(as.SegmentTemplate.SegmentTimeline.S, [
    { "@_d": "1000", "@_r": "4" },
  ]);
});

test("trimSegmentTimeline: partial trim produces a clipped repeat count", () => {
  const as = {
    SegmentTemplate: {
      "@_timescale": "1000",
      SegmentTimeline: { S: [{ "@_d": "1000", "@_r": "9" }] }, // 10s of segments
    },
  };
  trimSegmentTimeline(as, 3);
  // 3 segments fit (3000 ticks) → r=2
  const s = as.SegmentTemplate.SegmentTimeline.S;
  assert.equal(s.length, 1);
  assert.equal(s[0]["@_r"], "2");
});

test("canonicalAdaptationSetKey: same content → same key", () => {
  const a = { "@_contentType": "video", "@_mimeType": "video/mp4", "@_maxWidth": "1920", "@_maxHeight": "1080" };
  const b = { "@_contentType": "video", "@_mimeType": "video/mp4", "@_maxWidth": "1920", "@_maxHeight": "1080" };
  assert.equal(canonicalAdaptationSetKey(a), canonicalAdaptationSetKey(b));
});

test("canonicalIdAllocator: stable ids per fingerprint", () => {
  const alloc = canonicalIdAllocator();
  const v720 = { "@_contentType": "video", "@_maxHeight": "720" };
  const v1080 = { "@_contentType": "video", "@_maxHeight": "1080" };
  assert.equal(alloc(v720), "1");
  assert.equal(alloc(v1080), "2");
  assert.equal(alloc(v720), "1"); // same key → same id
});

test("buildMpd: starts with XML declaration", () => {
  const cache = makeCache(new Map());
  const xml = buildMpd({
    epoch: EPOCH,
    periods: [],
    cache,
    now: NOW,
  });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
});
