import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import * as market from './src/market.js';
import { LocalBroker } from './src/brokers/local.js';
import { AlpacaBroker } from './src/brokers/alpaca.js';
import { TradingBot } from './src/bot.js';
import { summarize } from './src/indicators.js';
import { findIfvgs } from './src/ifvg.js';
import { createKV } from './src/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const kv = createKV({ dataDir: config.dataDir, redis: config.redis });
const broker = config.broker === 'alpaca'
  ? new AlpacaBroker({ ...config.alpaca, getPrice: market.getPrice })
  : new LocalBroker({ kv, startingCash: config.startingCash, getPrice: market.getPrice });

const bot = new TradingBot({ broker, market, ai: config.ai, settings: config.bot, kv, autoStart: config.bot.autoStart });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => res.status(400).json({ error: err.message }));

// Serverless instances don't share memory: always start from the persisted bot state.
app.use('/api', (req, res, next) => {
  if (bot.busy) return next(); // a cycle in this process holds the freshest state
  bot.load().then(() => next(), (err) => res.status(500).json({ error: `Storage: ${err.message}` }));
});

app.get('/api/status', wrap(async (req, res) => {
  // On Vercel there is no background timer, so an open dashboard also drives the schedule.
  if (config.serverless) await bot.tick().catch(() => {});
  res.json(await bot.status());
}));
app.get('/api/market', wrap(async (req, res) => {
  const granularity = Number(req.query.granularity) || bot.settings.granularity;
  const candles = await market.getCandles(granularity, 200);
  res.json({ candles, indicators: summarize(candles), ifvgs: findIfvgs(candles).slice(-6) });
}));
app.get('/api/account', wrap(async (req, res) => res.json(await broker.getAccount())));
app.get('/api/orders', wrap(async (req, res) => res.json(await broker.getOrders(100))));
app.get('/api/decisions', wrap(async (req, res) => res.json(await bot.decisions(100))));
app.get('/api/trades', wrap(async (req, res) => res.json(await bot.trades())));
app.get('/api/trades/:id/shots', wrap(async (req, res) => res.json(await bot.shots(String(req.params.id)))));

app.post('/api/bot/start', wrap(async (req, res) => res.json(await bot.setRunning(true))));
app.post('/api/bot/stop', wrap(async (req, res) => res.json(await bot.setRunning(false))));
app.post('/api/bot/run', wrap(async (req, res) => res.json(await bot.runOnce({ manual: true }))));
app.post('/api/settings', wrap(async (req, res) => res.json(await bot.updateSettings(req.body || {}))));

// Scheduler hook for serverless hosts (GitHub Actions / Vercel Cron / any uptime pinger).
const cron = wrap(async (req, res) => {
  if (config.cronSecret && req.get('authorization') !== `Bearer ${config.cronSecret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const result = await bot.tick();
  res.json({ ok: true, ran: Boolean(result), note: result?.note ?? null });
});
app.get('/api/cron', cron);
app.post('/api/cron', cron);

app.post('/api/order', wrap(async (req, res) => {
  const { side, amount } = req.body || {};
  const price = await market.getPrice();
  if (side === 'buy') return res.json(await broker.placeOrder({ side, notional: Number(amount), price }));
  if (side === 'sell') return res.json(await broker.placeOrder({ side, qty: Number(amount), price }));
  throw new Error('side must be buy or sell');
}));
app.post('/api/reset', wrap(async (req, res) => {
  await broker.reset();
  await Promise.all([kv.set('trades', []), kv.set('decisions', [])]);
  res.json({ ok: true });
}));

if (!config.serverless) {
  app.listen(config.port, () => {
    console.log(`BTC AI paper-trading site on http://localhost:${config.port}`);
    console.log(`AI: ${config.ai.apiKey ? `${config.ai.provider} (${config.ai.model})` : 'rule-based fallback (no AI key)'} | Broker: ${broker.name} | Storage: ${kv.name}`);
    // Every minute: enforce stops/targets, and scan for IFVG setups whenever the interval has passed.
    const loop = () => bot.tick().catch((err) => console.error('tick:', err.message));
    loop();
    setInterval(loop, 60000);
  });
}

export default app;
