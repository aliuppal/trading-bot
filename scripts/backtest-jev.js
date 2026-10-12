// Backtest of the Jev model (Jev alone decides, no pattern filter) on Binance USD-M futures candles.
// Replays the real bot minute by minute without lookahead (only closed candles + the forming candle rebuilt
// from 1m candles), with real Jev calls: every call costs OpenRouter credit (needs OPENROUTER_API_KEY in .env).
//
//   node scripts/backtest-jev.js --symbol=SOLUSDT --start=2026-09-01 --days=7 --minconf=0.6 --be=1 --out=sol.json
//   --dry: a stand-in that always says HOLD (no credit used), to check the data and the timing
//   Weekends (Sat-Sun UTC) are skipped like the live weekend pause; open trades still hit stop / target.
import 'dotenv/config';
import fs from 'node:fs';
import { TradingBot } from '../src/bot.js';
import { LocalBroker } from '../src/brokers/local.js';
import { aggregate } from '../src/ifvg.js';

const opt = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const SYMBOL = opt.symbol || 'BTCUSDC';
const START = Date.parse(`${opt.start || '2026-09-01'}T00:00:00Z`);
const DAYS = Number(opt.days || 7);
const END = START + DAYS * 86400000;
const DRY = opt.dry || false; // true, or 'trade'
const MIN = 60000;
const INTERVAL = { 60: '1m', 300: '5m', 900: '15m', 3600: '1h', 14400: '4h', 86400: '1d' };

async function getJson(url) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url).catch(() => null);
    if (res?.ok) return res.json();
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  throw new Error(`fetch failed: ${url}`);
}

/** Binance futures klines in [start, end), oldest first. */
async function klines(symbol, g, start, end) {
  const out = [];
  for (let t = start; t < end;) {
    const rows = await getJson(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${INTERVAL[g]}&startTime=${t}&endTime=${end - 1}&limit=1500`);
    if (!rows.length) break;
    for (const k of rows) out.push({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    t = rows.at(-1)[0] + g * 1000;
  }
  return out;
}

function lastAtOrBefore(arr, t) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
function partial(m1, bucketStart, now) {
  const i0 = lastAtOrBefore(m1, bucketStart - 1) + 1;
  const i1 = lastAtOrBefore(m1, now - MIN);
  if (i1 < i0) return null;
  const s = m1.slice(i0, i1 + 1);
  return { time: bucketStart, open: s[0].open, high: Math.max(...s.map((c) => c.high)), low: Math.min(...s.map((c) => c.low)), close: s.at(-1).close, volume: 0 };
}

class MemKV {
  constructor() { this.m = new Map(); this.name = 'memory'; }
  async get(k, d) { return this.m.has(k) ? structuredClone(this.m.get(k)) : structuredClone(d); }
  async set(k, v) { this.m.set(k, structuredClone(v)); }
  async del(k) { this.m.delete(k); }
}

async function main() {
  process.stderr.write(`${SYMBOL}: loading candles ${new Date(START).toISOString().slice(0, 10)} + ${DAYS} days...\n`);
  const series = {};
  for (const g of [60, 300, 900, 3600, 14400]) series[g] = await klines(SYMBOL, g, START - 320 * g * 1000, END + MIN);
  series[86400] = await klines(SYMBOL, 86400, START - 40 * 86400000, END + MIN);
  series[120] = aggregate(series[60], 120);
  series[180] = aggregate(series[60], 180);
  series[1800] = aggregate(series[900], 1800);
  series[7200] = aggregate(series[3600], 7200);

  let now = START;
  const realNow = Date.now;
  Date.now = () => now; // the session, review and daily-limit clocks all follow the simulation
  const market = {
    getCandles: async (g, n = 200) => {
      const arr = series[g] || aggregate(series[60], g);
      const i = lastAtOrBefore(arr, now - g * 1000);
      const closed = arr.slice(Math.max(0, i - n + 2), i + 1);
      const bucket = Math.floor(now / (g * 1000)) * g * 1000;
      const p = g === 60 ? null : partial(series[60], bucket, now);
      return p && p.time > (closed.at(-1)?.time ?? 0) ? [...closed, p] : closed;
    },
    getPrice: async () => series[60][lastAtOrBefore(series[60], now - MIN)].close,
  };

  let calls = 0, cost = 0;
  const jevFetch = async (url, o) => {
    calls++;
    if (DRY) {
      // --dry=trade: a BUY / SELL every 15th call (swing or scalp), to exercise the trade path without credit
      const pick = DRY === 'trade' && calls % 15 === 0 ? (calls % 30 === 0 ? 'BUY' : 'SELL') : 'HOLD';
      const review = JSON.parse(o.body).questions.action.criteria.CLOSE !== undefined;
      const choice = review ? 'HOLD' : pick;
      return { ok: true, json: async () => ({ answers: { action: { choice, probabilities: { BUY: 0.1, SELL: 0.1, HOLD: 0.1, CLOSE: 0.1, [choice]: 0.8 }, confidence: 0.5 }, style: { choice: calls % 2 ? 'SCALP' : 'SWING' }, size: { score: 1 }, leverage: { score: 1 } }, model: 'dry' }) };
    }
    const res = await fetch(url, o);
    const body = await res.json();
    cost += Number(body?.usage?.cost) || 0;
    return { ok: res.ok, status: res.status, text: async () => JSON.stringify(body), json: async () => body };
  };

  const kv = new MemKV();
  const broker = new LocalBroker({ kv, startingCash: 1000000, getPrice: market.getPrice, feeRate: Number(opt.fee ?? 0.05) / 100 });
  // the live Jev model settings
  const settings = {
    model: 'jev', intervalMinutes: 1, granularity: 300, minConfidence: Number(opt.minconf ?? 0.6), maxPositionPct: 50, maxTradePct: 10,
    maxSwingPerDay: 30, maxScalpPerDay: 30, maxOpenTrades: 4, scalpEnabled: true, swingEnabled: true, riskReward: 1,
    targetMode: 'liquidity', sizingMode: 'risk', riskPerTradeUsd: Number(opt.risk ?? 100), minStopPct: 0.15, breakevenAtR: Number(opt.be ?? 0),
    maxLeverage: 125, learnFromTrades: true, weekendPause: false,
  };
  const ai = { provider: 'jev', apiKey: DRY ? 'dry' : process.env.OPENROUTER_API_KEY, model: 'typesafe/jev-1.13' };
  if (!ai.apiKey) throw new Error('OPENROUTER_API_KEY is missing: add it to trading-bot/.env');
  const bot = new TradingBot({ broker, market, ai, settings, kv, autoStart: true, now: () => now, fetchImpl: jevFetch, symbol: SYMBOL, primary: true });

  const t0 = realNow();
  let lastDay = '';
  for (now = START + 1000; now <= END; now += MIN) {
    const d = new Date(now);
    const weekend = d.getUTCDay() === 6 || d.getUTCDay() === 0;
    const day = d.toISOString().slice(0, 10);
    if (day !== lastDay) { lastDay = day; process.stderr.write(`${SYMBOL}: ${day}${weekend ? ' (weekend: paused)' : ''} · Jev calls so far ${calls}\n`); }
    if (weekend) continue;
    try { await bot.runOnceUnlocked(); } catch (e) { process.stderr.write(`${SYMBOL} ${d.toISOString()}: ${e.message}\n`); }
  }
  // close the books: one more pass at the end (stops / targets hit during the last weekend)
  try { await bot.runOnceUnlocked(); } catch { /* ignore */ }
  const trades = await bot.trades();
  const decisions = (await bot.decisions(20000)).filter((d) => d.action !== 'HOLD' || d.executed).map((d) => ({ time: d.time, action: d.action, confidence: d.confidence, executed: d.executed, note: d.note, reasoning: d.reasoning }));
  const out = { symbol: SYMBOL, decisions, start: START, days: DAYS, calls, cost, seconds: Math.round((realNow() - t0) / 1000), settings, trades };
  fs.writeFileSync(opt.out || `bt-jev-${SYMBOL}.json`, JSON.stringify(out));
  process.stderr.write(`${SYMBOL}: done · ${trades.length} trades · ${calls} Jev calls · $${cost.toFixed(4)} · ${out.seconds}s\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
