// Source MPD cache + refresh loop.
//
// `/channel.mpd` reads from this cache exclusively — no network at request time.
// That is what makes the channel hiccup-tolerant (req 6).
//
// Failure model: any source that fails to fetch/parse, or that contains
// ContentProtection, is excluded from the active playlist and surfaced via
// `/health/sources`. Optionally POSTs to FAILURE_WEBHOOK_URL on first failure.

import nodeFetch from "node-fetch";
import { fetchAndResolve } from "./sourceMpd.js";

function pickItems(json) {
  if (Array.isArray(json?.items)) return json.items;
  if (Array.isArray(json?.programs)) return json.programs;
  if (Array.isArray(json)) return json;
  return [];
}

function pickSourceUrl(item) {
  return item?.asset?.url || item?.url || item?.mpdUrl;
}

export class SourceCache {
  constructor(opts) {
    this.playlistUrl = opts.playlistUrl;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 5 * 60_000;
    this.failureWebhookUrl = opts.failureWebhookUrl || null;
    this.fetchImpl = opts.fetchImpl || nodeFetch;
    this.log = opts.log || console;

    this.playlistOrder = [];
    this.resolved = new Map();
    this.failed = new Map();
    this.lastRefreshAt = 0;
    this.lastRefreshError = null;
    this._timer = null;
    this._refreshing = false;
  }

  async start() {
    await this.refresh();
    this._scheduleNext();
  }

  stop() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _scheduleNext() {
    this._timer = setTimeout(() => {
      this.refresh().finally(() => this._scheduleNext());
    }, this.refreshIntervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  async refresh() {
    if (this._refreshing) return;
    this._refreshing = true;
    try {
      const resp = await this.fetchImpl(this.playlistUrl, { redirect: "follow" });
      if (!resp.ok) throw new Error(`playlist HTTP ${resp.status}`);
      const json = await resp.json();
      const items = pickItems(json);

      // Order-preserving dedupe
      const seen = new Set();
      const order = [];
      for (const it of items) {
        const url = pickSourceUrl(it);
        if (typeof url === "string" && url.length > 0 && !seen.has(url)) {
          seen.add(url);
          order.push(url);
        }
      }
      this.playlistOrder = order;

      const results = await Promise.allSettled(
        order.map((url) => fetchAndResolve(url, { fetchImpl: this.fetchImpl }))
      );

      const newResolved = new Map();
      const newFailed = new Map();
      const now = Date.now();
      for (let i = 0; i < order.length; i++) {
        const url = order[i];
        const r = results[i];
        if (r.status === "fulfilled") {
          newResolved.set(url, r.value);
        } else {
          const reason = r.reason?.message || String(r.reason);
          const prev = this.failed.get(url);
          newFailed.set(url, {
            sourceUrl: url,
            reason,
            firstFailedAt: prev?.firstFailedAt || now,
            lastTriedAt: now,
            attempts: (prev?.attempts || 0) + 1,
          });
          this.log.warn?.(`[cache] source failed: ${url} — ${reason}`);
          if (this.failureWebhookUrl && !prev) {
            this._reportFailure(url, reason).catch(() => {});
          }
        }
      }

      this.resolved = newResolved;
      this.failed = newFailed;
      this.lastRefreshAt = now;
      this.lastRefreshError = null;
      this.log.log?.(
        `[cache] refresh: ${newResolved.size} ok, ${newFailed.size} failed`
      );
    } catch (e) {
      this.lastRefreshError = e?.message || String(e);
      this.log.error?.(`[cache] refresh error: ${this.lastRefreshError}`);
    } finally {
      this._refreshing = false;
    }
  }

  async _reportFailure(sourceUrl, reason) {
    await this.fetchImpl(this.failureWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceUrl,
        reason,
        at: new Date().toISOString(),
      }),
    });
  }

  // Scheduler-ready items in playlist order, skipping anything not resolved.
  getActiveItems() {
    const out = [];
    for (const url of this.playlistOrder) {
      const r = this.resolved.get(url);
      if (r) out.push({ sourceUrl: url, duration: r.measuredDuration });
    }
    return out;
  }

  getResolvedItem(sourceUrl) {
    return this.resolved.get(sourceUrl);
  }

  health() {
    return {
      ok: Array.from(this.resolved.values()).map((r) => ({
        sourceUrl: r.sourceUrl,
        baseUrl: r.baseUrl,
        duration: r.measuredDuration,
        fetchedAt: new Date(r.fetchedAt).toISOString(),
      })),
      failed: Array.from(this.failed.values()).map((f) => ({
        ...f,
        firstFailedAt: new Date(f.firstFailedAt).toISOString(),
        lastTriedAt: new Date(f.lastTriedAt).toISOString(),
      })),
      lastRefreshAt: this.lastRefreshAt
        ? new Date(this.lastRefreshAt).toISOString()
        : null,
      lastRefreshError: this.lastRefreshError,
    };
  }
}
