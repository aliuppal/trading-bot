import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSetups } from '../src/strategy.js';
import { aggregate, formingIfvg } from '../src/ifvg.js';
import { ifvgCandles } from './helpers.js';

const NOW = Date.UTC(2026, 9, 7, 12);
const H1 = 3600000;
const flat = (time, p = 60000) => ({ time, open: p, high: p + 50, low: p - 50, close: p, volume: 1 });

/** 1h candles with an active bullish FVG at 58,700-59,200 (formed ~10h ago), then flat around 60,000. */
function h1WithBullishFvg() {
  const rows = [];
  for (let i = 40; i > 11; i--) rows.push(flat(NOW - i * H1, 58500));
  rows.push({ time: NOW - 11 * H1, open: 58500, high: 58700, low: 58400, close: 58650, volume: 1 }); // a
  rows.push({ time: NOW - 10 * H1, open: 58650, high: 59900, low: 58600, close: 59850, volume: 1 }); // displacement up
  rows.push({ time: NOW - 9 * H1, open: 59850, high: 60100, low: 59200, close: 60000, volume: 1 }); // c: a.high < c.low
  for (let i = 8; i >= 1; i--) rows.push(flat(NOW - i * H1));
  return rows;
}

/** 15m candles whose still-open last candle is breaking above a bearish FVG (a bullish IFVG forming). */
function forming15m() {
  const closed = ifvgCandles(NOW).slice(0, -1); // drop the inversion candle: the bearish FVG stays active
  const last = closed.at(-1);
  return [...closed, { time: NOW - 60000, open: last.close, high: 60150, low: last.close - 10, close: 60100, volume: 1 }];
}

const market = (byTf) => ({ getCandles: async (g) => byTf[g] ?? byTf.default });

test('aggregate builds 2h candles from 1h', () => {
  const h = [0, 1, 2, 3].map((i) => ({ time: i * H1, open: i, high: i + 1, low: i - 1, close: i + 0.5, volume: 1 }));
  const two = aggregate(h, 7200);
  assert.equal(two.length, 2);
  assert.deepEqual(two[0], { time: 0, open: 0, high: 2, low: -1, close: 1.5, volume: 2 });
});

test('bullish IFVG after a tap of a bullish 1h FVG is a setup', async () => {
  const r = await scanSetups(market({ 3600: h1WithBullishFvg(), default: ifvgCandles(NOW) }),
    { entryTimeframes: '900', ifvgMaxAge: 5 }, NOW);
  assert.equal(r.setup?.direction, 'bullish', r.note);
  assert.equal(r.setup.htf.tf, '1h');
  assert.equal(r.setup.htf.type, 'bullish');
  assert.equal(r.setup.granularity, 900);
});

test('no same-direction HTF FVG tap means no setup', async () => {
  const flatH1 = Array.from({ length: 40 }, (_, i) => flat(NOW - (40 - i) * H1, 65000));
  const r = await scanSetups(market({ 3600: flatH1, default: ifvgCandles(NOW) }), { entryTimeframes: '900' }, NOW);
  assert.equal(r.setup, null);
  assert.match(r.note, /no bullish 1h\/2h\/4h FVG tap/);
});

test('formingIfvg sees a bullish IFVG in the still-open candle', () => {
  assert.equal(formingIfvg(forming15m(), 900, 'bullish', NOW)?.direction, 'bullish');
  assert.equal(formingIfvg(ifvgCandles(NOW), 900, 'bullish', NOW), null); // last candle already closed
});

test('5m IFVG waits while a 15m IFVG is forming in the same direction', async () => {
  const r = await scanSetups(market({ 300: ifvgCandles(NOW), 900: forming15m() }),
    { entryTimeframes: 'both', requireHtfTap: false }, NOW);
  assert.equal(r.setup, null);
  assert.equal(r.waiting, true);
  assert.match(r.note, /5m bullish IFVG ready, waiting for the 15m IFVG/);
});

test('5m IFVG is taken directly when nothing is forming on 15m', async () => {
  const quiet15 = Array.from({ length: 50 }, (_, i) => flat(NOW - (50 - i) * 900000 - 1000));
  const r = await scanSetups(market({ 300: ifvgCandles(NOW), 900: quiet15 }),
    { entryTimeframes: 'both', requireHtfTap: false }, NOW);
  assert.equal(r.setup?.granularity, 300, r.note);
  assert.equal(r.waiting, false);
});

test('a confirmed 15m IFVG wins over 5m', async () => {
  const r = await scanSetups(market({ default: ifvgCandles(NOW) }), { entryTimeframes: 'both', requireHtfTap: false }, NOW);
  assert.equal(r.setup?.granularity, 900);
});
