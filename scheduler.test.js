import test from "node:test";
import assert from "node:assert/strict";
import { currentPosition, windowPeriods, _internal } from "./scheduler.js";

const EPOCH = "2026-01-01T00:00:00Z";
const epochSec = _internal.toEpochSeconds(EPOCH);
const at = (offsetSec) => new Date((epochSec + offsetSec) * 1000);

const ITEMS = [
  { sourceUrl: "https://cdn/a.mpd", duration: 10 },
  { sourceUrl: "https://cdn/b.mpd", duration: 20 },
  { sourceUrl: "https://cdn/c.mpd", duration: 30 },
];
// loop = 60s

test("currentPosition: t=0 → first item, posInItem=0", () => {
  const p = currentPosition(EPOCH, ITEMS, at(0));
  assert.equal(p.cycle, 0);
  assert.equal(p.itemIndex, 0);
  assert.equal(p.posInCycle, 0);
  assert.equal(p.posInItem, 0);
  assert.equal(p.item.sourceUrl, "https://cdn/a.mpd");
});

test("currentPosition: mid-item-1", () => {
  const p = currentPosition(EPOCH, ITEMS, at(15));
  assert.equal(p.itemIndex, 1);
  assert.equal(p.posInItem, 5);
});

test("currentPosition: exact boundary lands on next item", () => {
  // posInCycle = 10 (end of item 0 / start of item 1)
  const p = currentPosition(EPOCH, ITEMS, at(10));
  assert.equal(p.itemIndex, 1);
  assert.equal(p.posInItem, 0);
});

test("currentPosition: cycle wraps", () => {
  // 60s = full loop, +35s into cycle 1 → item 2 (which spans 30..60), 5s into it
  const p = currentPosition(EPOCH, ITEMS, at(60 + 35));
  assert.equal(p.cycle, 1);
  assert.equal(p.itemIndex, 2);
  assert.equal(p.posInItem, 5);
});

test("currentPosition: many cycles later remains deterministic", () => {
  const p = currentPosition(EPOCH, ITEMS, at(60 * 1000 + 12));
  assert.equal(p.cycle, 1000);
  assert.equal(p.itemIndex, 1);
  assert.equal(p.posInItem, 2);
});

test("currentPosition: before epoch returns null", () => {
  const p = currentPosition(EPOCH, ITEMS, at(-5));
  assert.equal(p, null);
});

test("currentPosition: same Period for any t inside it has same (cycle,itemIndex)", () => {
  // Item 1 spans [10, 30) on cycle 0
  for (const offset of [10, 11, 19, 25, 29.999]) {
    const p = currentPosition(EPOCH, ITEMS, at(offset));
    assert.equal(p.cycle, 0);
    assert.equal(p.itemIndex, 1);
  }
});

test("windowPeriods: returns Periods overlapping the window, in order", () => {
  // now = 35s into cycle 0 → item 2 (at 5s into it)
  // window = [35-10, 35+10] = [25, 45]
  // Periods overlapping: item 1 (10..30), item 2 (30..60)
  const ps = windowPeriods(EPOCH, ITEMS, at(35), {
    lookbehindSec: 10,
    lookaheadSec: 10,
    clipLastToWindow: false,
  });
  assert.equal(ps.length, 2);
  assert.equal(ps[0].itemIndex, 1);
  assert.equal(ps[0].start, 10);
  assert.equal(ps[0].duration, 20);
  assert.equal(ps[1].itemIndex, 2);
  assert.equal(ps[1].start, 30);
  assert.equal(ps[1].duration, 30);
});

test("windowPeriods: Period @start and @id are stable across `now` advancing within the same Period", () => {
  // now = 12 and now = 25 are both inside item 1 (cycle 0)
  const a = windowPeriods(EPOCH, ITEMS, at(12), {
    lookbehindSec: 30,
    lookaheadSec: 30,
  });
  const b = windowPeriods(EPOCH, ITEMS, at(25), {
    lookbehindSec: 30,
    lookaheadSec: 30,
  });
  // Find the Period for item 1 cycle 0 in both
  const findItem1 = (ps) => ps.find((p) => p.id === "0-1");
  assert.deepEqual(findItem1(a).start, findItem1(b).start);
  assert.equal(findItem1(a).id, findItem1(b).id);
  assert.equal(findItem1(a).duration, findItem1(b).duration);
});

test("windowPeriods: lookbehind clipped at epoch (no negative starts)", () => {
  const ps = windowPeriods(EPOCH, ITEMS, at(5), {
    lookbehindSec: 1000,
    lookaheadSec: 5,
  });
  assert.ok(ps.length > 0);
  assert.equal(ps[0].cycle, 0);
  assert.equal(ps[0].itemIndex, 0);
  assert.equal(ps[0].start, 0);
});

test("windowPeriods: spans cycle boundary correctly", () => {
  // now = 58s; window [53, 65] — should include last item of cycle 0 and first of cycle 1
  const ps = windowPeriods(EPOCH, ITEMS, at(58), {
    lookbehindSec: 5,
    lookaheadSec: 7,
  });
  // item 2 cycle 0 (30..60) overlaps; item 0 cycle 1 (60..70) overlaps
  assert.deepEqual(
    ps.map((p) => p.id),
    ["0-2", "1-0"]
  );
  assert.equal(ps[1].start, 60);
});

test("windowPeriods: before epoch returns []", () => {
  assert.deepEqual(
    windowPeriods(EPOCH, ITEMS, at(-100), { lookbehindSec: 0, lookaheadSec: 30 }),
    []
  );
});

test("windowPeriods: zero lookbehind/lookahead returns just the current Period", () => {
  const ps = windowPeriods(EPOCH, ITEMS, at(15), {
    lookbehindSec: 0,
    lookaheadSec: 0,
    clipLastToWindow: false,
  });
  // window = [15, 15]; this is a degenerate window (empty interval)
  // Strictly: a Period overlaps [a,a) iff start <= a < end. For now=15, item 1 (10..30) qualifies.
  assert.equal(ps.length, 1);
  assert.equal(ps[0].id, "0-1");
});

test("windowPeriods: clipLastToWindow truncates last period's duration", () => {
  // now = 12 (inside item 1), lookahead = 5 → windowEnd = 17.
  // Item 1 spans [10, 30] → clipped to duration 7 (17 - 10).
  const ps = windowPeriods(EPOCH, ITEMS, at(12), {
    lookbehindSec: 0,
    lookaheadSec: 5,
  });
  assert.equal(ps[ps.length - 1].duration, 7);
  assert.equal(ps[ps.length - 1].end, 17);
  // @start unchanged → Period identity is stable
  assert.equal(ps[ps.length - 1].start, 10);
});

test("windowPeriods: clipLastToWindow=false keeps full duration", () => {
  const ps = windowPeriods(EPOCH, ITEMS, at(12), {
    lookbehindSec: 0,
    lookaheadSec: 5,
    clipLastToWindow: false,
  });
  assert.equal(ps[ps.length - 1].duration, 20); // item 1's full duration
});

test("validation: empty items rejected", () => {
  assert.throws(() => currentPosition(EPOCH, [], at(0)));
});

test("validation: zero/negative duration rejected", () => {
  assert.throws(() =>
    currentPosition(EPOCH, [{ sourceUrl: "x", duration: 0 }], at(0))
  );
  assert.throws(() =>
    currentPosition(EPOCH, [{ sourceUrl: "x", duration: -5 }], at(0))
  );
});

test("validation: negative lookbehind rejected", () => {
  assert.throws(() =>
    windowPeriods(EPOCH, ITEMS, at(0), { lookbehindSec: -1, lookaheadSec: 0 })
  );
});

test("Period @start formula: cycle*loop + sum(durations[0..i-1])", () => {
  // (cycle=2, item=2) → 2*60 + 10 + 20 = 150
  const p = _internal.periodDescriptor(
    ITEMS,
    _internal.loopDurationOf(ITEMS),
    2,
    2
  );
  assert.equal(p.start, 150);
  assert.equal(p.id, "2-2");
});
