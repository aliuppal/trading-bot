// Backtest: replays the real bot (scan, IFVG rules, grading, path check, liquidity, brackets, limits, reviews)
// minute by minute over past BTC candles, without lookahead: at each minute only closed candles are visible and
// the still-forming candle of every timeframe is rebuilt from the 1m candles up to that moment.
//
//   node scripts/backtest.js --days=3 --mode=mechanical --rr=2 --be=1 --fee=0.05 --minstop=0.3 --only=clear --nosignal
//   mechanical: every qualifying setup is taken (a stand-in for Jev that always agrees, never closes on review)
//   jev:        real Jev decisions (needs OPENROUTER_API_KEY); entries and reviews cost OpenRouter credit
import { TradingBot } from '../src/bot.js';
import { LocalBroker } from '../src/brokers/local.js';
import { aggregate } from '../src/ifvg.js';

// Named options: --days=3 --mode=mechanical|jev --rr=1 --be=0 --fee=0.1 --minstop=0.15 --only=clear|aplus|scalp|swing|long|short --nosignal --quiet
const opt = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const DAYS = Number(opt.days || 3);
const MODE = opt.mode || 'mechanical';
const RR = Number(opt.rr || 1); // risk:reward target multiple
const BE = Number(opt.be || 0); // move stop to breakeven at +N R (0 = off)
const FEE = Number(opt.fee ?? 0.1); // % per side
const MINSTOP = Number(opt.minstop || 0.15); // smallest stop distance, % of price
const ONLY = String(opt.only || '').split(',').filter(Boolean);
const NOSIGNAL = Boolean(opt.nosignal);
const MIN = 60000;

class MemKV {
  constructor() { this.m = new Map(); this.name = 'memory'; }
  async get(k, d) { return this.m.has(k) ? structuredClone(this.m.get(k)) : structuredClone(d); }
  async set(k, v) { this.m.set(k, structuredClone(v)); }
  async del(k) { this.m.delete(k); }
}

async function getJson(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'trading-bot-backtest/1.0' } });
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw new Error(`fetch failed: ${url}`);
}

/** Coinbase candles in [start, end), paginated 300 at a time, oldest first. */
async function fetchRange(gran, start, end) {
  const out = new Map();
  for (let t = start; t < end; t += gran * 1000 * 300) {
    const e = Math.min(end, t + gran * 1000 * 300);
    const rows = await getJson(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${gran}&start=${new Date(t).toISOString()}&end=${new Date(e).toISOString()}`);
    for (const [ts, low, high, open, close, volume] of rows) out.set(ts * 1000, { time: ts * 1000, open, high, low, close, volume });
    await new Promise((r) => setTimeout(r, 120));
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

/** Index of the last element with time <= t (binary search). */
function lastAtOrBefore(arr, t) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

/** The still-forming candle of a bucket, built from the 1m candles that closed by `now`. */
function partial(m1, bucketStart, now) {
  const i0 = lastAtOrBefore(m1, bucketStart - 1) + 1;
  const i1 = lastAtOrBefore(m1, now - MIN);
  if (i1 < i0) return null;
  const s = m1.slice(i0, i1 + 1);
  return { time: bucketStart, open: s[0].open, high: Math.max(...s.map((c) => c.high)), low: Math.min(...s.map((c) => c.low)), close: s.at(-1).close, volume: 0 };
}

async function main() {
  const end = Math.floor(Date.now() / MIN) * MIN - MIN;
  const start = end - DAYS * 86400000;
  console.log(`Loading candles: ${new Date(start).toISOString()} -> ${new Date(end).toISOString()} (${DAYS} days)...`);
  const series = {
    60: await fetchRange(60, start - 320 * MIN, end + MIN),
    300: await fetchRange(300, start - 320 * 5 * MIN, end + MIN),
    900: await fetchRange(900, start - 320 * 15 * MIN, end + MIN),
    3600: await fetchRange(3600, start - 320 * 60 * MIN, end + MIN),
    86400: await fetchRange(86400, start - 35 * 86400000, end + MIN),
  };
  series[120] = aggregate(series[60], 120);
  series[180] = aggregate(series[60], 180);
  series[1800] = aggregate(series[900], 1800);
  series[7200] = aggregate(series[3600], 7200);
  series[14400] = aggregate(series[3600], 14400);
  console.log(`  1m ${series[60].length} · 5m ${series[300].length} · 15m ${series[900].length} · 1h ${series[3600].length} candles`);

  let now = start;
  const market = {
    getCandles: async (g, n = 200) => {
      const arr = series[g];
      const closedIdx = lastAtOrBefore(arr, now - g * 1000); // candles whose close time <= now
      const closed = arr.slice(Math.max(0, closedIdx - n + 2), closedIdx + 1);
      const bucket = Math.floor(now / (g * 1000)) * g * 1000;
      const p = g === 60 ? null : partial(series[60], bucket, now);
      return p && p.time > (closed.at(-1)?.time ?? 0) ? [...closed, p] : closed;
    },
    getPrice: async () => series[60][lastAtOrBefore(series[60], now - MIN)].close,
  };

  // Stand-in for Jev in mechanical mode: agree with the setup direction, keep open trades on review.
  let jevCalls = 0;
  const mechanical = async (url, opts) => {
    jevCalls++;
    const body = JSON.parse(opts.body);
    const st = body.state;
    const review = body.questions.action.criteria.CLOSE !== undefined;
    let choice = review ? 'HOLD' : st.trade_direction === 'long' ? 'BUY' : st.trade_direction === 'short' ? 'SELL' : 'HOLD';
    // optional filters on what the stand-in accepts
    const q = String(st.setup_quality || '');
    if (!review && st.open_trade !== 'none' && NOSIGNAL) choice = 'HOLD'; // never close early on an opposite setup
    if (!review && st.open_trade === 'none') {
      if (ONLY.includes('clear') && !q.includes('clear path')) choice = 'HOLD';
      if (ONLY.includes('aplus') && st.setup_grade !== 'A+') choice = 'HOLD';
      if (ONLY.includes('scalp') && st.trade_type !== 'scalp') choice = 'HOLD';
      if (ONLY.includes('swing') && st.trade_type !== 'swing') choice = 'HOLD';
      if (ONLY.includes('long') && st.trade_direction !== 'long') choice = 'HOLD';
      if (ONLY.includes('short') && st.trade_direction !== 'short') choice = 'HOLD';
    }
    const probs = review ? { HOLD: 0.9, CLOSE: 0.1 } : { BUY: 0.03, SELL: 0.03, HOLD: 0.04, [choice]: 0.9 };
    return { ok: true, json: async () => ({ answers: { action: { choice, probabilities: probs, confidence: 0.9 }, size: { score: 2 }, leverage: { score: 0 } }, model: 'mechanical' }) };
  };
  const realFetch = async (...a) => { jevCalls++; return fetch(...a); };

  const kv = new MemKV();
  const broker = new LocalBroker({ kv, startingCash: 5000, getPrice: market.getPrice, feeRate: FEE / 100 });
  const settings = {
    intervalMinutes: 1, granularity: 300, minConfidence: 0.6, maxPositionPct: 50, maxTradePct: 10,
    maxTradesPerDay: 10, maxSwingPerDay: 5, maxScalpPerDay: 5, ifvgMaxAge: 7, requireHtfTap: true,
    entryTimeframes: 'all', scalpEnabled: true, requireDisplacement: false, targetMode: 'rr', riskReward: RR, breakevenAtR: BE, minStopPct: MINSTOP, maxLeverage: 5,
  };
  const ai = MODE === 'jev'
    ? { provider: 'jev', apiKey: process.env.OPENROUTER_API_KEY, model: 'typesafe/jev-1.13' }
    : { provider: 'jev', apiKey: 'mechanical', model: 'mechanical' };
  if (MODE === 'jev' && !ai.apiKey) throw new Error('OPENROUTER_API_KEY is required for mode=jev');
  const bot = new TradingBot({ broker, market, ai, settings, kv, autoStart: true, now: () => now, fetchImpl: MODE === 'jev' ? realFetch : mechanical });

  const t0 = Date.now();
  let steps = 0, lastDay = '';
  for (now = start + 1000; now <= end; now += MIN) {
    await bot.runOnceUnlocked();
    steps++;
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== lastDay) { lastDay = day; process.stderr.write(`  simulating ${day}...\n`); }
  }
  const trades = await bot.trades();
  const decisions = await bot.decisions(5000);

  // ---- report ----
  const fmt = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
  const closed = trades.filter((t) => t.status !== 'open').reverse();
  const open = trades.filter((t) => t.status === 'open');
  const stat = (arr) => {
    const w = arr.filter((t) => t.status === 'win').length, l = arr.filter((t) => t.status === 'loss').length, be = arr.filter((t) => t.status === 'breakeven').length;
    const pnl = arr.reduce((a, t) => a + (t.pnl || 0), 0);
    return `${String(arr.length).padStart(2)} trades · ${w}W ${l}L ${be}BE · win rate ${w + l ? Math.round((w / (w + l)) * 100) : 0}% · net ${arr.reduce((a, t) => a + (t.r || 0), 0).toFixed(2)}R · P&L ${fmt(pnl)}`;
  };
  console.log(`\n=== Backtest ${DAYS} days · mode: ${MODE} · ${steps} minutes simulated in ${((Date.now() - t0) / 1000).toFixed(0)}s · ${MODE === 'jev' ? 'Jev calls' : 'stand-in calls'}: ${jevCalls} ===`);
  console.log(`Account: $5,000 (simulated, 1x, ${FEE}% fee/side) · 1:${RR} R:R${BE ? ` · breakeven at +${BE}R` : ''} · min stop ${MINSTOP}%${ONLY.length ? ` · only ${ONLY.join('+')}` : ''}${NOSIGNAL ? ' · no early signal exits' : ''} · 10% per trade · limits 5 swing / 5 scalp / 10 per day\n`);
  if (!opt.quiet) console.log('Trades:');
  for (const t of opt.quiet ? [] : closed) {
    console.log(`  ${t.entryTime.slice(5, 16).replace('T', ' ')} ${String(t.ifvg?.grade || '').padEnd(2)} ${(t.category || 'swing').padEnd(5)} ${t.side.padEnd(5)} ${String(t.granularity / 60 + 'm').padEnd(3)} ${t.entryPrice.toFixed(0)} -> ${t.exitPrice.toFixed(0)} ${String(t.exitReason).padEnd(9)} ${t.status.toUpperCase().padEnd(9)} ${(t.r > 0 ? '+' : '') + t.r}R ${fmt(t.pnl)}`);
    console.log(`        ${t.setupReason || ''}`);
  }
  for (const t of open) console.log(`  ${t.entryTime.slice(5, 16).replace('T', ' ')} ${t.side} still OPEN at the end (entry ${t.entryPrice.toFixed(0)})`);
  console.log(`\nSummary   ${stat(closed)}`);
  for (const cat of ['swing', 'scalp']) console.log(`  ${cat.padEnd(6)}  ${stat(closed.filter((t) => (t.category || 'swing') === cat))}`);
  console.log(`  A+      ${stat(closed.filter((t) => t.ifvg?.grade === 'A+'))}`);
  for (const side of ['long', 'short']) console.log(`  ${side.padEnd(6)}  ${stat(closed.filter((t) => t.side === side))}`);
  console.log('By day (UTC, exit date):');
  for (const d of [...new Set(closed.map((t) => t.exitTime.slice(0, 10)))]) console.log(`  ${d}  ${stat(closed.filter((t) => t.exitTime.slice(0, 10) === d))}`);
  const asked = decisions.filter((d) => d.confidence !== undefined && d.source !== 'bracket');
  console.log(`\nSetups decided by ${MODE === 'jev' ? 'Jev' : 'the stand-in'}: ${asked.length} · executed: ${asked.filter((d) => d.executed).length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
