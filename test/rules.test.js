// Strategy v2 phase 2: every section-3 rule behind its own switch (all off = today's behaviour).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eqPools, keyOpens, openBias, applyV2Rules, corrCapHit, dailyR, cooldownUntil, stopV2Level, invalidationCandle, limitEntryPrice,
} from '../src/grade.js';
import { TradingBot, V2_SWITCHES } from '../src/bot.js';
import { LocalBroker } from '../src/brokers/local.js';
import { MemKV } from './helpers.js';

const M = 60000;
const H = 3600000;
const c = (time, open, high, low, close) => ({ time, open, high, low, close });
const flat = (from, n, step, px = 100) => Array.from({ length: n }, (_, i) => c(from + i * step, px, px + 1, px - 1, px));
const T0 = Date.UTC(2026, 9, 20, 12); // Tue 20 Oct 2026 08:00 New York (EDT)

// ---- pools ----
test('eqPools: equal highs / lows resting before the sweep window', () => {
  const cs = flat(T0, 30, 5 * M);
  cs[5] = c(cs[5].time, 100, 105, 99, 100);
  cs[12] = c(cs[12].time, 100, 105.02, 99, 100); // within 0.05%
  cs[8] = c(cs[8].time, 100, 101, 95, 100);
  cs[16] = c(cs[16].time, 100, 101, 95.01, 100);
  const since = T0 + 22 * 5 * M;
  const pools = eqPools(cs, since);
  assert.deepEqual(pools.map((p) => [p.type, p.side, p.formedAt]), [['EQH', 'high', since], ['EQL', 'low', since]]);
  assert.equal(pools[0].price, 105.02);
  assert.equal(pools[1].price, 95);
  assert.deepEqual(eqPools(cs.slice(0, 5), since), []);
});

test('keyOpens / openBias: midnight (New York) and day (UTC) open as a bias line', () => {
  const day = Date.UTC(2026, 9, 20);
  const cs = flat(day, 64, 15 * M);
  cs[0] = c(day, 90, 91, 89, 90); // 00:00 UTC = day open
  const mid = cs.findIndex((x) => x.time === Date.UTC(2026, 9, 20, 4)); // 00:00 EDT
  cs[mid] = c(cs[mid].time, 110, 111, 109, 110);
  const opens = keyOpens(cs, Date.UTC(2026, 9, 20, 15));
  assert.deepEqual(opens, { midnight: 110, day: 90 });
  assert.equal(openBias('bullish', 85, opens), 'with');
  assert.equal(openBias('bullish', 115, opens), 'against');
  assert.equal(openBias('bullish', 100, opens), 'mixed');
  assert.equal(openBias('bearish', 115, opens), 'with');
  assert.equal(openBias('bearish', 85, opens), 'against');
  assert.equal(openBias('bullish', 100, { midnight: null, day: null }), 'mixed');
});

// ---- grade / skip rules ----
const v2ok = { grade: 'A+', missing: [], ce: true, singular: true, fvgCount: 1, chop: 0, speed: 3, pd: { side: 'right', tooFar: false }, pdPct: 30, pdEntryPct: 40, smt: 'none' };
const su = (v2 = {}, grade = 'A+') => ({ direction: 'bullish', grade, v2: { ...v2ok, ...v2 } });
const IN_KZ = Date.UTC(2026, 9, 20, 14); // 10:00 New York, NY AM
const NY_PM = Date.UTC(2026, 9, 20, 18); // 14:00 New York, NY PM
const DEAD = Date.UTC(2026, 9, 20, 21); // 17:00 New York, no killzone

test('applyV2Rules: every switch off changes nothing', () => {
  const bad = su({ grade: 'C', ce: false, singular: false, chop: 6, speed: 30, pd: { side: 'wrong', tooFar: true }, smt: 'against' });
  assert.deepEqual(applyV2Rules(bad, {}, { now: DEAD, price: 1 }), { grade: 'A+', skip: null, notes: [] });
});

test('applyV2Rules: gradeV2 uses the v2 grade, B logged only, C skipped', () => {
  assert.equal(applyV2Rules(su({ grade: 'A' }, 'A+'), { gradeV2: true }).grade, 'A');
  assert.equal(applyV2Rules(su({ grade: 'A+' }, 'A'), { gradeV2: true }).grade, 'A+');
  assert.match(applyV2Rules(su({ grade: 'B', missing: ['chop 4'] }), { gradeV2: true }).skip, /v2 grade B \(chop 4\), logged only/);
  assert.match(applyV2Rules(su({ grade: 'C', missing: ['SMT against'] }), { gradeV2: true }).skip, /v2 grade C/);
});

test('applyV2Rules: CE, singular, chop and speed caps and skips', () => {
  assert.equal(applyV2Rules(su({ ce: false }), { ceCheck: true }).grade, 'A');
  assert.equal(applyV2Rules(su({ ce: null }), { ceCheck: true }).grade, 'A+'); // no tap: nothing to check
  assert.equal(applyV2Rules(su({ singular: false, fvgCount: 2 }), { singularCheck: true }).grade, 'A');
  assert.equal(applyV2Rules(su({ chop: 2 }), { chopCheck: true }).grade, 'A');
  assert.equal(applyV2Rules(su({ chop: 1 }), { chopCheck: true }).grade, 'A+');
  assert.match(applyV2Rules(su({ chop: 4 }), { chopCheck: true }).skip, /chop 4/);
  assert.equal(applyV2Rules(su({ speed: 7 }), { speedCheck: true }).grade, 'A');
  assert.match(applyV2Rules(su({ speed: 11 }), { speedCheck: true }).skip, /11 candles/);
  const r = applyV2Rules(su({ ce: false }), { ceCheck: true });
  assert.deepEqual(r.notes, ['A+ -> A: a body closed beyond the HTF gap CE']);
});

test('applyV2Rules: premium / discount', () => {
  assert.equal(applyV2Rules(su(), { pdCheck: true }).skip, null);
  assert.match(applyV2Rules(su({ pd: { side: 'wrong', tooFar: false }, pdPct: 62 }), { pdCheck: true }).skip, /long context in premium \(62%\)/);
  assert.match(applyV2Rules(su({ pd: { side: 'right', tooFar: true }, pdEntryPct: 80 }), { pdCheck: true }).skip, /too far into premium \(80%\)/);
  assert.match(applyV2Rules(su({ pd: { side: 'unknown', tooFar: false } }), { pdCheck: true }).skip, /unknown/);
  assert.match(applyV2Rules({ direction: 'bullish', grade: 'A' }, { pdCheck: true }).skip, /unknown/); // v2 inputs missing
});

test('applyV2Rules: SMT veto and bonus', () => {
  assert.equal(applyV2Rules(su({ smt: 'against' }), { smtV2: true }).skip, 'SMT against the trade');
  // SMT for the trade waives the chop / singular caps, not the others
  assert.equal(applyV2Rules(su({ smt: 'for', chop: 3, singular: false }), { smtV2: true, chopCheck: true, singularCheck: true }).grade, 'A+');
  assert.equal(applyV2Rules(su({ smt: 'none', chop: 3 }), { smtV2: true, chopCheck: true }).grade, 'A');
  assert.equal(applyV2Rules(su({ smt: 'for', ce: false }), { smtV2: true, ceCheck: true }).grade, 'A');
  assert.equal(applyV2Rules(su({ smt: 'against' }), {}).skip, null); // switch off: no veto
});

test('applyV2Rules: midnight / day open bias', () => {
  const opens = { midnight: 110, day: 105 };
  assert.equal(applyV2Rules(su(), { openBias: true }, { opens, price: 112 }).grade, 'A');
  assert.equal(applyV2Rules(su(), { openBias: true }, { opens, price: 100 }).grade, 'A+');
});

test('applyV2Rules: killzone test (A only in killzones, A+ any time)', () => {
  assert.match(applyV2Rules(su({}, 'A'), { killzoneTest: true }, { now: DEAD }).skip, /outside the London \/ NY AM \/ NY PM/);
  assert.equal(applyV2Rules(su({}, 'A'), { killzoneTest: true }, { now: IN_KZ }).skip, null);
  assert.equal(applyV2Rules(su({}, 'A'), { killzoneTest: true }, { now: NY_PM }).skip, null);
  assert.equal(applyV2Rules(su({}, 'A+'), { killzoneTest: true }, { now: DEAD }).skip, null);
  // a capped A+ is an A for the killzone test
  assert.match(applyV2Rules(su({ chop: 2 }), { killzoneTest: true, chopCheck: true }, { now: DEAD }).skip, /A setup outside/);
});

// ---- portfolio filters ----
const tr = (o) => ({ symbol: 'BTCUSDC', side: 'long', status: 'open', ...o });
test('corrCapHit: at most 2 same-direction trades in the crypto cluster, gold separate', () => {
  const open = [tr({ symbol: 'BTCUSDC' }), tr({ symbol: 'ETHUSDT' }), tr({ symbol: 'XAUUSDT' }), tr({ symbol: 'SOLUSDT', status: 'win' })];
  assert.equal(corrCapHit(open, 'DOGEUSDT', 'long'), 2);
  assert.equal(corrCapHit(open, 'DOGEUSDT', 'short'), 0);
  assert.equal(corrCapHit(open, 'XAUUSDT', 'long'), 0); // one gold long, its own cluster
  assert.equal(corrCapHit([tr({ symbol: 'BTCUSDC' })], 'ETHUSDT', 'long'), 0);
  assert.equal(corrCapHit([tr({ symbol: 'BTCUSDC' }), tr({ symbol: 'BNBUSDT', status: 'pending' })], 'ETHUSDT', 'long'), 2);
});

test('dailyR / cooldownUntil: daily loss in R and the 4 h cooldown after 2 losses', () => {
  const now = Date.UTC(2026, 9, 20, 15);
  const closed = (exit, r, symbol = 'BTCUSDC') => ({ symbol, status: r > 0 ? 'win' : 'loss', r, exitTime: new Date(exit).toISOString() });
  const list = [closed(now - 2 * H, -1), closed(now - 3 * H, -1.2, 'ETHUSDT'), closed(now - 26 * H, -5), closed(now - H, 0.5, 'SOLUSDT'), tr({ r: -9 })];
  assert.equal(dailyR(list, now), -1.7); // yesterday's -5R and the open trade do not count
  const two = [closed(now - H, -1), closed(now - 2 * H, -1), closed(now - 3 * H, 2)];
  assert.equal(cooldownUntil(two, 'BTCUSDC', now), now + 3 * H);
  assert.equal(cooldownUntil(two, 'BTCUSDC', now + 3 * H), 0); // over
  assert.equal(cooldownUntil(two, 'ETHUSDT', now), 0);
  assert.equal(cooldownUntil([closed(now - H, -1), closed(now - 2 * H, 1)], 'BTCUSDC', now), 0); // one loss only
});

// ---- bracket rules ----
test('stopV2Level: beyond the nearer of raid / swing, plus 0.1 ATR; never inside the gap', () => {
  const long = { direction: 'bullish', top: 105, bottom: 100, atr: 10, swingStop: 95, sweep: { extreme: 97 } };
  assert.equal(stopV2Level(long), 96); // raid 97 is nearer than the swing 95
  assert.equal(stopV2Level({ ...long, sweep: null, v2: { poolSwept: { extreme: 98 } } }), 97); // pool raid 98 is nearer than the swing 95
  assert.equal(stopV2Level({ ...long, swingStop: 102, sweep: null }), 99); // swing inside the gap: from the gap edge
  const short = { direction: 'bearish', top: 105, bottom: 100, atr: 10, swingStop: 109, sweep: { extreme: 107 } };
  assert.equal(stopV2Level(short), 108);
  assert.equal(stopV2Level({ ...long, atr: null }), null);
});

test('invalidationCandle: body close back through the far side of the IFVG after the entry', () => {
  const entry = T0 + 10 * M;
  const trade = { side: 'long', entryTime: new Date(entry).toISOString(), ifvg: { top: 105, bottom: 100 } };
  const cs = flat(T0, 20, M, 103);
  assert.equal(invalidationCandle(cs, trade, 60, T0 + 20 * M), null);
  cs[8] = c(cs[8].time, 99, 99.5, 98, 99); // before the entry: ignored
  cs[14] = c(cs[14].time, 101, 101, 97, 99.5); // opened above the bottom: body not fully below
  assert.equal(invalidationCandle(cs, trade, 60, T0 + 20 * M), null);
  cs[15] = c(cs[15].time, 99.8, 100.5, 97, 98); // body below the bottom
  assert.equal(invalidationCandle(cs, trade, 60, T0 + 20 * M).time, cs[15].time);
  assert.equal(invalidationCandle(cs, trade, 60, T0 + 15 * M + 30000), null); // not closed yet
  const short = { ...trade, side: 'short' };
  const cs2 = flat(T0, 20, M, 103);
  cs2[12] = c(cs2[12].time, 105.5, 107, 105.2, 106);
  assert.equal(invalidationCandle(cs2, short, 60, T0 + 20 * M).time, cs2[12].time);
});

test('limitEntryPrice: limit at the IFVG edge when price is more than 40% of the stop away', () => {
  const setup = { top: 104, bottom: 100 };
  assert.equal(limitEntryPrice('long', 112, setup, 95), 104); // 8 > 0.4 x 17
  assert.equal(limitEntryPrice('long', 106, setup, 95), null); // 2 < 0.4 x 11
  assert.equal(limitEntryPrice('short', 92, setup, 109), 100); // 8 > 0.4 x 17
  assert.equal(limitEntryPrice('short', 99, setup, 109), null);
});

// ---- bot wiring ----
function mkBot(settings = {}, market = {}) {
  const kv = new MemKV();
  const getPrice = async () => 100;
  const broker = new LocalBroker({ kv, startingCash: 10000, getPrice });
  const bot = new TradingBot({ broker, market: { getCandles: async () => [], getPrice, ...market }, kv, ai: { provider: 'none', apiKey: '' }, settings, autoStart: false });
  return { bot, kv };
}

test('V2_SWITCHES are all off in the defaults and saved by updateSettings', async () => {
  const { bot } = mkBot();
  for (const k of V2_SWITCHES) assert.ok(!bot.settings[k], `${k} should be off by default`);
  await bot.updateSettings({ gradeV2: 'true', pdCheck: true, dailyStopR: '3', minTargetR: '1' });
  assert.equal(bot.settings.gradeV2, true);
  assert.equal(bot.settings.pdCheck, true);
  assert.equal(bot.settings.dailyStopR, 3);
  assert.equal(bot.settings.minTargetR, 1);
  await bot.updateSettings({ gradeV2: 'false', minTargetR: '9' });
  assert.equal(bot.settings.gradeV2, false);
  assert.equal(bot.settings.minTargetR, 3); // clamped
});

test('riskUsd: A+ full risk, A half, only with riskByGrade on', () => {
  const { bot } = mkBot({ riskPerTradeUsd: 100 });
  assert.equal(bot.riskUsd({ grade: 'A' }), 100);
  bot.settings.riskByGrade = true;
  assert.equal(bot.riskUsd({ grade: 'A+' }), 100);
  assert.equal(bot.riskUsd({ grade: 'A' }), 50);
});

test('stopZone: stopV2 replaces the stop edge; off keeps the zone / swing stop', () => {
  const { bot } = mkBot({ stopMode: 'swing' });
  const setup = { direction: 'bullish', top: 105, bottom: 100, atr: 10, swingStop: 95, sweep: { extreme: 97 } };
  assert.equal(bot.stopZone(setup).bottom, 95);
  bot.settings.stopV2 = true;
  assert.equal(bot.stopZone(setup).bottom, 96);
  assert.equal(bot.stopZone({ ...setup, atr: null }).bottom, 95); // no ATR: falls back to the old stop
});

test('checkPendingEntry: waits, fills on a touch (at the limit in the simulator), cancels after 3 candles', async () => {
  let candles = flat(T0, 12, M, 110);
  const { bot } = mkBot({ maxOpenTrades: 4 }, { getCandles: async () => candles });
  bot.now = () => T0 + 10 * M;
  const calls = [];
  bot.openTrade = async (args) => { calls.push(args); return { trade: { id: 'T1' }, order: { price: args.limitPrice }, note: 'BUY $100' }; };
  const p = { side: 'long', limit: 104, setup: { id: 's' }, decision: {}, createdAt: T0 + 5 * M, expiresAt: T0 + 20 * M };
  bot.state.pendingEntry = p;
  let r = await bot.checkPendingEntry(p, {});
  assert.equal(r.done, false);
  assert.match(r.note, /Waiting for the limit long at 104/);
  candles = [...candles];
  candles[9] = c(candles[9].time, 110, 110, 103.5, 106); // traded to the limit
  r = await bot.checkPendingEntry(p, { openAll: 4 }); // no free slot: keeps waiting
  assert.equal(r.done, false);
  assert.match(r.note, /touched, waiting for a free slot/);
  r = await bot.checkPendingEntry(p, { openAll: 0 });
  assert.equal(r.done, true);
  assert.equal(r.trade.id, 'T1');
  assert.equal(calls[0].limitPrice, 104);
  assert.equal(bot.state.pendingEntry, undefined);
  // a touch before the limit was placed does not count; past the expiry it is cancelled
  candles = flat(T0, 12, M, 110);
  candles[2] = c(candles[2].time, 110, 110, 100, 106);
  bot.state.pendingEntry = p;
  bot.now = () => T0 + 21 * M;
  r = await bot.checkPendingEntry(p, {});
  assert.equal(r.done, true);
  assert.equal(r.trade, undefined);
  assert.match(r.note, /not filled within 3 candles: cancelled/);
});

test('manageOpen: invalidationExit closes the trade on a body close through the IFVG, off leaves it', async () => {
  const entry = T0 + 10 * M;
  const cs = flat(T0, 20, M, 103);
  cs[15] = c(cs[15].time, 99.8, 100.5, 97, 98);
  const run = async (on) => {
    const { bot, kv } = mkBot({ invalidationExit: on }, { getCandles: async () => cs });
    bot.now = () => T0 + 20 * M;
    await kv.set('trades', [{ id: 'T1', symbol: 'BTCUSDC', side: 'long', status: 'open', broker: 'local', entryTime: new Date(entry).toISOString(), entryPrice: 103, stop: 90, target: 120, qty: 1, notional: 103, granularity: 60, ifvg: { top: 105, bottom: 100, granularity: 60 } }]);
    const closes = [];
    bot.closeTrade = async (t, px, reason) => { closes.push(reason); return t; };
    await bot.manageOpen(cs, 99);
    return closes;
  };
  assert.deepEqual(await run(true), ['invalidation']);
  assert.deepEqual(await run(false), []);
});
