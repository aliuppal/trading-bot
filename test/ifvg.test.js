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
