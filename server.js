import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import * as market from './src/market.js';
import { LocalBroker } from './src/brokers/local.js';
import { AlpacaBroker } from './src/brokers/alpaca.js';
import { TradingBot } from './src/bot.js';
import { summarize } from './src/indicators.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const broker = config.broker === 'alpaca'
  ? new AlpacaBroker({ ...config.alpaca, getPrice: market.getPrice })
  : new LocalBroker({ dataDir: config.dataDir, startingCash: config.startingCash, getPrice: market.getPrice });

const bot = new TradingBot({ broker, market, ai: config.ai, settings: config.bot, dataDir: config.dataDir });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => res.status(400).json({ error: err.message }));

app.get('/api/status', wrap(async (req, res) => res.json(bot.status())));
app.get('/api/market', wrap(async (req, res) => {
  const granularity = Number(req.query.granularity) || bot.settings.granularity;
  const candles = await market.getCandles(granularity, 200);
  res.json({ candles, indicators: summarize(candles) });
}));
app.get('/api/account', wrap(async (req, res) => res.json(await broker.getAccount())));
app.get('/api/orders', wrap(async (req, res) => res.json(await broker.getOrders(100))));
app.get('/api/decisions', wrap(async (req, res) => res.json(bot.decisions(100))));

app.post('/api/bot/start', wrap(async (req, res) => { bot.start(); res.json(bot.status()); }));
app.post('/api/bot/stop', wrap(async (req, res) => { bot.stop(); res.json(bot.status()); }));
app.post('/api/bot/run', wrap(async (req, res) => res.json(await bot.runOnce())));
app.post('/api/settings', wrap(async (req, res) => res.json(bot.updateSettings(req.body || {}))));

app.post('/api/order', wrap(async (req, res) => {
  const { side, amount } = req.body || {};
  const price = await market.getPrice();
  if (side === 'buy') return res.json(await broker.placeOrder({ side, notional: Number(amount), price }));
  if (side === 'sell') return res.json(await broker.placeOrder({ side, qty: Number(amount), price }));
  throw new Error('side must be buy or sell');
}));
app.post('/api/reset', wrap(async (req, res) => { await broker.reset(); res.json({ ok: true }); }));

app.listen(config.port, () => {
  console.log(`BTC AI paper-trading site on http://localhost:${config.port}`);
  console.log(`AI: ${config.ai.apiKey ? `${config.ai.provider} (${config.ai.model})` : 'rule-based fallback (no AI key)'} | Broker: ${broker.name}`);
  if (config.bot.autoStart) bot.start();
});
