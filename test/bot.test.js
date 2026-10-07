import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planTrade, TradingBot, checkBracket, tradesToday } from '../src/bot.js';
import { LocalBroker } from '../src/brokers/local.js';
import { FileKV } from '../src/store.js';
import { geminiResponse, ifvgCandles, MemKV } from './helpers.js';

const settings = { minConfidence: 0.6, maxPositionPct: 50, maxTradePct: 10, intervalMinutes: 5, granularity: 900, maxTradesPerDay: 10, ifvgMaxAge: 3, requireHtfTap: false, entryTimeframes: '900' };
const acct = (o = {}) => ({ cash: 100000, btc: 0, price: 50000, equity: 100000, ...o });
const NOW = Date.UTC(2026, 9, 7, 12);

test('planTrade: HOLD and low confidence do nothing', () => {
  assert.equal(planTrade({ action: 'HOLD', confidence: 1, sizePct: 0 }, acct(), settings).order, null);
  assert.equal(planTrade({ action: 'BUY', confidence: 0.5, sizePct: 10 }, acct(), settings).order, null);
});

test('planTrade: BUY capped by max trade % and max position %', () => {
  assert.deepEqual(planTrade({ action: 'BUY', confidence: 0.9, sizePct: 80 }, acct(), settings).order, { side: 'buy', notional: 10000 });
  const { order } = planTrade({ action: 'BUY', confidence: 0.9, sizePct: 10 }, acct({ cash: 55000, btc: 0.9 }), settings);
  assert.deepEqual(order, { side: 'buy', notional: 5000 });
});

test('LocalBroker buy/sell updates balances and pnl (file storage)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-'));
  const b = new LocalBroker({ kv: new FileKV(dir), startingCash: 10000, getPrice: async () => 50000 });
  await b.placeOrder({ side: 'buy', notional: 5000, price: 50000 });
  let a = await b.getAccount(50000);
  assert.equal(a.cash, 5000);
  assert.ok(Math.abs(a.btc - 0.0999) < 1e-9);
  const sell = await b.placeOrder({ side: 'sell', qty: a.btc, price: 60000 });
  assert.ok(sell.pnl > 900);
  a = await b.getAccount(60000);
  assert.equal(a.btc, 0);
  await assert.rejects(b.placeOrder({ side: 'sell', qty: 1, price: 60000 }));
  await b.reset();
  assert.equal((await b.getAccount(1)).cash, 10000);
});

test('checkBracket: stop wins a candle that touches both levels', () => {
  const t = { entryTime: new Date(0).toISOString(), stop: 90, target: 110 };
  assert.deepEqual(checkBracket(t, [{ time: 1, low: 89, high: 111 }], 100), { exitPrice: 90, reason: 'stop' });
  assert.deepEqual(checkBracket(t, [{ time: 1, low: 95, high: 111 }], 100), { exitPrice: 110, reason: 'target' });
  assert.equal(checkBracket(t, [{ time: 1, low: 95, high: 105 }], 100), null);
});

function setup({ candles = ifvgCandles(NOW), fetchImpl, now = () => NOW, kv = new MemKV() } = {}) {
  const market = { getCandles: async () => candles, getPrice: async () => candles.at(-1).close };
  const broker = new LocalBroker({ kv, startingCash: 100000, getPrice: market.getPrice });
  const bot = new TradingBot({
    broker, market, settings, kv, now,
    ai: { provider: 'gemini', apiKey: 'k', model: 'gemini-2.5-flash' },
    fetchImpl: fetchImpl || geminiResponse({ action: 'BUY', confidence: 0.8, size_pct: 5, reasoning: 'IFVG holding' }),
  });
  return { bot, broker, market, kv, candles };
}

test('bullish IFVG + AI BUY opens a 1:1 trade with an entry snapshot', async () => {
  const { bot, broker, kv } = setup();
  const entry = await bot.runOnce();
  assert.equal(entry.action, 'BUY');
  assert.equal(entry.executed, true, entry.note);
  const [t] = await bot.trades();
  assert.equal(t.status, 'open');
  assert.ok(t.stop < 59500);
  assert.ok(Math.abs((t.entryPrice - t.stop) - (t.target - t.entryPrice)) < 0.02);
  assert.equal((await broker.getOrders()).length, 1);
  assert.match((await kv.get(`shot_${t.id}`, {})).entry, /^data:image\/svg\+xml;base64,/);
  // the same IFVG is not traded twice
  const again = await bot.runOnce();
  assert.equal(again.executed, false);
});

test('target hit closes the trade as a win with an exit snapshot', async () => {
  const s = setup();
  await s.bot.runOnce();
  const [t] = await s.bot.trades();
  s.candles.push({ time: NOW + 60000, open: t.entryPrice, high: t.target + 10, low: t.entryPrice - 1, close: t.target, volume: 1 });
  s.bot.now = () => NOW + 120000;
  const closed = await s.bot.manageOpen(s.candles, t.target);
  assert.equal(closed.status, 'win');
  assert.equal(closed.exitReason, 'target');
  assert.equal(closed.r, 1);
  assert.ok(closed.pnl > 0);
  assert.match((await s.kv.get(`shot_${t.id}`, {})).exit, /^data:image\/svg\+xml;base64,/);
});

test('daily limit of 10 trades stops new entries without calling the AI', async () => {
  let calls = 0;
  const kv = new MemKV();
  await kv.set('trades', Array.from({ length: 10 }, (_, i) => ({
    id: `T${i}`, status: 'win', entryTime: new Date(NOW - i * 60000).toISOString(),
  })));
  const { bot } = setup({ kv, fetchImpl: async () => { calls++; throw new Error('should not be called'); } });
  assert.equal(tradesToday(await bot.trades(), NOW), 10);
  const entry = await bot.runOnce();
  assert.equal(entry.executed, false);
  assert.match(entry.note, /Daily limit reached \(10\/10\)/);
  assert.equal(calls, 0);
});

test('no IFVG: scheduled scans skip the AI', async () => {
  let calls = 0;
  const flat = ifvgCandles(NOW).slice(0, 40);
  const { bot } = setup({ candles: flat, fetchImpl: async () => { calls++; throw new Error('nope'); } });
  const entry = await bot.runOnce();
  assert.match(entry.note, /No setup · swing 15m: no fresh IFVG · scalp 1m: no fresh IFVG/);
  assert.equal(calls, 0);
});

test('runOnce logs market errors', async () => {
  const kv = new MemKV();
  const market = { getCandles: async () => { throw new Error('offline'); }, getPrice: async () => 1 };
  const broker = new LocalBroker({ kv, startingCash: 1000, getPrice: market.getPrice });
  const bot = new TradingBot({ broker, market, settings, kv, ai: { provider: 'none', apiKey: '' } });
  const entry = await bot.runOnce();
  assert.equal(entry.action, 'ERROR');
  assert.equal((await bot.status()).lastError, 'offline');
});

test('bearish IFVG + AI SELL opens a 1:1 short that wins at the target', async () => {
  const { bearishIfvgCandles } = await import('./helpers.js');
  const s = setup({
    candles: bearishIfvgCandles(NOW),
    fetchImpl: geminiResponse({ action: 'SELL', confidence: 0.8, size_pct: 5, reasoning: 'IFVG rejecting' }),
  });
  const entry = await s.bot.runOnce();
  assert.equal(entry.executed, true, entry.note);
  const [t] = await s.bot.trades();
  assert.equal(t.side, 'short');
  assert.ok(t.stop > t.entryPrice && t.target < t.entryPrice);
  assert.ok(Math.abs((t.stop - t.entryPrice) - (t.entryPrice - t.target)) < 0.02);
  assert.equal((await s.broker.getAccount(t.entryPrice)).shortBtc > 0, true);

  s.candles.push({ time: NOW + 60000, open: t.entryPrice, high: t.entryPrice + 1, low: t.target - 10, close: t.target, volume: 1 });
  s.bot.now = () => NOW + 120000;
  const closed = await s.bot.manageOpen(s.candles, t.target);
  assert.equal(closed.status, 'win');
  assert.equal(closed.r, 1);
  assert.ok(closed.pnl > 0);
  const a = await s.broker.getAccount(t.target);
  assert.equal(a.shortBtc, 0);
  assert.ok(a.equity > 100000);
});

test('short stop: price rising through the stop is a -1R loss', async () => {
  const { bearishIfvgCandles } = await import('./helpers.js');
  const s = setup({
    candles: bearishIfvgCandles(NOW),
    fetchImpl: geminiResponse({ action: 'SELL', confidence: 0.8, size_pct: 5, reasoning: 'x' }),
  });
  await s.bot.runOnce();
  const [t] = await s.bot.trades();
  s.bot.now = () => NOW + 120000;
  const closed = await s.bot.manageOpen(s.candles, t.stop + 5);
  assert.equal(closed.status, 'loss');
  assert.equal(closed.r, -1);
  assert.ok(closed.pnl < 0);
});

test('bullish IFVG ignores an AI SELL (direction must match the setup)', async () => {
  const s = setup({ fetchImpl: geminiResponse({ action: 'SELL', confidence: 0.9, size_pct: 5, reasoning: 'x' }) });
  const entry = await s.bot.runOnce();
  assert.equal(entry.executed, false);
  assert.match(entry.note, /does not match the bullish IFVG/);
});

/** Minimal in-memory PostgREST: tables keyed by id (kv keyed by key); supports eq filters, upsert, patch, delete. */
function fakeSupabase() {
  const tables = {};
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    const t = (tables[table] ??= new Map());
    const pk = table === 'kv' ? 'key' : 'id';
    const eq = u.searchParams.get(pk)?.startsWith('eq.') ? u.searchParams.get(pk).slice(3) : null;
    calls.push({ method: opts.method, table, headers: opts.headers });
    if (opts.method === 'POST') {
      for (const row of [].concat(JSON.parse(opts.body))) t.set(row[pk], { ...t.get(row[pk]), ...row });
      return { ok: true, status: 201 };
    }
    if (opts.method === 'PATCH') { if (t.has(eq)) t.set(eq, { ...t.get(eq), ...JSON.parse(opts.body) }); return { ok: true, status: 204 }; }
    if (opts.method === 'DELETE') { if (eq) t.delete(eq); else t.clear(); return { ok: true, status: 204 }; }
    let rows = [...t.values()];
    if (eq) rows = rows.filter((r) => r[pk] === eq);
    const order = u.searchParams.get('order');
    if (order) { const [col] = order.split('.'); rows.sort((a, b) => String(b[col]).localeCompare(String(a[col]))); }
    return { ok: true, status: 200, json: async () => rows };
  };
  return { tables, calls, fetchImpl };
}

test('SupabaseKV stores trades, images, decisions, orders and settings in their own tables', async () => {
  const { SupabaseKV, appendList } = await import('../src/store.js');
  const fake = fakeSupabase();
  const kv = new SupabaseKV({ url: 'https://abc.supabase.co/', key: 'sb_secret_x' }, fake.fetchImpl);

  // trades + base64 images on the same row
  const trade = { id: 'T1', side: 'short', status: 'open', entryTime: '2026-10-07T01:00:00Z', entryPrice: 100, stop: 101, target: 99 };
  await kv.set('trades', [trade]);
  await kv.set('shot_T1', { entry: 'data:image/svg+xml;base64,AAA' });
  const row = fake.tables.trades.get('T1');
  assert.equal(row.side, 'short');
  assert.equal(row.entry_price, 100);
  assert.equal(row.entry_image, 'data:image/svg+xml;base64,AAA');
  assert.deepEqual(await kv.get('trades', []), [trade]);
  assert.deepEqual(await kv.get('shot_T1', {}), { entry: 'data:image/svg+xml;base64,AAA' });
  await kv.set('trades', [{ ...trade, status: 'win', exitPrice: 99 }]); // update keeps the image
  assert.equal(fake.tables.trades.get('T1').entry_image, 'data:image/svg+xml;base64,AAA');
  assert.equal(fake.tables.trades.get('T1').status, 'win');

  // decisions and orders are appended one row at a time
  await appendList(kv, 'decisions', { id: 'D1', time: '2026-10-07T01:00:00Z', action: 'SELL', confidence: 0.8 });
  await appendList(kv, 'decisions', { id: 'D2', time: '2026-10-07T01:05:00Z', action: 'HOLD' });
  assert.deepEqual((await kv.get('decisions', [])).map((d) => d.id), ['D2', 'D1']);
  assert.equal(fake.tables.decisions.get('D1').action, 'SELL');
  await appendList(kv, 'orders', { id: 'L1', time: '2026-10-07T01:00:00Z', side: 'short', qty: 0.1, price: 100 });
  assert.equal(fake.tables.orders.get('L1').side, 'short');

  // settings row + kv fallback for the account
  await kv.set('bot', { running: true, settings: { intervalMinutes: 5, maxTradesPerDay: 10 } });
  assert.equal(fake.tables.settings.get('bot').max_trades_per_day, 10);
  assert.equal((await kv.get('bot', null)).running, true);
  await kv.set('account', { cash: 1 });
  assert.deepEqual(await kv.get('account', null), { cash: 1 });

  // reset clears a table
  await kv.set('trades', []);
  assert.deepEqual(await kv.get('trades', []), []);
  assert.equal(fake.calls[0].headers.apikey, 'sb_secret_x');
});

test('LocalBroker on SupabaseKV writes each order as its own row', async () => {
  const { SupabaseKV } = await import('../src/store.js');
  const fake = fakeSupabase();
  const kv = new SupabaseKV({ url: 'https://abc.supabase.co', key: 'sb_secret_x' }, fake.fetchImpl);
  const b = new LocalBroker({ kv, startingCash: 10000, getPrice: async () => 50000 });
  await b.placeOrder({ side: 'buy', notional: 1000, price: 50000 });
  await b.openShort({ notional: 1000, price: 50000 });
  assert.equal(fake.tables.orders.size, 2);
  assert.equal((await b.getOrders()).length, 2);
  assert.equal(fake.tables.kv.get('account').value.orders, undefined);
});

test('missing snapshots are re-rendered on demand as base64 images', async () => {
  const s = setup();
  await s.bot.runOnce();
  const [t] = await s.bot.trades();
  await s.kv.del(`shot_${t.id}`);
  const shots = await s.bot.shotsFor(t.id);
  assert.match(shots.entry, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(shots.entry.split(',')[1], 'base64').toString(), /^<svg/);
  assert.deepEqual(await s.kv.get(`shot_${t.id}`, {}), shots);
});

test('Jev risk review: a 15m trade is reviewed after 60 min and closed when Jev says close', async () => {
  let answer = { action: 'BUY', confidence: 0.8, size_pct: 5, reasoning: 'IFVG holding' };
  const s = setup({ fetchImpl: async (...a) => geminiResponse(answer)(...a) });
  await s.bot.runOnce();
  const [t] = await s.bot.trades();
  assert.equal(t.status, 'open');

  // 30 min later: no review yet for a 15m trade
  s.bot.now = () => NOW + 30 * 60000;
  const early = await s.bot.runOnce();
  assert.match(early.note, /Managing open trade/);

  // 61 min later: Jev reviews and answers close (SELL closes a long)
  answer = { action: 'SELL', confidence: 0.9, size_pct: 0, reasoning: 'momentum turned' };
  s.bot.now = () => NOW + 61 * 60000;
  const rev = await s.bot.runOnce();
  assert.match(rev.note, /Jev review: closed long early/);
  const [closed] = await s.bot.trades();
  assert.equal(closed.exitReason, 'review');
  assert.equal(closed.reviews, 1);
});

test('swing limit reached: swing setups are skipped, scalps still allowed', async () => {
  let calls = 0;
  const kv = new MemKV();
  await kv.set('trades', Array.from({ length: 5 }, (_, i) => ({
    id: `T${i}`, status: 'win', category: 'swing', entryTime: new Date(NOW - i * 60000).toISOString(),
  })));
  const { bot } = setup({ kv, fetchImpl: async () => { calls++; throw new Error('should not be called'); } });
  await bot.updateSettings({ maxSwingPerDay: 5, maxScalpPerDay: 5, scalpEnabled: 'false' });
  const entry = await bot.runOnce();
  assert.equal(entry.executed, false);
  assert.match(entry.note, /Swing limit reached/);
  assert.equal(calls, 0);
  assert.equal((await bot.status()).swingToday, 5);
});

const longTrade = (o = {}) => ({
  side: 'long', entryTime: new Date(0).toISOString(), entryPrice: 100, stop: 90, initialStop: 90, target: 130,
  rr: 3, breakevenAtR: 1, ...o,
});

test('breakeven: stop moves to entry at +1R, trade keeps running toward 1:3', () => {
  const t = longTrade();
  // candle 1 reaches +1R (110) without touching the stop
  const r = checkBracket(t, [{ time: 1000, low: 99, high: 111 }], 105, 2000);
  assert.deepEqual(r, { breakevenAt: 1000 });
});

test('breakeven: after the move, a return to entry closes at breakeven (0R)', () => {
  const t = longTrade({ breakeven: true, breakevenAt: new Date(1000).toISOString(), stop: 100 });
  const r = checkBracket(t, [{ time: 1000, low: 99, high: 111 }, { time: 2000, low: 99.5, high: 104 }], 101, 3000);
  assert.equal(r.reason, 'breakeven');
  assert.equal(r.exitPrice, 100);
});

test('breakeven: price running on to the 1:3 target closes as a win', () => {
  const t = longTrade();
  const r = checkBracket(t, [{ time: 1000, low: 99, high: 111 }, { time: 2000, low: 108, high: 131 }], 129, 3000);
  assert.equal(r.reason, 'target');
  assert.equal(r.exitPrice, 130);
  assert.equal(r.breakevenAt, 1000);
});

test('breakeven: a dip below entry BEFORE the trigger is not judged against the moved stop', () => {
  const t = longTrade();
  // candle 1 dips to 95 (below entry, above stop) and only later candle 2 reaches +1R
  const r = checkBracket(t, [{ time: 1000, low: 95, high: 104 }, { time: 2000, low: 101, high: 111 }], 106, 3000);
  assert.deepEqual(r, { breakevenAt: 2000 });
});

test('1:3 bracket with breakeven at +1R end to end: open, move to BE, stop out at entry', async () => {
  const s = setup();
  await s.bot.updateSettings({ riskReward: 3, breakevenAtR: 1 });
  await s.bot.runOnce();
  const [t] = await s.bot.trades();
  const risk = t.entryPrice - t.stop;
  assert.equal(t.rr, 3);
  assert.ok(Math.abs((t.target - t.entryPrice) - 3 * risk) < 0.05);

  // +1R candle -> breakeven
  s.candles.push({ time: NOW + 60000, open: t.entryPrice, high: t.entryPrice + risk + 1, low: t.entryPrice + 1, close: t.entryPrice + risk, volume: 1 });
  s.bot.now = () => NOW + 120000;
  assert.equal(await s.bot.manageOpen(s.candles, t.entryPrice + risk), null);
  const [moved] = await s.bot.trades();
  assert.equal(moved.breakeven, true);
  assert.equal(moved.stop, t.entryPrice);

  // back to entry -> closed at breakeven
  s.candles.push({ time: NOW + 180000, open: t.entryPrice + risk, high: t.entryPrice + risk, low: t.entryPrice - 1, close: t.entryPrice, volume: 1 });
  s.bot.now = () => NOW + 240000;
  const closed = await s.bot.manageOpen(s.candles, t.entryPrice);
  assert.equal(closed.status, 'breakeven');
  assert.equal(closed.r, 0);
});
