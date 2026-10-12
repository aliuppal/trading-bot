import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackRecord, approvedEffects, experienceSuggestions, sessionOf } from '../src/learn.js';
import { buildJevState } from '../src/ai.js';

const NOW = Date.parse('2026-10-12T20:00:00Z');
const trade = (o) => ({ status: 'win', r: 1, model: 'jev', symbol: 'BTCUSDC', side: 'short', category: 'swing', confidence: 0.85, entryTime: '2026-10-10T08:00:00Z', exitTime: '2026-10-10T09:00:00Z', ...o });

test('sessionOf buckets UTC hours', () => {
  assert.equal(sessionOf('2026-10-10T03:00:00Z'), 'Asia');
  assert.equal(sessionOf('2026-10-10T08:00:00Z'), 'London');
  assert.equal(sessionOf('2026-10-10T13:00:00Z'), 'New York');
  assert.equal(sessionOf('2026-10-10T20:00:00Z'), 'late');
});

test('trackRecord: only closed trades of the model within the window, with per-symbol detail', () => {
  const trades = [
    trade({}), trade({ status: 'loss', r: -1, symbol: 'SOLUSDT' }),
    trade({ status: 'open' }), // open: ignored
    trade({ model: 'ifvg' }), // other model: ignored
    trade({ entryTime: '2026-09-01T08:00:00Z', exitTime: '2026-09-01T09:00:00Z' }), // too old
  ];
  const rec = trackRecord(trades, { model: 'jev', symbol: 'SOLUSDT', now: NOW });
  assert.equal(rec.n, 2);
  assert.equal(rec.overall.r, 0);
  assert.match(rec.text, /last 14 days, all symbols: 2 trades, 1 wins \(50%\), \+0\.00R/);
  assert.match(rec.text, /this symbol \(SOLUSDT\): 1 trades, 0 wins \(0%\), -1\.00R/);
  assert.equal(trackRecord([], { model: 'jev', now: NOW }).text, '');
});

test('experienceSuggestions raises the confidence minimum when low-confidence trades lose', () => {
  const trades = [
    ...[0.62, 0.65, 0.61, 0.66].map((c) => trade({ status: 'loss', r: -1, confidence: c })),
    ...[0.82, 0.85, 0.9].map((c) => trade({ confidence: c, r: 1.5 })),
  ];
  const rec = trackRecord(trades, { model: 'jev', now: NOW });
  const c = experienceSuggestions(rec, { minConfidence: 0.6 }).find((x) => x.patch?.minConfidence);
  assert.equal(c.patch.minConfidence, 0.7);
  // too few trades: nothing
  assert.deepEqual(experienceSuggestions(trackRecord(trades.slice(0, 3), { model: 'jev', now: NOW }), { minConfidence: 0.6 }), []);
});

test('approvedEffects compares results before and after an approved change', () => {
  const trades = [
    trade({ status: 'loss', r: -1, entryTime: '2026-10-08T08:00:00Z' }),
    trade({ r: 2, entryTime: '2026-10-11T08:00:00Z' }),
  ];
  const sug = [
    { status: 'approved', model: 'jev', title: 'Raise confidence', patch: { minConfidence: 0.8 }, decidedAt: '2026-10-10T00:00:00Z' },
    { status: 'ignored', model: 'jev', title: 'x', patch: { riskReward: 2 }, decidedAt: '2026-10-10T00:00:00Z' },
  ];
  const fx = approvedEffects(sug, trades, { model: 'jev', now: NOW });
  assert.equal(fx.length, 1);
  assert.equal(fx[0].before.r, -1);
  assert.equal(fx[0].after.r, 2);
});

test('buildJevState passes the track record to Jev only when given', () => {
  const base = { indicators: { price: 1, macd: null, bollinger: null }, account: { cash: 1, btc: 0, avgEntry: 0, equity: 1 }, recentCandles: [], granularity: 300 };
  assert.equal(buildJevState(base).track_record, undefined);
  assert.equal(buildJevState({ ...base, trackRecord: 'last 14 days: 3 trades' }).track_record, 'last 14 days: 3 trades');
});
