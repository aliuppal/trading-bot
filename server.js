import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import * as coinbase from './src/market.js';
import { LocalBroker } from './src/brokers/local.js';
import { BinanceFuturesBroker } from './src/brokers/binance.js';
import { TradingBot } from './src/bot.js';
import { summarize } from './src/indicators.js';
import { findIfvgs, minGapFor } from './src/ifvg.js';
import { createKV } from './src/store.js';
import { loadHtfZones } from './src/strategy.js';
import { liquidityLevels } from './src/liquidity.js';
import { chatAnswer } from './src/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Prices come from the venue the bot trades on: Binance BTCUSDC for BROKER=binance, else Coinbase BTC-USD.
const market = config.broker === 'binance' ? coinbase.binanceMarket(config.binance) : coinbase;

const kv = createKV({ dataDir: config.dataDir, redis: config.redis, supabase: config.supabase });
const local = new LocalBroker({ kv, startingCash: config.startingCash, getPrice: market.getPrice });
// BROKER=binance: Binance USD-M futures demo account (BTCUSDT, longs and shorts). Default: built-in simulation.
const broker = config.broker === 'binance'
  ? new BinanceFuturesBroker({ ...config.binance, getPrice: market.getPrice })
  : local;

const bot = new TradingBot({
  broker, market, ai: config.ai, settings: config.bot, kv, autoStart: config.bot.autoStart,
  fallbackBroker: broker === local ? null : local,
  symbol: config.broker === 'binance' ? config.binance.symbol : 'BTCUSDC', primary: true,
});

// One bot per extra symbol (Binance): they share settings, daily limits, the open-trade cap and the trade history.
const bots = [bot];
const markets = { [bot.symbol]: market };
if (config.broker === 'binance') {
  for (const sym of config.binance.symbols.filter((x) => x !== bot.symbol)) {
    const m = coinbase.binanceMarket({ ...config.binance, symbol: sym });
    const br = new BinanceFuturesBroker({ ...config.binance, symbol: sym, getPrice: m.getPrice });
    markets[sym] = m;
    // SMT pair: ETH for BTC, BTC for everything else
    bots.push(new TradingBot({ broker: br, market: m, ai: config.ai, settings: config.bot, kv, autoStart: config.bot.autoStart, symbol: sym, primary: false, pairMarket: market }));
  }
  const eth = Object.keys(markets).find((k) => k.startsWith('ETH'));
  if (eth) bot.pairMarket = markets[eth];
}
const botFor = (sym) => bots.find((b) => b.symbol === sym) || bot;
/** One locked pass over every symbol (stops / targets, scans, Jev). */
const tickAll = () => bot.locked(async () => {
  const out = [];
  for (const b of bots) out.push(await b.tickUnlocked().catch((e) => ({ action: 'ERROR', note: `${b.symbol}: ${e.message}` })));
  return out;
});

const app = express();
app.use(express.json());
// always revalidate the page, script and styles, so a deploy shows up without a hard refresh
app.use(express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => res.status(400).json({ error: err.message }));

// Serverless instances don't share memory: always start from the persisted bot state.
app.use('/api', (req, res, next) => {
  if (bot.busy) return next(); // a cycle in this process holds the freshest state
  bot.load().then(() => next(), (err) => res.status(500).json({ error: `Storage: ${err.message}` }));
});

app.get('/api/status', wrap(async (req, res) => {
  // On Vercel there is no background timer, so an open dashboard also drives the schedule.
  if (config.serverless) await tickAll().catch(() => {});
  const st = await bot.status();
  if (bots.length > 1) {
    // daily scan counter summed over every symbol, plus each symbol's last scan
    await Promise.all(bots.slice(1).map((b) => b.load()));
    const day = new Date().toISOString().slice(0, 10);
    const sum = { day };
    for (const b of bots) {
      const ss = b.state.scanStats;
      if (ss?.day !== day) continue;
      for (const [k, v] of Object.entries(ss)) if (typeof v === 'number') sum[k] = (sum[k] || 0) + v;
    }
    st.scanStats = sum.scans ? sum : st.scanStats;
    st.symbols = bots.map((b) => ({ symbol: b.symbol, lastScan: b.state.lastScan?.note ?? null }));
    // live price for each open trade (cards show its P&L whatever symbol is charted)
    await Promise.all((st.openTrades || []).map(async (t) => { t.lastPrice = await markets[t.symbol || bot.symbol]?.getPrice().catch(() => null); }));
  }
  res.json(st);
}));
app.get('/api/market', wrap(async (req, res) => {
  const granularity = Number(req.query.granularity) || bot.settings.granularity;
  const market = markets[req.query.symbol] || markets[bot.symbol]; // the chart's symbol
  const candles = await market.getCandles(granularity, 300); // 300 = more history to scroll back through
  const price = candles.at(-1)?.close ?? 0;
  // Active 1h/2h/4h FVGs within 3% of price, for the chart overlay.
  const htfZones = (await loadHtfZones(market, ['30m', '1h', '2h', '4h']).catch(() => []))
    .filter((z) => ['30m', '1h', '2h', '4h'].includes(z.tf) && Math.abs((z.top + z.bottom) / 2 - price) / price < 0.03)
    .slice(-12);
  const liq = await liquidityLevels(market).catch(() => null);
  const liquidity = liq ? [...liq.above.slice(0, 5), ...liq.below.slice(0, 5)] : [];
  res.json({ candles, indicators: summarize(candles), ifvgs: findIfvgs(candles, { strict: true, minGapPct: minGapFor(granularity) }).slice(-6), htfZones, liquidity, lrlr: liq?.lrlr ?? null });
}));
app.get('/api/account', wrap(async (req, res) => {
  const a = await broker.getAccount();
  const other = bots.find((b) => b !== bot && b.broker.name === 'binance' && !b.symbol.endsWith(a.marginAsset || 'USDC'));
  const u = other && (await other.broker.getAccount().catch(() => null));
  if (!u) return res.json(a);
  // USDC (BTC) + USDT (the other symbols) futures balances together
  res.json({ ...a, marginAsset: `${a.marginAsset} + ${u.marginAsset}`, cash: a.cash + u.cash, equity: a.equity + u.equity, accountEquity: a.equity + u.equity, accounts: { [a.marginAsset]: a, [u.marginAsset]: u } });
}));
app.get('/api/orders', wrap(async (req, res) => {
  const lists = await Promise.all(bots.map((b) => b.broker.getOrders(40).then((os) => os.map((o) => ({ ...o, symbol: b.symbol }))).catch(() => [])));
  const seen = new Set();
  res.json(lists.flat().filter((o) => !seen.has(`${o.symbol}:${o.id}`) && seen.add(`${o.symbol}:${o.id}`)).sort((x, y) => new Date(y.time) - new Date(x.time)).slice(0, 100));
}));
// Tiny polling endpoint: the dashboard reloads its tables only when this changes.
app.get('/api/changes', wrap(async (req, res) => res.json({ sig: await bot.changeSignature() })));
app.get('/api/decisions', wrap(async (req, res) => res.json(await bot.decisions(100))));
// Latest Jev reasoning for one symbol (searches the whole stored decision log)
app.get('/api/jev/last', wrap(async (req, res) => {
  const sym = String(req.query.symbol || bot.symbol);
  const mine = (await bot.decisions(1000)).filter((d) => (d.symbol || 'BTCUSDC') === sym);
  res.json(mine.find((d) => /^jev/.test(d.source || '') && d.reasoning) || mine.find((d) => d.reasoning) || mine[0] || null);
}));
app.get('/api/trades', wrap(async (req, res) => res.json(await bot.allTrades())));
app.get('/api/trades/:id/shots', wrap(async (req, res) => {
  const id = String(req.params.id);
  const t = (await bot.allTrades()).find((x) => x.id === id);
  res.json(await botFor(t?.symbol || bot.symbol).shotsFor(id));
}));

app.post('/api/bot/start', wrap(async (req, res) => res.json(await bot.setRunning(true))));
app.post('/api/bot/stop', wrap(async (req, res) => res.json(await bot.setRunning(false))));
app.post('/api/bot/run', wrap(async (req, res) => {
  // "Ask AI now": every symbol, one after another
  const out = await bot.locked(async () => { const r = []; for (const b of bots) { await b.load(); r.push(await b.runOnceUnlocked({ manual: true })); } return r; });
  if (out === null) throw new Error('Another bot cycle is running right now, try again in a few seconds');
  res.json(out.find((e) => e.executed) || { action: 'HOLD', note: out.map((e) => `${e.symbol || ''} ${e.action}${e.confidence !== undefined ? ` ${Math.round(e.confidence * 100)}%` : ''}`).join(' · ') });
}));
// JEV overview: Jev's BUY / SELL / HOLD odds and model confidence for every symbol, in parallel. Read-only, no trades.
app.get('/api/jev/overview', wrap(async (req, res) => {
  await Promise.all(bots.slice(1).map((b) => b.load()));
  res.json(await Promise.all(bots.map((b) => b.jevView().catch((e) => ({ symbol: b.symbol, error: /HTTP 402/.test(e.message) ? 'OpenRouter credits used up: add credits at openrouter.ai/settings/credits' : /HTTP 401/.test(e.message) ? 'OpenRouter key rejected' : e.message.slice(0, 160) })))));
}));
// Daily suggestions for the selected model: list, approve (applies the change), ignore, generate now
app.get('/api/suggestions', wrap(async (req, res) => res.json(await bot.suggestions())));
app.post('/api/suggestions/generate', wrap(async (req, res) => res.json(await bot.generateSuggestions(req.body?.day || undefined))));
app.post('/api/suggestions/:id/approve', wrap(async (req, res) => res.json(await bot.decideSuggestion(String(req.params.id), true))));
app.post('/api/suggestions/:id/ignore', wrap(async (req, res) => res.json(await bot.decideSuggestion(String(req.params.id), false))));
// Chat assistant (lower-right bubble): answers from the live bot data, read-only.
app.post('/api/chat', wrap(async (req, res) => {
  if (!config.ai.apiKey) throw new Error('Chat needs the OpenRouter key (OPENROUTER_API_KEY)');
  await Promise.all(bots.slice(1).map((b) => b.load()));
  const st = await bot.status();
  const pick = (t) => ({ symbol: t.symbol || 'BTCUSDC', model: t.model || 'ifvg', side: t.side, category: t.category, tf: t.granularity ? t.granularity / 60 + 'm' : null, status: t.status, entry: t.entryPrice, stop: t.stop, target: t.target, exit: t.exitPrice, exitReason: t.exitReason, r: t.r, pnl: t.pnl, fees: t.fees, opened: t.entryTime, closed: t.exitTime, reason: (t.setupReason || '').slice(0, 300) });
  const trades = (await bot.allTrades()).slice(0, 25).map(pick);
  const decisions = (await bot.decisions(20)).map((d) => ({ time: d.time, symbol: d.symbol, action: d.label || d.action, confidence: d.confidence, executed: d.executed, note: (d.note || '').slice(0, 200), reasoning: (d.reasoning || '').slice(0, 160) }));
  const context = {
    now: new Date().toISOString(), running: st.running, model: st.model, modelName: st.models?.[st.model], modelRules: st.modelRules?.[st.model],
    settings: st.settings && Object.fromEntries(Object.entries(st.settings).filter(([k]) => k !== 'modelConfigs')),
    tradesToday: st.tradesToday, swingToday: st.swingToday, scalpToday: st.scalpToday, scanStats: st.scanStats,
    openTrades: (st.openTrades || []).map(pick), symbols: bots.map((b) => ({ symbol: b.symbol, lastScan: b.state.lastScan?.note ?? null })),
    liquidity: st.liquidity, recentTrades: trades, recentDecisions: decisions,
    jevReviewMinutes: { scalp: 3, swing5m: 3, swing15m: 30 },
    costs: 'Jev calls cost about $0.0001 each (about 6-10 per hour); chat uses the free OpenRouter router (openrouter/free); day-end research uses the free router plus web search (about $0.01 per run); typical total about $1-2 per month',
  };
  res.json(await chatAnswer({ messages: req.body?.messages, context, apiKey: config.ai.apiKey }));
}));
app.post('/api/settings', wrap(async (req, res) => res.json(await bot.updateSettings(req.body || {}))));

// Scheduler hook for serverless hosts (Supabase pg_cron calls it every minute, see supabase/cron.sql).
const cron = wrap(async (req, res) => {
  if (config.cronSecret && req.get('authorization') !== `Bearer ${config.cronSecret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const results = await tickAll();
  await bot.maybeDailySuggestions().catch(() => null); // previous day's suggestions, selected model
  const result = results && results.find((x) => x);
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
    console.log(`CryptoQuant Pro on http://localhost:${config.port}`);
    console.log(`AI: ${config.ai.apiKey ? `${config.ai.provider} (${config.ai.model})` : 'rule-based fallback (no AI key)'} | Broker: ${broker.name} | Storage: ${kv.name}`);
    // Every minute: enforce stops/targets, and scan for IFVG setups whenever the interval has passed.
    const loop = () => tickAll().catch((err) => console.error('tick:', err.message));
    loop();
    setInterval(loop, 60000);
  });
}

export default app;
