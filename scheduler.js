// Pure scheduler — no I/O, no global state.
//
// An `Item` is the minimal scheduling input:
//   { sourceUrl: string, duration: number }   // duration in seconds, > 0
//
// The channel is a fixed loop of items anchored to `epoch` (a wall-clock instant).
// For any `now`, we can deterministically compute which item is playing and where
// in it. Two clients running this math against the same (epoch, items) and a
// reasonably synced clock arrive at the same Period — that is what makes the
// channel "live" across viewers.

function toEpochSeconds(t) {
  const ms = t instanceof Date ? t.getTime() : new Date(t).getTime();
  if (!Number.isFinite(ms)) throw new Error(`invalid time: ${t}`);
  return ms / 1000;
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("items must be a non-empty array");
  }
  for (const it of items) {
    if (typeof it.sourceUrl !== "string" || it.sourceUrl.length === 0) {
      throw new Error("item.sourceUrl must be a non-empty string");
    }
    if (!Number.isFinite(it.duration) || it.duration <= 0) {
      throw new Error(
        `item.duration must be > 0 (got ${it.duration} for ${it.sourceUrl})`
      );
    }
  }
}

function loopDurationOf(items) {
  return items.reduce((s, it) => s + it.duration, 0);
}

// Absolute seconds since epoch where (cycle, itemIndex) starts.
function periodStartSeconds(items, loopDuration, cycle, itemIndex) {
  let offset = 0;
  for (let i = 0; i < itemIndex; i++) offset += items[i].duration;
  return cycle * loopDuration + offset;
}

function periodDescriptor(items, loopDuration, cycle, itemIndex) {
  const item = items[itemIndex];
  const start = periodStartSeconds(items, loopDuration, cycle, itemIndex);
  return {
    id: `${cycle}-${itemIndex}`,
    cycle,
    itemIndex,
    sourceUrl: item.sourceUrl,
    start,
    duration: item.duration,
    end: start + item.duration,
  };
}

function step(items, cycle, itemIndex, dir) {
  const n = items.length;
  if (dir > 0) {
    const next = itemIndex + 1;
    if (next >= n) return { cycle: cycle + 1, itemIndex: 0 };
    return { cycle, itemIndex: next };
  }
  const prev = itemIndex - 1;
  if (prev < 0) return { cycle: cycle - 1, itemIndex: n - 1 };
  return { cycle, itemIndex: prev };
}

/**
 * Returns the item currently playing at `now`.
 * `null` if `now` is before `epoch` (channel hasn't started yet).
 */
export function currentPosition(epoch, items, now) {
  validateItems(items);
  const epochSec = toEpochSeconds(epoch);
  const nowSec = toEpochSeconds(now);
  const elapsed = nowSec - epochSec;
  if (elapsed < 0) return null;

  const loop = loopDurationOf(items);
  const cycle = Math.floor(elapsed / loop);
  const posInCycle = elapsed - cycle * loop;

  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    const next = acc + items[i].duration;
    if (next > posInCycle) {
      return {
        cycle,
        itemIndex: i,
        posInCycle,
        posInItem: posInCycle - acc,
        item: items[i],
      };
    }
    acc = next;
  }
  // Numerical edge (posInCycle === loop): treat as end of last item.
  const last = items.length - 1;
  return {
    cycle,
    itemIndex: last,
    posInCycle,
    posInItem: items[last].duration,
    item: items[last],
  };
}

/**
 * Period descriptors that intersect [now - lookbehindSec, now + lookaheadSec],
 * ordered by start time. Period @id, @start, @duration are deterministic
 * functions of (epoch, items, cycle, itemIndex) — stable across calls so the
 * sliding window can append/drop without renumbering.
 *
 * `clipLastToWindow` (default true): if the last emitted Period extends past
 * `now + lookaheadSec`, its `duration` is truncated to fit. Without this,
 * Shaka treats the manifest's last-Period-end as the live edge and parks the
 * playhead minutes/hours into the future. The Period's full duration grows
 * back on subsequent refreshes as wall-clock advances.
 *
 * Returns [] if `now` is before `epoch`.
 */
export function windowPeriods(epoch, items, now, opts) {
  const lookbehindSec = opts?.lookbehindSec ?? 30;
  const lookaheadSec = opts?.lookaheadSec ?? 30;
  const clipLastToWindow = opts?.clipLastToWindow ?? true;
  if (lookbehindSec < 0 || lookaheadSec < 0) {
    throw new Error("lookbehindSec and lookaheadSec must be >= 0");
  }
  const cur = currentPosition(epoch, items, now);
  if (!cur) return [];

  const epochSec = toEpochSeconds(epoch);
  const nowSec = toEpochSeconds(now);
  const elapsed = nowSec - epochSec;
  const loop = loopDurationOf(items);

  const windowStart = Math.max(0, elapsed - lookbehindSec);
  const windowEnd = elapsed + lookaheadSec;

  let { cycle, itemIndex } = cur;
  while (true) {
    const start = periodStartSeconds(items, loop, cycle, itemIndex);
    if (start <= windowStart) break;
    const prev = step(items, cycle, itemIndex, -1);
    if (prev.cycle < 0) break;
    cycle = prev.cycle;
    itemIndex = prev.itemIndex;
  }

  const out = [];
  while (true) {
    const p = periodDescriptor(items, loop, cycle, itemIndex);
    if (p.start >= windowEnd) break;
    if (p.end > windowStart) out.push(p);
    const nx = step(items, cycle, itemIndex, +1);
    cycle = nx.cycle;
    itemIndex = nx.itemIndex;
  }

  if (clipLastToWindow && out.length > 0) {
    const last = out[out.length - 1];
    if (last.end > windowEnd) {
      const clipped = Math.max(0, windowEnd - last.start);
      out[out.length - 1] = { ...last, duration: clipped, end: last.start + clipped };
    }
  }
  return out;
}

// Exported for tests; not part of the public API.
export const _internal = {
  toEpochSeconds,
  loopDurationOf,
  periodStartSeconds,
  periodDescriptor,
  step,
};
