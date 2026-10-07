import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFvgs, findIfvgs, latestSetup, bracketLong } from '../src/ifvg.js';
import { ifvgCandles, makeCandles } from './helpers.js';

test('findFvgs finds the bearish gap and its inversion', () => {
  const c = ifvgCandles();
  const fvgs = findFvgs(c);
  assert.equal(fvgs.length, 1);
  assert.equal(fvgs[0].type, 'bearish');
  assert.equal(fvgs[0].bottom, 59500);
  assert.equal(fvgs[0].top, 59950);
  assert.equal(fvgs[0].invertedIndex, c.length - 1);
});

test('findIfvgs labels an inverted bearish FVG as a bullish IFVG', () => {
  const [z] = findIfvgs(ifvgCandles());
  assert.equal(z.direction, 'bullish');
});

test('latestSetup returns the fresh IFVG and ignores stale ones', () => {
  const c = ifvgCandles();
  assert.equal(latestSetup(c).direction, 'bullish');
  const later = [...c];
  for (let i = 0; i < 5; i++) later.push({ ...c.at(-1), time: c.at(-1).time + (i + 1) * 900000 });
  assert.equal(latestSetup(later, { maxAge: 3 }), null);
  assert.equal(latestSetup(makeCandles(60)), null);
});

test('bracketLong is 1:1 with the stop under the zone', () => {
  const b = bracketLong(60100, { bottom: 59500, top: 59950 });
  assert.ok(b.stop < 59500);
  assert.equal(b.rr, 1);
  assert.ok(Math.abs((60100 - b.stop) - (b.target - 60100)) < 0.02);
  assert.equal(bracketLong(59000, { bottom: 59500, top: 59950 }), null);
});

test('bearish IFVG is a short setup with a 1:1 bracket above the zone', async () => {
  const { bearishIfvgCandles } = await import('./helpers.js');
  const { bracketShort } = await import('../src/ifvg.js');
  const z = latestSetup(bearishIfvgCandles(Date.UTC(2026, 9, 7, 12)));
  assert.equal(z.direction, 'bearish');
  const b = bracketShort(59900, z);
  assert.ok(b.stop > z.top);
  assert.ok(Math.abs((b.stop - 59900) - (59900 - b.target)) < 0.02);
  assert.equal(bracketShort(61000, z), null);
});

test('strict inversion: a weak close just through the gap does not count', async () => {
  const { ifvgCandles } = await import('./helpers.js');
  const c = ifvgCandles(Date.UTC(2026, 9, 7, 12));
  // gap 59,500-59,950 (height 450): a close of 59,960 is beyond the top by only 10 (< 20% = 90)
  c[c.length - 1] = { ...c.at(-1), close: 59960, high: 59990 };
  assert.equal(latestSetup(c), null);
});

test('strict inversion: a gap older than 30 candles is ignored', async () => {
  const { ifvgCandles } = await import('./helpers.js');
  const c = ifvgCandles(Date.UTC(2026, 9, 7, 12));
  const inv = c.pop();
  const H = 900000;
  // 35 quiet candles below the gap before the inversion
  for (let i = 0; i < 35; i++) c.push({ time: c.at(-1).time + H, open: 59100, high: 59200, low: 59000, close: 59100, volume: 1 });
  c.push({ ...inv, time: c.at(-1).time + H });
  assert.equal(latestSetup(c, { maxAge: 5 }), null);
});

test('displacement (optional): required only when switched on', async () => {
  const { ifvgCandles } = await import('./helpers.js');
  const c = ifvgCandles(Date.UTC(2026, 9, 7, 12));
  assert.equal(latestSetup(c, { displacement: true })?.displacement, true); // 1,000 body vs ~10 average
  const weak = c.map((x) => ({ ...x }));
  // make recent candles as big as the inversion candle: no longer a displacement
  for (let i = weak.length - 21; i < weak.length - 4; i++) weak[i] = { ...weak[i], open: 59000, close: 60000, high: 60010, low: 58990 };
  assert.equal(latestSetup(weak, { displacement: true }), null);
  assert.ok(latestSetup(weak, { displacement: false }));
});

test('IFVG formation must take at most 3-7 candles (gap -> inversion)', async () => {
  const { ifvgCandles } = await import('./helpers.js');
  const build = (quiet) => {
    const c = ifvgCandles(Date.UTC(2026, 9, 7, 12));
    const inv = c.pop();
    for (let i = 0; i < quiet; i++) c.push({ time: c.at(-1).time + 900000, open: 59100, high: 59200, low: 59000, close: 59100, volume: 1 });
    c.push({ ...inv, time: c.at(-1).time + 900000 });
    return c;
  };
  // middle candle -> inversion: 2 + quiet candles
  assert.equal(latestSetup(build(4), { maxGapAge: 7 })?.formationCandles, 6);
  assert.equal(latestSetup(build(6), { maxGapAge: 7 }), null); // 8 candles: too slow
  assert.equal(latestSetup(build(4), { maxGapAge: 5 }), null); // 6 candles with a 5-candle limit
});

test('HTF FVG tap counts only on the first touch (unmitigated)', async () => {
  const { findHtfTap } = await import('../src/ifvg.js');
  const H = 3600000;
  const zone = { tf: '1h', type: 'bullish', top: 105, bottom: 100, readyAt: 0, firstTouchEnd: 5 * H };
  const tapAt = (t) => [{ time: t, open: 108, high: 108, low: 104, close: 107 }];
  assert.ok(findHtfTap(tapAt(4.5 * H), [zone], 'bullish'), 'inside the first-touch candle: valid');
  assert.equal(findHtfTap(tapAt(6 * H), [zone], 'bullish'), null, 'later re-tap of a mitigated FVG: rejected');
  assert.ok(findHtfTap(tapAt(6 * H), [{ ...zone, firstTouchEnd: null }], 'bullish'));
});
