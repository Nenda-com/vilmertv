import test from "node:test";
import assert from "node:assert/strict";
import { SourceCache } from "./cache.js";

const MPD = (durSec) => `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT${durSec}S">
  <Period>
    <AdaptationSet contentType="video">
      <Representation id="v0" bandwidth="1000000" width="1280" height="720" codecs="avc1.4d401f"/>
    </AdaptationSet>
  </Period>
</MPD>`;

const PLAYLIST = {
  items: [
    { asset: { url: "https://cdn/a.mpd" } },
    { asset: { url: "https://cdn/b.mpd" } },
    { asset: { url: "https://cdn/c.mpd" } },
  ],
};

function makeMockFetch({ playlist = PLAYLIST, durations = { a: 10, b: 20, c: 30 }, fail = new Set() } = {}) {
  return async (url) => {
    if (url.endsWith(".json") || url.includes("playlist")) {
      return {
        ok: true,
        url,
        status: 200,
        json: async () => playlist,
      };
    }
    if (fail.has(url)) {
      return { ok: false, status: 502, url };
    }
    const m = url.match(/\/([a-z])\.mpd$/);
    const key = m?.[1];
    const dur = durations[key];
    if (dur == null) return { ok: false, status: 404, url };
    return {
      ok: true,
      url,
      status: 200,
      text: async () => MPD(dur),
    };
  };
}

const SILENT = { log: () => {}, warn: () => {}, error: () => {} };

test("cache.refresh: resolves all items, exposes them via getActiveItems", async () => {
  const cache = new SourceCache({
    playlistUrl: "https://x/playlist.json",
    fetchImpl: makeMockFetch(),
    log: SILENT,
  });
  await cache.refresh();
  const items = cache.getActiveItems();
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((i) => i.duration),
    [10, 20, 30]
  );
  assert.equal(items[0].sourceUrl, "https://cdn/a.mpd");
});

test("cache.refresh: failed sources are excluded but tracked", async () => {
  const cache = new SourceCache({
    playlistUrl: "https://x/playlist.json",
    fetchImpl: makeMockFetch({ fail: new Set(["https://cdn/b.mpd"]) }),
    log: SILENT,
  });
  await cache.refresh();
  const items = cache.getActiveItems();
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((i) => i.sourceUrl),
    ["https://cdn/a.mpd", "https://cdn/c.mpd"]
  );
  const h = cache.health();
  assert.equal(h.failed.length, 1);
  assert.equal(h.failed[0].sourceUrl, "https://cdn/b.mpd");
  assert.match(h.failed[0].reason, /HTTP 502/);
});

test("cache.refresh: increments attempts on persistent failure", async () => {
  const cache = new SourceCache({
    playlistUrl: "https://x/playlist.json",
    fetchImpl: makeMockFetch({ fail: new Set(["https://cdn/b.mpd"]) }),
    log: SILENT,
  });
  await cache.refresh();
  await cache.refresh();
  const h = cache.health();
  const b = h.failed.find((f) => f.sourceUrl === "https://cdn/b.mpd");
  assert.equal(b.attempts, 2);
});

test("cache.refresh: webhook fires once per new failure", async () => {
  const calls = [];
  const baseFetch = makeMockFetch({ fail: new Set(["https://cdn/b.mpd"]) });
  const fetchImpl = async (url, init) => {
    if (url === "https://hook/") {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 200, url };
    }
    return baseFetch(url, init);
  };
  const cache = new SourceCache({
    playlistUrl: "https://x/playlist.json",
    fetchImpl,
    failureWebhookUrl: "https://hook/",
    log: SILENT,
  });
  await cache.refresh();
  await cache.refresh(); // second refresh: same failure, should NOT re-notify
  // Allow the fire-and-forget webhook to settle
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceUrl, "https://cdn/b.mpd");
});

test("cache.refresh: deduplicates repeated source URLs in playlist", async () => {
  const playlist = {
    items: [
      { asset: { url: "https://cdn/a.mpd" } },
      { asset: { url: "https://cdn/a.mpd" } }, // dup
      { asset: { url: "https://cdn/b.mpd" } },
    ],
  };
  const cache = new SourceCache({
    playlistUrl: "https://x/playlist.json",
    fetchImpl: makeMockFetch({ playlist }),
    log: SILENT,
  });
  await cache.refresh();
  assert.equal(cache.getActiveItems().length, 2);
});

test("cache.refresh: playlist fetch failure surfaces as lastRefreshError, doesn't throw", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  const cache = new SourceCache({
    playlistUrl: "https://x/playlist.json",
    fetchImpl,
    log: SILENT,
  });
  await cache.refresh(); // must not throw
  assert.match(cache.lastRefreshError, /HTTP 503/);
  assert.equal(cache.getActiveItems().length, 0);
});
