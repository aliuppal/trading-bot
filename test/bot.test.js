import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planTrade, TradingBot } from '../src/bot.js';
import { LocalBroker } from '../src/brokers/local.js';
import { makeCandles, geminiResponse } from './helpers.js';

const settings = { minConfidence: 0.6, maxPositionPct: 50, maxTradePct: 10, intervalMinutes: 15, granularity: 3600 };
const acct = (o = {}) => ({ cash: 100000, btc: 0, price: 50000, equity: 100000, ...o });

test('planTrade: HOLD and low confidence do nothing', () => {
  assert.equal(planTrade({ action: 'HOLD', confidence: 1, sizePct: 0 }, acct(), settings).order, null);
  assert.equal(planTrade({ action: 'BUY', confidence: 0.5, sizePct: 10 }, acct(), settings).order, null);
});

test('planTrade: BUY capped by max trade %', () => {
  const { order } = planTrade({ action: 'BUY', confidence: 0.9, sizePct: 80 }, acct(), settings);
  assert.deepEqual(order, { side: 'buy', notional: 10000 });
});

test('planTrade: BUY capped by max position %', () => {
  // already hold $45k of BTC in a $100k account; room is $5k
  const { order } = planTrade({ action: 'BUY', confidence: 0.9, sizePct: 10 }, acct({ cash: 55000, btc: 0.9 }), settings);
  assert.deepEqual(order, { side: 'buy', notional: 5000 });
  const full = planTrade({ action: 'BUY', confidence: 0.9, sizePct: 10 }, acct({ cash: 50000, btc: 1 }), settings);
  assert.equal(full.order, null);
});

test('planTrade: SELL percentage of position', () => {
  const { order } = planTrade({ action: 'SELL', confidence: 0.9, sizePct: 50 }, acct({ btc: 0.2 }), settings);
  assert.deepEqual(order, { side: 'sell', qty: 0.1 });
  assert.equal(planTrade({ action: 'SELL', confidence: 0.9, sizePct: 50 }, acct(), settings).order, null);
});

test('LocalBroker buy/sell updates balances and pnl', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-'));
  const b = new LocalBroker({ dataDir: dir, startingCash: 10000, getPrice: async () => 50000 });
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

test('TradingBot.runOnce executes AI BUY on local broker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-'));
  const candles = makeCandles();
  const market = { getCandles: async () => candles, getPrice: async () => candles.at(-1).close };
  const broker = new LocalBroker({ dataDir: dir, startingCash: 100000, getPrice: market.getPrice });
  const bot = new TradingBot({
    broker, market, settings, dataDir: dir,
    gemini: { apiKey: 'k', model: 'gemini-2.5-flash' },
    fetchImpl: geminiResponse({ action: 'BUY', confidence: 0.8, size_pct: 5, reasoning: 'trend up' }),
  });
  const entry = await bot.runOnce();
  assert.equal(entry.action, 'BUY');
  assert.equal(entry.executed, true);
  assert.equal(entry.order.notional, 5000);
  assert.equal(bot.decisions().length, 1);
  assert.equal((await broker.getOrders()).length, 1);
});

test('TradingBot.runOnce logs market errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-'));
  const market = { getCandles: async () => { throw new Error('offline'); }, getPrice: async () => 1 };
  const broker = new LocalBroker({ dataDir: dir, startingCash: 1000, getPrice: market.getPrice });
  const bot = new TradingBot({ broker, market, settings, dataDir: dir, gemini: { apiKey: '' } });
  const entry = await bot.runOnce();
  assert.equal(entry.action, 'ERROR');
  assert.equal(bot.status().lastError, 'offline');
});
