import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planTrade, TradingBot, checkBracket, tradesToday } from '../src/bot.js';
import { LocalBroker } from '../src/brokers/local.js';
import { FileKV } from '../src/store.js';
import { geminiResponse, ifvgCandles, MemKV } from './helpers.js';

const settings = { minConfidence: 0.6, maxPositionPct: 50, maxTradePct: 10, intervalMinutes: 5, granularity: 900, maxTradesPerDay: 10 };
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
  assert.match((await kv.get(`shot_${t.id}`, {})).entry, /^<svg/);
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
  assert.match((await s.kv.get(`shot_${t.id}`, {})).exit, /^<svg/);
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
  assert.equal(entry.note, 'No fresh IFVG setup');
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
