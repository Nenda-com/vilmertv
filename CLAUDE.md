# vilmertv — DASH FAST Channel Server

A Node.js service that stitches pre-encoded VOD DASH manifests into a continuous **live linear DASH stream** (a "FAST channel"). All viewers tuning in at the same wall-clock time see the same content. Source assets vary in resolution, framerate, codec, and audio tracks. Output is plain DASH, no DRM. Hosted on Eyevinn's Open Source Cloud (osaas.io).

> **This file is the project knowledgebase. Update it when we learn something new about the design, the runtime environment, or the broader DASH/FAST landscape.**

---

## Requirements (canonical)

1. Pull already-hosted DASH manifests from a static link (no transcoding).
2. Handle different framerates, resolutions, lengths, audio tracks across items.
3. Multi-unit live feel — clients tuning in must see roughly the same content at the same time.
4. Output: DASH, no DRM.
5. Smooth transitions; brief MSE re-init (~200 ms) is acceptable, but the player must not stall waiting for buffer to drain.
6. Resilient — one bad source must not bring down the channel.

### Non-requirements (explicit)

- **No DVR / scrubbing.** `timeShiftBufferDepth` only needs to cover player jitter (~30 s).
- **No scheduled programming.** Fixed loop of the playlist; we do not need named slots / EPG.
- **No transcoding.** Sources are reused as-is via `BaseURL`.

---

## Architecture (target)

### Liveness model — epoch-anchored deterministic schedule

A single immutable `CHANNEL_EPOCH` (env var) anchors the channel. Every client doing the same math against the same playlist arrives at the same Period:

```
elapsed     = now − CHANNEL_EPOCH
cycle       = floor(elapsed / loopDuration)
posInCycle  = elapsed mod loopDuration
itemIndex   = first i where cumulativeDurations[i+1] > posInCycle
```

This is the only mechanism that satisfies (3). `availabilityStartTime` in the MPD = `CHANNEL_EPOCH`.

### Multi-period DASH — one Period per VOD

Each VOD becomes a `<Period>` with **its own AdaptationSets copied verbatim from the source MPD**. Mixed ladders (req 2) are handled by the player at Period boundaries (~200 ms re-init, fundamental to MSE — see "MSE re-init" below).

Stable identity is critical: a Period emitted at time T must keep the same `@id`, `@start`, `@duration` on every subsequent MPD refresh. We achieve this with:

- `Period@id = "${cycle}-${itemIndex}"` — never reused, never reshuffled.
- `Period@start = cycle * loopDuration + cumulativeOffsetWithinCycle` (absolute seconds since `availabilityStartTime`).
- `Period@duration = source.measuredDuration` (from the source MPD, not the playlist JSON).

### Sliding window

The MPD always shows roughly `[now − timeShiftBufferDepth, now + lookahead]`:

- `timeShiftBufferDepth = PT30S` (just enough for buffer/jitter; we have no DVR).
- `lookahead = ~30 s` (≈ `2 × minimumUpdatePeriod + suggestedPresentationDelay`).
- `minimumUpdatePeriod = PT4S`.
- `suggestedPresentationDelay = PT12S`.
- `publishTime` updated on every emit.

As wall clock advances, append new Periods at the end and drop old ones from the front. Never renumber, never reset `@start`.

### Source MPD ingestion + cache

- On startup and on a periodic refresh (~5 min): fetch playlist JSON, fetch each source MPD, parse, extract `{ measuredDuration, baseUrl, adaptationSets[] }`.
- Cache in memory keyed by source URL.
- Bad items (fetch fail, parse fail, has `ContentProtection`) → marked failed, excluded from the active playlist, surfaced via `/health/sources`.
- `/channel.mpd` requests **never** hit the network at request time. They read from the cache. This is what makes the server hiccup-tolerant.

### UTCTiming

```xml
<UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-iso:2014" value="https://<host>/time"/>
```

The server exposes `GET /time` returning ISO 8601 UTC. Without this, two clients with skewed clocks land on different Periods.

---

## Module layout

| Module | Role | Purity |
|---|---|---|
| `playlist.js` | Fetch + validate playlist JSON | I/O |
| `sourceMpd.js` | Fetch + parse one source MPD → `ResolvedItem` | I/O |
| `cache.js` | `ResolvedItem` cache + refresh loop + failure list | I/O + state |
| `scheduler.js` | Pure: `(epoch, items, t) → currentItem` and `(window) → Period[]` | **Pure** |
| `mpd.js` | Build MPD object from Periods + emit XML | Pure |
| `server.js` | Express wiring (`/channel.mpd`, `/time`, `/health/sources`, `/healthz`) | I/O |

`scheduler.js` is pure on purpose — timeline math is where this kind of system silently breaks, so it has to be unit-testable in isolation.

---

## Key concepts

### MSE re-init at Period boundaries

When two consecutive Periods differ in codec, resolution, or framerate, MSE **must** flush the source buffer and re-init the decoder. This is a 100–500 ms stall on Shaka / dash.js / ExoPlayer — fundamental to MSE, not a manifest bug. Truly seamless transitions require a common encoding ladder across all items (= transcoding, which conflicts with req 1).

We accept the brief glitch. We do **not** add `period-continuity` / `period-connectivity` SupplementalProperty between non-continuous items — lying to the player about continuity causes worse glitches than a clean re-init.

### Why duration must come from the source MPD

The current code's main bug (the "30-second buffer wait" the player exhibits at transitions) is `DEFAULT_ITEM_DURATION_SECONDS = 1800`. If a playlist item lacks `durationSeconds`, every Period claims 30 minutes; player burns through real segments in seconds, then sits idle because the manifest insists the Period is still going. **Use `mediaPresentationDuration` (or summed `SegmentTimeline`) from the source MPD as the truth.**

### `presentationTimeOffset` rebasing

Source MPDs typically have segment timelines starting at 0 within their own MPD. When we drop a source's AdaptationSet into a Period at `Period@start = T`, the segment timeline is still 0-based, but the Period's media timeline is offset. Set `SegmentTemplate@presentationTimeOffset` so the first segment lines up with the Period's start. (Some sources already do this; verify per source.)

### CORS + the OSC ingress

Earlier debugging showed `Origin ... not allowed` errors against the OSC-hosted instance even on 200 responses. Suspected cause: the OSC ingress strips or duplicates `Access-Control-Allow-Origin`. To confirm: `curl -I https://<instance>/channel.mpd` and inspect headers. If duplicated, our middleware should not set the header on requests where the ingress already added one — but verify the upstream behavior first before changing our code.

### OSC deploy quirk

The Zod-shaped error `{ path: ["parameters"], expected: "record" }` we hit during configuration is from OSC's deploy API: instance create/update bodies require a `parameters` object (env vars). Document the canonical curl/CLI shape once we settle the env var set.

---

## FOSS landscape (May 2026)

**There is no drop-in OSS library for DASH multi-period live-linear-from-VOD.** This is a genuine gap. Survey:

| Project | License | DASH? | Verdict |
|---|---|---|---|
| `Eyevinn/channel-engine` | Apache-2.0 | **HLS only** | Architecture mirror — borrow the adapter pattern, but the segment/manifest layer is HLS-bound. Forking to add DASH = parallel engine, too much HLS-specific code. |
| `Eyevinn/hls-vodtolive` | Apache-2.0 | HLS only | Sister lib to channel-engine. |
| `Eyevinn/hls-to-dash` | — | — | Deprecated. |
| `Eyevinn/docker-dash-packager` | Apache-2.0 | DASH (packager) | Dormant since ~2016. Not a stitcher. |
| Unified Streaming Remix | Commercial | DASH | Closed source, license required. |
| Shaka Packager | Apache-2.0 | DASH | Designed to package fresh content, not stitch pre-encoded VOD MPDs into a rolling live MPD. |
| GPAC / MP4Box | LGPL | DASH | Strongest CLI; supports multi-period and `xlink`. Could orchestrate from Node, but live-linear with rolling periods + fixed AST requires significant scripting. Not a library. |
| AWS MediaTailor / Broadpeak / Mux | Commercial | DASH | Managed services; out of scope. |

**Decision: build custom.** We mirror channel-engine's adapter/scheduler pattern but emit DASH directly. If this matures, contributing back to Eyevinn as `@eyevinn/dash-vodtolive` is a plausible path.

---

## Runtime environment

- Hosted on Eyevinn Open Source Cloud (osaas.io) as a custom web service.
- Env vars passed via OSC's `parameters` field at deploy/update time.
- CORS must allow Shaka demo player origin (`shaka-player-demo.appspot.com`) — currently `*`, but see "OSC ingress" note above.

### Required env vars

| Name | Purpose |
|---|---|
| `PLAYLIST_URL` | JSON of playlist items |
| `CHANNEL_EPOCH` | ISO 8601 UTC, the channel's deterministic anchor (immutable per channel) |

### Optional env vars (with defaults)

| Name | Default | Purpose |
|---|---|---|
| `MIN_UPDATE_PERIOD_SECONDS` | 4 | DASH `minimumUpdatePeriod` |
| `TIME_SHIFT_SECONDS` | 30 | `timeShiftBufferDepth` |
| `SUGGESTED_DELAY_SECONDS` | 12 | `suggestedPresentationDelay` |
| `LOOKAHEAD_SECONDS` | 30 | How far ahead to emit Periods |
| `PLAYLIST_REFRESH_SECONDS` | 300 | How often to re-ingest sources |
| `FAILURE_WEBHOOK_URL` | — | Optional POST target for failed-item reports |

---

## Hard-won lessons (battle-tested, do not regress)

These were learned the painful way during earlier iterations. Treat them as load-bearing.

### Live edge math: SegmentTimeline must be trimmed to declared Period duration

Shaka treats each Representation's `<SegmentTimeline>` as authoritative for live-edge calculation, **not** `Period@duration`. If we copy the source's full SegmentTimeline (covering, say, 30 minutes of segments) but declare `Period@duration=PT5S`, Shaka still picks the timeline's last segment as the live edge — and parks the playhead 29:55 in the (still non-existent) future. **Fix:** when copying an AdaptationSet into a Period, trim `SegmentTimeline.S` so its summed duration ≤ the Period's effective duration.

### Per-Period duration: MIN across AdaptationSets, not `mediaPresentationDuration`

`@mediaPresentationDuration` is typically the MAX (longest track). Audio and video tracks rarely match to the millisecond, and **Safari MSE silently stalls when audio outruns video** at the Period boundary. Take the **minimum** of summed-SegmentTimeline durations across all AdaptationSets. Falls back to `@mediaPresentationDuration`, then `Period@duration`, only when SegmentTimelines are absent.

### Stable canonical AdaptationSet `@id` across Periods

Two Periods labelling their 720p video set with the same `@id` (e.g. "1") while another Period labels its 540p set as "1" breaks the boundary transition — Shaka tries to thread the same logical rendition across Periods and fails. **Fix:** assign `AdaptationSet@id` deterministically from canonical content (`contentType` + `mimeType` + `WxH` + `lang` + trick-play flag). Same ladder = same `@id` across all Periods.

### Lookahead window: never emit a partial future Period

"Just emit Periods covering the next 30 minutes" sounds fine but is fatal — Shaka treats the manifest's last-Period-end as the live edge and jumps the playhead 30 minutes into the future. **Fix:** stop emitting once the next Period would START past `now + lookahead`. If the current item is longer than the lookahead, trim its declared `@duration` to fit, and let it expand on subsequent manifest refreshes as wall-clock advances.

### Drop image / thumbnail AdaptationSets

Many source MPDs include `contentType="image"` (or `mimeType="image/jpeg"`) for trick-play thumbnails. Upstream often 404s on those segment URLs and Shaka complains loudly even though playback is fine. Filter them out at ingestion.

### HTTP keep-alive on segment proxy is non-optional

Without keep-alive on the HTTP/HTTPS agents, every proxied segment fetch pays the TCP+TLS handshake cost. Adds 100s of ms per request and **visibly stalls Period transitions** on Shaka. Use `http.Agent`/`https.Agent` with `keepAlive: true, maxSockets: 64`.

### fetch retries with timeout + backoff

Slow or briefly unavailable upstream must not take down a request — Shaka's retry budget is small and a single failed fetch can stall playback. Wrap fetches in retry-with-backoff (3 attempts, 15–20 s timeout, 300–400 ms backoff × attempt) on 5xx and network errors.

### Why the segment proxy exists (`/p/:token/<path>`)

Upstream CDN typically does **not** allow `Origin: https://shaka-player-demo.appspot.com` (or arbitrary embed origins). To make playback work cross-origin without depending on upstream CORS, we proxy every segment through our server: `BaseURL` in the emitted MPD points to `https://<our-host>/p/<base64url(upstreamBase)>/`. Token is base64url-encoded so it's path-safe with no encoding. We also pass through `Range`, `Content-Range`, `ETag`, etc. for byte-range requests.

### Manifest cache + single-in-flight build

`/channel.mpd` is hit ~once per `minimumUpdatePeriod` per client. With many clients, this herds. Cache the built XML for ~1.5 s and dedupe concurrent builds via a single in-flight Promise.

## Open questions / things to verify

- Confirm whether sample source MPDs use `mediaPresentationDuration` or `SegmentTimeline` as the authoritative duration; sometimes they disagree, and the timeline is the truth.
- Measure actual Shaka stall time at a Period boundary with a real resolution change. Sets the floor for "smooth" (req 5).
- Inspect the OSC ingress for CORS header behavior before adjusting our middleware.

---

## Conventions

- ESM (`"type": "module"`).
- One responsibility per module; pure modules stay pure.
- No CLAUDE.md / docs files generated automatically by tooling — humans (and Claude) update this file deliberately when we learn something.
