import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  killzoneOf, nyTime, sessionPools, findPoolSweep, ceRespected, singularFvg, chopCount, inversionSpeed,
  premiumDiscount, pdSide, smtState, smtReference, gradeV2,
} from '../src/grade.js';
import { askJevShadow, shadowVerdict, SHADOW_QUESTIONS, SHADOW_PROMPT_VERSION } from '../src/ai.js';
import { TradingBot } from '../src/bot.js';
import { LocalBroker } from '../src/brokers/local.js';
import { MemKV } from './helpers.js';

const M = 60000;
const c = (time, open, high, low, close) => ({ time, open, high, low, close });
const flat = (from, n, step, px = 100) => Array.from({ length: n }, (_, i) => c(from + i * step, px, px + 1, px - 1, px));

// ---- killzones (New York time, daylight saving) ----
test('killzoneOf: New York killzones in summer (EDT) and winter (EST)', () => {
  assert.equal(killzoneOf(Date.UTC(2026, 6, 1, 13, 30)), 'NY AM'); // 09:30 EDT
  assert.equal(killzoneOf(Date.UTC(2026, 11, 1, 14, 30)), 'NY AM'); // 09:30 EST
  assert.equal(killzoneOf(Date.UTC(2026, 11, 1, 13, 45)), null); // 08:45 EST
  assert.equal(killzoneOf(Date.UTC(2026, 6, 1, 6, 0)), 'London'); // 02:00 EDT
  assert.equal(killzoneOf(Date.UTC(2026, 6, 1, 17, 30)), 'NY PM'); // 13:30 EDT
  assert.equal(killzoneOf(Date.UTC(2026, 6, 2, 0, 30)), 'Asia'); // 20:30 EDT the day before
  assert.equal(killzoneOf(Date.UTC(2026, 6, 1, 20, 0)), null); // 16:00 EDT: NY PM is over
  assert.deepEqual(nyTime(Date.UTC(2026, 6, 2, 0, 30)), { date: '2026-07-01', minute: 20 * 60 + 30 });
});

// ---- session pools ----
test('sessionPools: session highs / lows of completed windows, PDH/PDL and PWH/PWL', () => {
  const day = Date.UTC(2026, 9, 20); // Tue 20 Oct 2026, EDT (UTC-4)
  const m15 = flat(day, 96, 15 * M);
  const lon = m15.findIndex((x) => x.time === Date.UTC(2026, 9, 20, 7)); // 03:00 EDT
  m15[lon] = c(m15[lon].time, 100, 101, 95, 100);
  const nyam = m15.findIndex((x) => x.time === Date.UTC(2026, 9, 20, 14)); // 10:00 EDT
  m15[nyam] = c(m15[nyam].time, 100, 108, 99, 100);
  const daily = [c(Date.UTC(2026, 9, 12), 100, 130, 70, 100), c(Date.UTC(2026, 9, 19), 100, 120, 80, 100), c(Date.UTC(2026, 9, 20), 100, 101, 95, 100)];
  const now = Date.UTC(2026, 9, 20, 23, 59);
  const pools = sessionPools(m15, daily, now);
  const by = Object.fromEntries(pools.map((p) => [p.type, p]));
  assert.equal(by.LON_L.price, 95);
  assert.equal(by.LON_L.formedAt, Date.UTC(2026, 9, 20, 9)); // London ends 05:00 EDT = 09:00 UTC
  assert.equal(by.NYAM_H.price, 108);
  assert.equal(by.NYAM_H.formedAt, Date.UTC(2026, 9, 20, 15)); // 11:00 EDT
  assert.ok(by.ASIA_H && by.NYPM_L);
  assert.equal(by.PDH.price, 120);
  assert.equal(by.PDL.price, 80);
  assert.equal(by.PWH.price, 130); // week of Mon 12 Oct
  assert.equal(by.PWL.price, 70);
  // a window still running (no candle after it yet) is not a pool
  assert.equal(sessionPools(m15.filter((x) => x.time < Date.UTC(2026, 9, 20, 8)), [], Date.UTC(2026, 9, 20, 8)).some((p) => p.type === 'LON_L'), false);
});

// ---- pool sweeps, one per pool type ----
const LOWS = ['ASIA_L', 'LON_L', 'NYAM_L', 'NYPM_L', 'PDL', 'PWL'];
const HIGHS = ['ASIA_H', 'LON_H', 'NYAM_H', 'NYPM_H', 'PDH', 'PWH'];
const T0 = Date.UTC(2026, 9, 20, 12);
const sweepCandles = (bull) => {
  const cs = flat(T0, 30, 5 * M);
  cs[20] = bull ? c(cs[20].time, 100, 101, 94, 96) : c(cs[20].time, 100, 106, 99, 104); // wick through, close back
  return cs;
};

for (const type of LOWS) {
  test(`findPoolSweep: bullish sweep of ${type}`, () => {
    const pools = [{ type, side: 'low', price: 95, formedAt: T0 }];
    const s = findPoolSweep(sweepCandles(true), 'bullish', T0 + 15 * 5 * M, pools, { entry: 100 });
    assert.deepEqual(s, { type, price: 95, sweptAt: T0 + 20 * 5 * M, extreme: 94 });
  });
}
for (const type of HIGHS) {
  test(`findPoolSweep: bearish sweep of ${type}`, () => {
    const pools = [{ type, side: 'high', price: 105, formedAt: T0 }];
    const s = findPoolSweep(sweepCandles(false), 'bearish', T0 + 15 * 5 * M, pools, { entry: 100 });
    assert.deepEqual(s, { type, price: 105, sweptAt: T0 + 20 * 5 * M, extreme: 106 });
  });
}

test('findPoolSweep: no sweep when price does not close back, breaks later, was raided before `since` or the pool is on the wrong side', () => {
  const pools = [{ type: 'LON_L', side: 'low', price: 95, formedAt: T0 }];
  const noBack = flat(T0, 30, 5 * M);
  for (let i = 20; i < 30; i++) noBack[i] = c(noBack[i].time, 94, 94.5, 93, 94);
  assert.equal(findPoolSweep(noBack, 'bullish', T0, pools, { entry: 100 }), null);
  const broke = sweepCandles(true);
  broke[25] = c(broke[25].time, 96, 96, 93, 94); // closes back below later: a break
  assert.equal(findPoolSweep(broke, 'bullish', T0, pools, { entry: 100 }), null);
  assert.equal(findPoolSweep(sweepCandles(true), 'bullish', T0 + 25 * 5 * M, pools, { entry: 100 }), null);
  assert.equal(findPoolSweep(sweepCandles(true), 'bullish', T0, pools, { entry: 90 }), null); // pool above a long's entry
  assert.equal(findPoolSweep(sweepCandles(true), 'bullish', T0, [{ ...pools[0], formedAt: T0 + 22 * 5 * M }], { entry: 100 }), null); // raid before the pool existed
});

// ---- CE respect ----
test('ceRespected: no body close beyond the HTF gap CE since the touch', () => {
  const H = 3600000;
  const zone = { type: 'bullish', top: 110, bottom: 100, tappedAt: T0 + 30 * M };
  const cs = [c(T0 - H, 90, 91, 89, 90), c(T0, 112, 112, 103, 106), c(T0 + H, 106, 109, 104, 107)];
  assert.deepEqual(ceRespected(cs, zone, 3600, T0 + 3 * H), { ok: true, ce: 105 });
  cs.push(c(T0 + 2 * H, 107, 107, 101, 104)); // body close under the CE
  assert.equal(ceRespected(cs, zone, 3600, T0 + 3 * H).ok, false);
  assert.equal(ceRespected(cs, zone, 3600, T0 + 2 * H + 30 * M).ok, true); // that candle has not closed yet
  const bear = { type: 'bearish', top: 110, bottom: 100, tappedAt: T0 };
  assert.equal(ceRespected([c(T0, 101, 108, 100, 104)], bear, 3600, T0 + H).ok, true);
  assert.equal(ceRespected([c(T0, 101, 108, 100, 106)], bear, 3600, T0 + H).ok, false);
});

// ---- singular / merge ----
test('singularFvg: one FVG, 2-3 that merge into one on the next timeframe up, or not singular', () => {
  const entry = flat(T0, 10, M);
  const setup = { direction: 'bullish', seriesFvgs: 1, seriesStart: 3, formedIndex: 5 };
  assert.deepEqual(singularFvg(setup, entry, 60, []), { singular: true, merged: false, count: 1 });
  // 2m candles with one bearish FVG whose middle candle (T0+2m) lies inside the leg
  const h = [c(T0, 112, 112, 110, 111), c(T0 + 2 * M, 111, 111, 103, 104), c(T0 + 4 * M, 104, 105, 100, 101), c(T0 + 6 * M, 101, 104, 100, 101)];
  assert.deepEqual(singularFvg({ ...setup, seriesFvgs: 2 }, entry, 60, h), { singular: true, merged: true, count: 2 });
  assert.equal(singularFvg({ ...setup, seriesFvgs: 2 }, entry, 60, flat(T0, 4, 2 * M)).singular, false); // no merged gap
  // two separate gaps on the higher timeframe: still not one FVG
  const h2 = [...h, c(T0 + 8 * M, 99, 99, 95, 96), c(T0 + 10 * M, 96, 96, 90, 91)];
  h2[3] = c(T0 + 6 * M, 101, 101, 100, 100.5);
  const long = flat(T0, 14, M);
  assert.equal(singularFvg({ ...setup, seriesFvgs: 3, formedIndex: 9 }, long, 60, h2).singular, false);
  assert.equal(singularFvg({ ...setup, seriesFvgs: 4 }, entry, 60, h).singular, false); // 4+ never
});

// ---- chop ----
test('chopCount: closes inside the FVG before the inversion close', () => {
  const cs = flat(T0, 10, M, 120);
  const setup = { formedIndex: 2, invertedIndex: 7, bottom: 100, top: 110 };
  assert.equal(chopCount(cs, setup), 0);
  cs[4] = c(cs[4].time, 120, 121, 104, 105);
  cs[6] = c(cs[6].time, 120, 121, 107, 108);
  cs[7] = c(cs[7].time, 108, 121, 100, 109); // the inversion candle itself is not chop
  assert.equal(chopCount(cs, setup), 2);
});

test('inversionSpeed: entry candles from the context candle to the inversion', () => {
  const cs = flat(T0, 10, M);
  assert.equal(inversionSpeed(cs, { invertedIndex: 7 }, T0 + 3 * M + 20000), 4);
  assert.equal(inversionSpeed(cs, { invertedIndex: 7 }, T0 - M), null);
  assert.equal(inversionSpeed(cs, { invertedIndex: 7 }, null), null);
});

// ---- premium / discount ----
const H4 = [[150, 140], [160, 150], [200, 180], [170, 150], [160, 140], [130, 100], [140, 110], [150, 120], [150, 125]]
  .map(([hi, lo], i) => c(T0 + i * 4 * 3600000, lo, hi, lo, hi));
test('premiumDiscount / pdSide: 4h dealing range around the context price', () => {
  const pd = premiumDiscount(H4, 120, 130);
  assert.deepEqual(pd, { high: 200, low: 100, pct: 20, entryPct: 30 });
  assert.deepEqual(pdSide('bullish', pd), { side: 'right', tooFar: false });
  assert.deepEqual(pdSide('bearish', pd), { side: 'wrong', tooFar: false });
  assert.equal(pdSide('bullish', premiumDiscount(H4, 120, 180)).tooFar, true); // entry above the 75% line
  assert.equal(pdSide('bearish', premiumDiscount(H4, 180, 120)).tooFar, true);
  assert.equal(pdSide('bearish', premiumDiscount(H4, 180, 170)).side, 'right');
  assert.equal(premiumDiscount(H4, 250, 250), null); // no swing high above
  assert.deepEqual(pdSide('bullish', null), { side: 'unknown', tooFar: false });
});

// ---- SMT ----
test('smtState: SMT for / against / none, longs and shorts', () => {
  const since = T0 + 30 * 5 * M;
  const mk = (low, high) => { const cs = flat(T0, 40, 5 * M); cs[35] = c(cs[35].time, 100, high, low, 100); return cs; };
  assert.equal(smtState(mk(97, 101), mk(99.5, 101), 'bullish', since), 'for'); // symbol lower low, reference held
  assert.equal(smtState(mk(99.5, 101), mk(97, 101), 'bullish', since), 'against'); // reference lower low, symbol held
  assert.equal(smtState(mk(97, 101), mk(97, 101), 'bullish', since), 'none');
  assert.equal(smtState(mk(99, 103), mk(99, 100.5), 'bearish', since), 'for');
  assert.equal(smtState(mk(99, 100.5), mk(99, 103), 'bearish', since), 'against');
  assert.equal(smtState(mk(97, 101), [], 'bullish', since), null);
  assert.equal(smtReference('BTCUSDC'), 'ETHUSDT');
  assert.equal(smtReference('SOLUSDT'), 'BTCUSDC');
  assert.equal(smtReference('XAUUSDT'), null);
});

// ---- grade v2 mapping ----
test('gradeV2: A+ / A / B / C mapping', () => {
  const ap = { sweep: true, delivery: true, ce: true, displacement: true, singular: true, chop: 0, speed: 3, pd: { side: 'right', tooFar: false }, smt: 'none', targetR: 1.5 };
  assert.equal(gradeV2(ap).grade, 'A+');
  assert.equal(gradeV2({ ...ap, delivery: false }).grade, 'A'); // sweep only
  assert.equal(gradeV2({ ...ap, sweep: false }).grade, 'A'); // delivery only
  assert.equal(gradeV2({ ...ap, ce: false }).grade, 'A');
  assert.equal(gradeV2({ ...ap, chop: 2 }).grade, 'A');
  assert.equal(gradeV2({ ...ap, singular: false }).grade, 'A');
  assert.equal(gradeV2({ ...ap, speed: 7 }).grade, 'A');
  const lifted = gradeV2({ ...ap, chop: 2, singular: false, smt: 'for' });
  assert.equal(lifted.grade, 'A+'); // SMT lifts a choppy / non-singular A
  assert.deepEqual(lifted.smtLift, ['not singular', 'choppy (2)']);
  assert.equal(gradeV2({ ...ap, delivery: false, smt: 'for' }).grade, 'A'); // SMT does not replace the delivery
  assert.equal(gradeV2({ ...ap, chop: 4 }).grade, 'B');
  assert.equal(gradeV2({ ...ap, displacement: false }).grade, 'B');
  assert.equal(gradeV2({ ...ap, speed: 12 }).grade, 'B');
  assert.equal(gradeV2({ ...ap, sweep: false, delivery: false }).grade, 'B');
  assert.equal(gradeV2({ ...ap, targetR: 0.8 }).grade, 'C');
  assert.equal(gradeV2({ ...ap, targetR: null }).grade, 'C');
  assert.equal(gradeV2({ ...ap, pd: { side: 'wrong', tooFar: false } }).grade, 'C');
  assert.equal(gradeV2({ ...ap, pd: { side: 'right', tooFar: true } }).grade, 'C');
  assert.equal(gradeV2({ ...ap, pd: { side: 'unknown', tooFar: false } }).grade, 'C');
  assert.equal(gradeV2({ ...ap, smt: 'against' }).grade, 'C');
});

// ---- Jev shadow ----
test('shadowVerdict: 5-6 full, 3-4 half, 0-2 or event risk skip', () => {
  assert.deepEqual(shadowVerdict({ draw_obvious: 2, narrative_agrees: 2, clean_price_action: 1 }, false), { total: 5, verdict: 'full' });
  assert.equal(shadowVerdict({ draw_obvious: 1, narrative_agrees: 1, clean_price_action: 1 }, false).verdict, 'half');
  assert.equal(shadowVerdict({ draw_obvious: 1, narrative_agrees: 1, clean_price_action: 0 }, false).verdict, 'skip');
  assert.equal(shadowVerdict({ draw_obvious: 2, narrative_agrees: 2, clean_price_action: 2 }, true).verdict, 'skip');
});

const setupFixture = { id: '300:bull-1', direction: 'bullish', category: 'swing', granularity: 300, top: 101, bottom: 100, grade: 'A', qualityReasons: [], v2: { grade: 'B', missing: ['chop 4'], chop: 4 } };
const jevAnswer = (answers) => async () => ({ ok: true, json: async () => ({ answers, model: 'typesafe/jev-1.13', usage: { cost: 0.001 } }) });

test('askJevShadow: sends the fixed schema and parses scores', async () => {
  let sent;
  const reply = jevAnswer({ draw_obvious: { score: 1.7 }, narrative_agrees: { score: 0.4 }, clean_price_action: { score: 2 }, event_risk: { choice: 'NO' } });
  const fetchImpl = async (url, opts) => { sent = JSON.parse(opts.body); return reply(); };
  const r = await askJevShadow({ setup: setupFixture, symbol: 'BTCUSDC' }, { apiKey: 'k', model: 'm' }, fetchImpl);
  assert.deepEqual(Object.keys(sent.questions), Object.keys(SHADOW_QUESTIONS));
  assert.equal(sent.state.setup_grade_v2, 'B');
  assert.deepEqual(r.scores, { draw_obvious: 2, narrative_agrees: 0, clean_price_action: 2 });
  assert.equal(r.total, 4);
  assert.equal(r.verdict, 'half');
  assert.equal(r.promptVersion, SHADOW_PROMPT_VERSION);
  await assert.rejects(askJevShadow({ setup: setupFixture, symbol: 'BTCUSDC' }, { apiKey: 'k', model: 'm' }, jevAnswer({ draw_obvious: { score: 1 } })), /no score/);
});

test('shadowJev: logged once per setup, errors logged too, never with a non-Jev provider', async () => {
  const kv = new MemKV();
  const market = { getCandles: async () => [], getPrice: async () => 100 };
  const mk = (ai, fetchImpl) => new TradingBot({ broker: new LocalBroker({ cash: 10000 }), market, kv, ai, settings: {}, autoStart: false, fetchImpl });
  const ok = mk({ provider: 'jev', apiKey: 'k', model: 'm' }, jevAnswer({ draw_obvious: { score: 2 }, narrative_agrees: { score: 2 }, clean_price_action: { score: 2 }, event_risk: { choice: 'NO' } }));
  const rec = await ok.shadowJev(setupFixture, { granularity: 300 });
  assert.equal(rec.verdict, 'full');
  assert.equal(await ok.shadowJev(setupFixture, { granularity: 300 }), null); // same setup: asked once
  const bad = mk({ provider: 'jev', apiKey: 'k', model: 'm' }, async () => ({ ok: false, status: 402, text: async () => 'no credits' }));
  const err = await bad.shadowJev({ ...setupFixture, id: '300:bull-2' }, { granularity: 300 });
  assert.match(err.error, /402/);
  const log = await kv.get('jev_shadow', []);
  assert.deepEqual(log.map((x) => x.setupId), ['300:bull-2', '300:bull-1']);
  assert.equal(await mk({ provider: 'none', apiKey: '' }, null).shadowJev({ ...setupFixture, id: 'x' }, {}), null);
});
