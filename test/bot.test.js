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
  assert.match(entry.note, /No setup · swing 15m: no fresh IFVG.*scalp 1m: no fresh IFVG/);
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
  await bot.updateSettings({ maxSwingPerDay: 5, maxScalpPerDay: 0 }); // scalps limited to 0 per day
  const entry = await bot.runOnce();
  assert.equal(entry.executed, false);
  assert.match(entry.note, /Daily limit reached \(5\/5\)/); // total = 5 swing + 0 scalp
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

test('BinanceFuturesBroker signs requests, opens/covers shorts reduce-only, reads short positions', async () => {
  const crypto = await import('node:crypto');
  const { BinanceFuturesBroker } = await import('../src/brokers/binance.js');
  const calls = [];
  let position = 0;
  const fakeFetch = async (url, opts) => {
    const u = new URL(url);
    const p = Object.fromEntries(u.searchParams);
    calls.push({ method: opts.method, path: u.pathname, p, key: opts.headers['X-MBX-APIKEY'] });
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.pathname === '/fapi/v1/exchangeInfo') return json({ symbols: [{ symbol: 'BTCUSDT', filters: [{ filterType: 'MARKET_LOT_SIZE', stepSize: '0.001' }] }] });
    if (u.pathname === '/fapi/v1/leverage') return json({ leverage: 1 });
    if (u.pathname === '/fapi/v1/order') {
      position += (p.side === 'BUY' ? 1 : -1) * Number(p.quantity);
      return json({ orderId: 7, status: 'FILLED', executedQty: p.quantity, avgPrice: '50000', cumQuote: String(50000 * p.quantity), updateTime: 1 });
    }
    if (u.pathname === '/fapi/v2/account') return json({ availableBalance: '9000', totalMarginBalance: '10000' });
    if (u.pathname === '/fapi/v2/positionRisk') return json([{ symbol: 'BTCUSDT', positionAmt: String(position), entryPrice: '50000', markPrice: '50000' }]);
    return { ok: false, status: 404, json: async () => ({ code: -1, msg: 'nope' }) };
  };
  const b = new BinanceFuturesBroker({ key: 'K', secret: 'S', getPrice: async () => 50000 }, fakeFetch);

  const short = await b.openShort({ notional: 5000, price: 50000 });
  assert.equal(short.side, 'short');
  assert.equal(short.qty, 0.1);
  assert.equal(short.price, 50000);
  const ord = calls.find((c) => c.path === '/fapi/v1/order');
  assert.equal(ord.p.side, 'SELL');
  assert.equal(ord.p.reduceOnly, undefined);
  assert.equal(ord.key, 'K');
  // signature = HMAC-SHA256(secret, query without signature)
  const q = new URL(`http://x/?${new URLSearchParams(Object.entries(ord.p).filter(([k]) => k !== 'signature'))}`).search.slice(1);
  assert.equal(ord.p.signature, crypto.createHmac('sha256', 'S').update(q).digest('hex'));

  const a = await b.getAccount(50000);
  assert.equal(a.shortBtc, 0.1);
  assert.equal(a.btc, 0);
  assert.equal(a.equity, 10000);

  await b.coverShort({ qty: 0.1, reason: 'target' });
  const cover = calls.filter((c) => c.path === '/fapi/v1/order').at(-1);
  assert.equal(cover.p.side, 'BUY');
  assert.equal(cover.p.reduceOnly, 'true');
  assert.equal((await b.getAccount(50000)).shortBtc, 0);
  assert.throws(() => new BinanceFuturesBroker({ key: 'K', secret: 'S', baseUrl: 'https://fapi.binance.com' }), /non-demo/);
});

test('leverage: Jev picks it, capped by Max leverage; position = margin x leverage', async () => {
  const s = setup({ fetchImpl: geminiResponse({ action: 'BUY', confidence: 0.8, size_pct: 5, leverage: 10, reasoning: 'clean setup' }) });
  s.broker.supportsLeverage = true; // pretend the simulator is a leveraged futures broker
  await s.bot.updateSettings({ maxLeverage: 2 });
  const entry = await s.bot.runOnce();
  assert.equal(entry.executed, true, entry.note);
  const [t] = await s.bot.trades();
  assert.equal(t.leverage, 2);
  assert.equal(t.margin, 5000);
  assert.ok(Math.abs(t.notional - 10000) < 1);
  assert.match(entry.note, /\(2x, margin \$5000\.00\)/);
});

test('leverage: brokers without leverage (simulator) always use 1x', async () => {
  const s = setup({ fetchImpl: geminiResponse({ action: 'BUY', confidence: 0.8, size_pct: 5, leverage: 10, reasoning: 'x' }) });
  await s.bot.runOnce();
  const [t] = await s.bot.trades();
  assert.equal(t.leverage, 1);
});

test('cycle lock: only one holder at a time, stale locks are taken over', async () => {
  const { SupabaseKV } = await import('../src/store.js');
  const rows = new Map();
  const fakeFetch = async (url, opts) => {
    const u = new URL(url);
    const key = u.searchParams.get('key')?.replace(/^eq\./, '');
    if (opts.method === 'POST') {
      const b = JSON.parse(opts.body);
      if (rows.has(b.key)) return { ok: false, status: 409, text: async () => 'duplicate key' };
      rows.set(b.key, b.value); return { ok: true, status: 201 };
    }
    if (opts.method === 'DELETE') { rows.delete(key); return { ok: true, status: 204 }; }
    return { ok: true, status: 200, json: async () => (rows.has(key) ? [{ value: rows.get(key) }] : []) };
  };
  const kv = new SupabaseKV({ url: 'https://abc.supabase.co', key: 'sb_secret_x' }, fakeFetch);
  assert.equal(await kv.tryLock('cycle', 60000), true);
  assert.equal(await kv.tryLock('cycle', 60000), false); // second runner is turned away
  await kv.unlock('cycle');
  assert.equal(await kv.tryLock('cycle', 60000), true);
  rows.set('lock_cycle', { until: Date.now() - 1 }); // holder crashed: lock expired
  assert.equal(await kv.tryLock('cycle', 60000), true);
});

test('minimum gap size scales with the entry timeframe', async () => {
  const { minGapFor } = await import('../src/ifvg.js');
  assert.equal(minGapFor(60), 0.01);
  assert.equal(minGapFor(900), 0.03);
});

test('futures broker: P&L comes from filled qty x price, not the requested size; $ risk recorded', async () => {
  const s = setup();
  // Binance-like broker: rounds qty down to 0.001 BTC and reports the *requested* notional (the old bug's trigger)
  const fills = [];
  s.bot.broker = {
    name: 'binance',
    getAccount: async (p) => ({ cash: 100000, btc: fills.reduce((a, f) => a + (f.side === 'buy' ? f.qty : -f.qty), 0), shortBtc: 0, price: p, equity: 100000 }),
    placeOrder: async ({ side, notional, qty, price }) => {
      const q = side === 'buy' ? Math.floor((notional / price) * 1000) / 1000 : qty;
      const f = { id: `B${fills.length}`, side, qty: q, price, notional: side === 'buy' ? notional : q * price, fee: q * price * 0.0004 };
      fills.push(f);
      return f;
    },
  };
  await s.bot.runOnce();
  const [t] = await s.bot.trades();
  assert.ok(Math.abs(t.notional - t.qty * t.entryPrice) < 0.01, 'notional = filled qty x price');
  assert.ok(Math.abs(t.riskUsd - Math.abs(t.entryPrice - t.stop) * t.qty) < 0.01);
  s.candles.push({ time: NOW + 60000, open: t.entryPrice, high: t.target + 5, low: t.entryPrice - 1, close: t.target, volume: 1 });
  s.bot.now = () => NOW + 120000;
  const closed = await s.bot.manageOpen(s.candles, t.target);
  const expected = (t.target - t.entryPrice) * t.qty - t.entryFee - t.qty * t.target * 0.0004;
  assert.ok(Math.abs(closed.pnl - expected) < 0.02, `pnl ${closed.pnl} vs ${expected}`);
  assert.equal(closed.status, 'win');
});

test('change signature moves when a trade, decision or order is written', async () => {
  const s = setup();
  const before = await s.bot.changeSignature();
  await s.bot.runOnce(); // opens a trade, logs a decision, writes an order
  const after = await s.bot.changeSignature();
  assert.notEqual(before, after);
  assert.equal(await s.bot.changeSignature(), after); // stable when nothing changes
});

test('risk sizing: $50 risk, leverage raised to fit the margin, trimmed only when it cannot fit', async () => {
  const { riskSize } = await import('../src/bot.js');
  // 0.5% stop at 84,000 = 420 $/BTC -> 0.119 BTC = $10,000 position; margin at 3x = $3,333 fits in $5,000
  let r = riskSize({ riskUsd: 50, stopDist: 420, price: 84000, cash: 5000, levPick: 3, maxLev: 5, canLever: true });
  assert.equal(r.leverage, 3);
  assert.ok(Math.abs(r.riskUsd - 50) < 0.01);
  assert.equal(r.capped, false);
  // 0.15% stop = 126 $/BTC -> $33,333 position: needs 7x on $4,750 usable; max 5x -> trimmed to $23,750 (~$35.6 risk)
  r = riskSize({ riskUsd: 50, stopDist: 126, price: 84000, cash: 5000, levPick: 2, maxLev: 5, canLever: true });
  assert.equal(r.leverage, 5);
  assert.equal(r.capped, true);
  assert.ok(Math.abs(r.notional - 23750) < 0.01);
  assert.ok(r.riskUsd > 35 && r.riskUsd < 36);
  // with 10x allowed it fits in full
  r = riskSize({ riskUsd: 50, stopDist: 126, price: 84000, cash: 5000, levPick: 2, maxLev: 10, canLever: true });
  assert.equal(r.capped, false);
  assert.equal(r.leverage, 8);
});

test('exchange bracket: SL/TP placed on the exchange, breakeven moves the stop, result from the real fill', async () => {
  const s = setup();
  await s.bot.updateSettings({ riskReward: 2, breakevenAtR: 1 });
  const ex = { pos: 0, algos: {}, nextId: 1, cancelled: [] };
  s.bot.broker = {
    name: 'binance', supportsBrackets: true,
    getAccount: async (p) => ({ cash: 100000, btc: Math.max(0, ex.pos), shortBtc: Math.max(0, -ex.pos), price: p, equity: 100000 }),
    placeOrder: async ({ notional, price }) => { const q = Math.floor((notional / price) * 1000) / 1000; ex.pos += q; ex.q = q; return { id: 'E1', qty: q, price, fee: 1 }; },
    placeBracket: async ({ stop, target }) => {
      const a = String(ex.nextId++), b = String(ex.nextId++);
      ex.algos[a] = { trigger: stop }; ex.algos[b] = { trigger: target };
      return { stopAlgoId: a, targetAlgoId: b };
    },
    moveStop: async (trade, newStop) => { ex.cancelled.push(trade.stopAlgoId); const id = String(ex.nextId++); ex.algos[id] = { trigger: newStop }; return id; },
    cancelAlgo: async (id) => { ex.cancelled.push(id); },
    algoStatus: async (id) => (ex.algos[id]?.fired ? { status: 'FINISHED', actualOrderId: `X${id}` } : { status: 'NEW', actualOrderId: null }),
    positionAmt: async () => ex.pos,
    fills: async () => ({ qty: ex.q, price: 70000, quote: 70000 * ex.q, commission: 2, realizedPnl: 123.45 }),
  };
  await s.bot.runOnce();
  let [t] = await s.bot.trades();
  assert.equal(t.exchangeBracket, true);
  assert.equal(ex.algos[t.stopAlgoId].trigger, t.stop);
  assert.equal(ex.algos[t.targetAlgoId].trigger, t.target);

  // +1R reached: the exchange stop is replaced at the entry
  const risk = t.entryPrice - t.stop;
  s.candles.push({ time: NOW + 60000, open: t.entryPrice, high: t.entryPrice + risk + 1, low: t.entryPrice + 1, close: t.entryPrice + risk, volume: 1 });
  s.bot.now = () => NOW + 120000;
  assert.equal(await s.bot.manageOpen(s.candles, t.entryPrice + risk), null);
  [t] = await s.bot.trades();
  assert.equal(t.breakeven, true);
  assert.equal(ex.algos[t.stopAlgoId].trigger, t.entryPrice);

  // the exchange take-profit fires: position flat, result from the real fill (realized P&L - fees)
  ex.algos[t.targetAlgoId].fired = true;
  ex.pos = 0;
  s.bot.now = () => NOW + 180000;
  const closed = await s.bot.manageOpen(s.candles, t.target);
  assert.equal(closed.exitReason, 'target');
  assert.equal(closed.exitPrice, 70000);
  assert.ok(Math.abs(closed.pnl - (123.45 - 1 - 2)) < 0.01, String(closed.pnl));
  assert.ok(ex.cancelled.includes(t.stopAlgoId), 'leftover stop cancelled');
});

test('daily scan counter tallies every scan and where it stopped', async () => {
  const { scanOutcome } = await import('../src/bot.js');
  assert.equal(scanOutcome('No setup · swing 15m: no fresh IFVG · scalp 1m: no fresh IFVG'), 'noIfvg');
  assert.equal(scanOutcome('No setup · swing 5m: bullish IFVG, no bullish 30m/1h/2h/4h FVG tap'), 'noTap');
  assert.equal(scanOutcome('Managing open trade (bracket active, next review 10:00 UTC)'), 'inTrade');
  assert.equal(scanOutcome(null), 'asked');
  const s = setup();
  await s.bot.runOnce(); // takes a trade
  s.bot.now = () => NOW + 60000;
  await s.bot.runOnce(); // managing it
  const st = (await s.bot.status()).scanStats;
  assert.equal(st.scans, 2);
  assert.equal(st.taken, 1);
  assert.equal(st.inTrade, 1);
});

test('swing / scalp can be switched off and on', async () => {
  const { bot } = setup({ kv: new MemKV() });
  await bot.updateSettings({ swingEnabled: 'false', scalpEnabled: true });
  assert.equal(bot.state.settings.swingEnabled, false);
  assert.equal(bot.state.settings.scalpEnabled, true);
  await bot.load();
  assert.equal(bot.state.settings.swingEnabled, false, 'kept after reload');
  await bot.updateSettings({ swingEnabled: 'true', scalpEnabled: 'false' });
  assert.equal(bot.state.settings.swingEnabled, true);
  assert.equal(bot.state.settings.scalpEnabled, false);
});

test('HTF FVG inside the bracket becomes the target (near edge)', async () => {
  const { htfTargetInBracket } = await import('../src/bot.js');
  const zones = [
    { tf: '1h', type: 'bullish', top: 83150, bottom: 83120 }, // below a short, inside the bracket
    { tf: '5m', type: 'bullish', top: 83200, bottom: 83190 }, // LTF: ignored
    { tf: '4h', type: 'bearish', top: 82900, bottom: 82850 }, // beyond the target: ignored
  ];
  const t = htfTargetInBracket(zones, 'short', 83300, 83000, 100);
  assert.equal(t.price, 83150);
  assert.equal(t.r, 1.5);
  assert.equal(htfTargetInBracket(zones, 'short', 83300, 83200, 100), null); // nothing inside a tighter bracket
  const l = htfTargetInBracket([{ tf: '30m', type: 'bearish', top: 101.5, bottom: 101 }], 'long', 100, 103, 1);
  assert.equal(l.price, 101);
});

test('partial profit: first internal liquidity takes part off and moves the stop to entry', async () => {
  const { checkBracket, partialFor } = await import('../src/bot.js');
  const t = { side: 'long', entryTime: new Date(0).toISOString(), entryPrice: 100, stop: 98, initialStop: 98, target: 106, partialLevel: 102, partialPct: 50 };
  const c = [{ time: 60000, low: 99.5, high: 102.5 }, { time: 120000, low: 99.9, high: 101 }];
  const hit = checkBracket(t, c, 101, 180000);
  assert.equal(hit.partialAt, 60000);
  assert.equal(hit.breakevenAt, 60000);
  const after = checkBracket({ ...t, partial: { r: 1 }, breakeven: true, breakevenAt: new Date(60000).toISOString(), stop: 100 }, [{ time: 120000, low: 99.9, high: 101 }], 101, 180000);
  assert.equal(after.reason, 'breakeven');
  const liq = { above: [{ type: 'SWH', price: 102 }, { type: 'PDH', price: 106 }], below: [], lrlr: null };
  assert.deepEqual(partialFor({ partialPct: 50 }, liq, 'long', 100, { risk: 2, target: 106 }), { partialPct: 50, partialLevel: 102 });
  assert.deepEqual(partialFor({ partialPct: 0 }, liq, 'long', 100, { risk: 2, target: 106 }), {});
});

test('swing stop widens the stop zone to the recent swing high / low', async () => {
  const { bot } = setup({ kv: new MemKV() });
  const st = { direction: 'bearish', top: 101, bottom: 100, swingStop: 102.5 };
  assert.equal(bot.stopZone(st).top, 101, 'zone mode by default');
  await bot.updateSettings({ stopMode: 'swing' });
  assert.equal(bot.stopZone(st).top, 102.5);
  assert.equal(bot.stopZone({ direction: 'bullish', top: 101, bottom: 100, swingStop: 99 }).bottom, 99);
});

test('risk sizing never picks a leverage whose liquidation sits inside the stop', async () => {
  const { riskSize } = await import('../src/bot.js');
  // stop 1% away: at most 50x even though 125x is allowed
  const r = riskSize({ riskUsd: 50, stopDist: 1, price: 100, cash: 50, levPick: 125, maxLev: 125, canLever: true });
  assert.ok(r.leverage <= 50);
  const r2 = riskSize({ riskUsd: 50, stopDist: 0.2, price: 100, cash: 1000, levPick: 125, maxLev: 125, canLever: true });
  assert.ok(r2.leverage <= 125 && r2.leverage >= 1);
});
