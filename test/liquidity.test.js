import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swings, equalLevels, lrlr, liquidityTarget, liquidityLevels } from '../src/liquidity.js';

const bar = (t, h, l) => ({ time: t * 900000, open: (h + l) / 2, high: h, low: l, close: (h + l) / 2, volume: 1 });

test('swings and equal highs: two untaken highs within 0.05% are EQH', () => {
  const c = [bar(0, 100, 95), bar(1, 101, 96), bar(2, 105, 97), bar(3, 101, 96), bar(4, 100, 95),
    bar(5, 101, 96), bar(6, 105.02, 97), bar(7, 101, 96), bar(8, 100, 95)];
  const s = swings(c, 2);
  assert.equal(s.highs.length, 2);
  const eq = equalLevels(c, s.highs, 'high');
  assert.equal(eq.length, 1);
  assert.equal(eq[0].price, 105.02);
  assert.equal(eq[0].touches, 2);
});

test('a swept high is not liquidity any more', () => {
  const c = [bar(0, 100, 95), bar(1, 101, 96), bar(2, 105, 97), bar(3, 101, 96), bar(4, 100, 95),
    bar(5, 101, 96), bar(6, 105.02, 97), bar(7, 101, 96), bar(8, 106, 95)];
  assert.equal(equalLevels(c, swings(c, 2).highs, 'high').length, 0);
});

test('LRLR: three stepped (lower) highs above price', () => {
  const highs = [{ price: 110, index: 0 }, { price: 108, index: 1 }, { price: 106, index: 2 }];
  const c = [bar(0, 110, 90), bar(1, 108, 90), bar(2, 106, 90)];
  const r = lrlr(c, { highs, lows: [] }, 100);
  assert.equal(r.side, 'above');
  assert.equal(r.target, 110);
});

test('liquidity target: nearest level 1R-5R away in the trade direction', () => {
  const liq = { above: [{ price: 100.5, type: 'EQH' }, { price: 103, type: 'PDH' }], below: [{ price: 99, type: 'PDL' }] };
  assert.equal(liquidityTarget(liq, 'long', 100, 1).level.type, 'PDH'); // 0.5R too close, 3R ok
  assert.equal(liquidityTarget(liq, 'short', 100, 1).level.type, 'PDL'); // 1R
  assert.equal(liquidityTarget(liq, 'short', 100, 2), null); // 0.5R only
});

test('liquidityLevels finds previous day high / low', async () => {
  const day = 86400000;
  const now = Date.UTC(2026, 9, 7, 12);
  const daily = [{ time: now - 2 * day, open: 1, high: 120, low: 80, close: 100 }, { time: now - day, open: 100, high: 110, low: 90, close: 100 }];
  const flat = (step) => Array.from({ length: 50 }, (_, i) => ({ time: now - (50 - i) * step, open: 100, high: 101, low: 99, close: 100 }));
  const market = { getCandles: async (g) => (g === 86400 ? daily : flat(g * 1000)) };
  const l = await liquidityLevels(market, now);
  assert.ok(l.above.some((x) => x.type.includes('PDH') && x.price === 110));
  assert.ok(l.below.some((x) => x.type.includes('PDL') && x.price === 90));
});

test('liquidity target sits on the LRLR swing low / EQL, even below 1R', () => {
  // the case from the chart: short 83,291 with stop 83,502 (risk 211), LRLR / equal lows at 83,098 (~0.9R)
  const liq = { below: [{ type: 'EQL', price: 83098 }], above: [], lrlr: { side: 'below', prices: [83098, 83140] } };
  const t = liquidityTarget(liq, 'short', 83291.4, 210.43);
  assert.ok(t, 'target found');
  assert.equal(t.price, 83098); // at the liquidity level itself
  assert.ok(t.r >= 0.75 && t.r < 1);
});
