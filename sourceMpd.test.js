import test from "node:test";
import assert from "node:assert/strict";
import {
  parseISO8601Duration,
  hasContentProtection,
  resolveBaseUrl,
  measuredDurationFromAdaptationSets,
  isImageAdaptationSet,
  parseMpd,
  fetchAndResolve,
} from "./sourceMpd.js";

test("parseISO8601Duration: PT30S", () => {
  assert.equal(parseISO8601Duration("PT30S"), 30);
});

test("parseISO8601Duration: PT1H30M5.5S", () => {
  assert.equal(parseISO8601Duration("PT1H30M5.5S"), 5405.5);
});

test("parseISO8601Duration: PT0.5S", () => {
  assert.equal(parseISO8601Duration("PT0.5S"), 0.5);
});

test("parseISO8601Duration: invalid → null", () => {
  assert.equal(parseISO8601Duration("garbage"), null);
  assert.equal(parseISO8601Duration(null), null);
  assert.equal(parseISO8601Duration("P1Y"), null); // we don't handle Y/M/D
});

test("hasContentProtection: detects nested ContentProtection", () => {
  assert.equal(
    hasContentProtection({
      AdaptationSet: { ContentProtection: { "@_schemeIdUri": "x" } },
    }),
    true
  );
  assert.equal(hasContentProtection({ AdaptationSet: { foo: "bar" } }), false);
});

test("resolveBaseUrl: relative BaseURL resolves against source URL", () => {
  const url = resolveBaseUrl({ BaseURL: "video/" }, null, "https://cdn/asset1/manifest.mpd");
  assert.equal(url, "https://cdn/asset1/video/");
});

test("resolveBaseUrl: missing BaseURL → directory of source", () => {
  const url = resolveBaseUrl({}, null, "https://cdn/asset1/manifest.mpd");
  assert.equal(url, "https://cdn/asset1/");
});

test("resolveBaseUrl: absolute BaseURL preserved", () => {
  const url = resolveBaseUrl(
    { BaseURL: "https://other.cdn/foo/" },
    null,
    "https://cdn/manifest.mpd"
  );
  assert.equal(url, "https://other.cdn/foo/");
});

test("resolveBaseUrl: combines MPD-level and Period-level BaseURL", () => {
  const url = resolveBaseUrl(
    { BaseURL: "https://cdn/asset/" },
    { BaseURL: "video/" },
    "https://x/m.mpd"
  );
  assert.equal(url, "https://cdn/asset/video/");
});

test("measuredDurationFromAdaptationSets: takes MIN across sets (not max)", () => {
  // Video 25s, audio 24.97s. MIN = 24.97 (otherwise Safari MSE stalls).
  const sets = [
    {
      "@_contentType": "video",
      SegmentTemplate: {
        "@_timescale": "1000",
        SegmentTimeline: {
          S: [
            { "@_d": "5000" },
            { "@_d": "5000", "@_r": "3" },
          ],
        },
      },
    },
    {
      "@_contentType": "audio",
      SegmentTemplate: {
        "@_timescale": "48000",
        SegmentTimeline: {
          S: [{ "@_d": "239856", "@_r": "4" }], // 5 × 239856 / 48000 = 24.985s
        },
      },
    },
  ];
  const d = measuredDurationFromAdaptationSets(sets);
  assert.ok(d < 25 && d > 24.9, `expected ~24.985, got ${d}`);
});

test("isImageAdaptationSet: detects image tracks", () => {
  assert.equal(
    isImageAdaptationSet({ "@_contentType": "image" }),
    true
  );
  assert.equal(
    isImageAdaptationSet({ "@_mimeType": "image/jpeg" }),
    true
  );
  assert.equal(
    isImageAdaptationSet({ "@_contentType": "video" }),
    false
  );
});

const MINIMAL_MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT30S">
  <Period>
    <AdaptationSet contentType="video">
      <Representation id="v0" bandwidth="1000000" width="1280" height="720" codecs="avc1.4d401f"/>
    </AdaptationSet>
  </Period>
</MPD>`;

test("parseMpd: minimal MPD → ResolvedItem with duration", () => {
  const r = parseMpd(MINIMAL_MPD, "https://cdn/asset1/m.mpd", "https://cdn/asset1/m.mpd");
  assert.equal(r.measuredDuration, 30);
  assert.equal(r.baseUrl, "https://cdn/asset1/");
  assert.equal(r.adaptationSets.length, 1);
  assert.equal(r.sourceUrl, "https://cdn/asset1/m.mpd");
});

test("parseMpd: rejects multi-period source", () => {
  const xml = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT30S">
  <Period><AdaptationSet/></Period>
  <Period><AdaptationSet/></Period>
</MPD>`;
  assert.throws(() => parseMpd(xml, "https://x/m.mpd"), /multi-period/);
});

test("parseMpd: rejects ContentProtection (DRM)", () => {
  const xml = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT30S">
  <Period>
    <AdaptationSet>
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
      <Representation id="v0" bandwidth="1000000"/>
    </AdaptationSet>
  </Period>
</MPD>`;
  assert.throws(() => parseMpd(xml, "https://x/m.mpd"), /ContentProtection|DRM/);
});

test("parseMpd: missing duration → throws", () => {
  const xml = `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <Representation id="v0" bandwidth="1000000"/>
    </AdaptationSet>
  </Period>
</MPD>`;
  assert.throws(() => parseMpd(xml, "https://x/m.mpd"), /duration/);
});

test("parseMpd: derives duration from SegmentTimeline (no @mediaPresentationDuration)", () => {
  const xml = `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <SegmentTemplate timescale="1000">
        <SegmentTimeline>
          <S d="2000" r="4"/>
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="v0" bandwidth="1000000"/>
    </AdaptationSet>
  </Period>
</MPD>`;
  const r = parseMpd(xml, "https://x/m.mpd");
  assert.equal(r.measuredDuration, 10); // 2000 × 5 / 1000
});

test("parseMpd: drops image AdaptationSets", () => {
  const xml = `<?xml version="1.0"?>
<MPD mediaPresentationDuration="PT30S">
  <Period>
    <AdaptationSet contentType="video">
      <Representation id="v0" bandwidth="1000000"/>
    </AdaptationSet>
    <AdaptationSet contentType="image" mimeType="image/jpeg">
      <Representation id="thumb" bandwidth="1000"/>
    </AdaptationSet>
  </Period>
</MPD>`;
  const r = parseMpd(xml, "https://x/m.mpd");
  assert.equal(r.adaptationSets.length, 1);
  assert.equal(r.adaptationSets[0]["@_contentType"], "video");
});

test("fetchAndResolve: integrates fetch + parse", async () => {
  const mockFetch = async (url) => ({
    ok: true,
    url,
    status: 200,
    text: async () => MINIMAL_MPD,
  });
  const r = await fetchAndResolve("https://cdn/asset1/m.mpd", {
    fetchImpl: mockFetch,
  });
  assert.equal(r.measuredDuration, 30);
  assert.equal(r.baseUrl, "https://cdn/asset1/");
});

test("fetchAndResolve: non-2xx → throws", async () => {
  const mockFetch = async () => ({ ok: false, status: 404 });
  await assert.rejects(
    fetchAndResolve("https://x/m.mpd", { fetchImpl: mockFetch }),
    /HTTP 404/
  );
});
