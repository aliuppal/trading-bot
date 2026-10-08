import { decide, askJev } from './ai.js';
import { summarize } from './indicators.js';
import { bracketFor } from './ifvg.js';
import { inSession, scanSetups, pathBlockers } from './strategy.js';
import { renderTradeImage } from './snapshot.js';
import { appendList } from './store.js';
import { liquidityLevels, liquidityTarget, liquidityTargets, describeLevels } from './liquidity.js';

const MIN_ORDER_USD = 10;
const MAX_TRADES_KEPT = 200;
const MAX_DECISIONS_KEPT = 1000;

/**
 * Turn an AI decision into a concrete order, applying risk limits.
 * Returns { order: {side, notional|qty} | null, note }.
 */
export function planTrade(decision, account, settings) {
  const { action, confidence, sizePct } = decision;
  if (action === 'HOLD') return { order: null, note: 'HOLD' };
  if (confidence < settings.minConfidence) {
    return { order: null, note: `Confidence ${confidence} below minimum ${settings.minConfidence}` };
  }
  if (action === 'BUY') {
    const notional = entryNotional(sizePct, account, settings);
    if (!notional) return { order: null, note: 'BUY skipped: position limit reached or not enough cash' };
    return { order: { side: 'buy', notional }, note: `BUY $${notional.toFixed(2)}` };
  }
  // SELL
  const pct = sizePct > 0 ? sizePct : 100;
  const qty = account.btc * (pct / 100);
  if (qty * account.price < MIN_ORDER_USD) return { order: null, note: 'SELL skipped: no meaningful BTC position' };
  return { order: { side: 'sell', qty: Number(qty.toFixed(8)) }, note: `SELL ${qty.toFixed(8)} BTC (${pct}%)` };
}

/** USD size for a new long or short: AI size capped by max trade %, max position % (longs + shorts) and cash. 0 = too small. */
export function entryNotional(sizePct, account, settings) {
  const pct = Math.min(sizePct || settings.maxTradePct, settings.maxTradePct);
  const exposure = (account.btc + (account.shortBtc || 0)) * account.price;
  const room = (settings.maxPositionPct / 100) * account.equity - exposure;
  const notional = Math.min((pct / 100) * account.equity, room, account.cash * 0.995);
  return notional < MIN_ORDER_USD ? 0 : Number(notional.toFixed(2));
}

/**
 * Risk-based size: the position whose stop loses about riskUsd. Leverage starts at Jev's pick, is raised up to
 * maxLev if the margin does not fit in 95% of the available cash, and only then is the risk trimmed (capped: true).
 */
export function riskSize({ riskUsd, stopDist, price, cash, levPick = 1, maxLev = 1, canLever = false }) {
  let qty = riskUsd / stopDist;
  let notional = qty * price;
  // liquidation must sit well beyond the stop: at most ~50% of the margin may be lost at the stop
  const safeLev = Math.max(1, Math.floor(0.5 / (stopDist / price)));
  const maxL = canLever ? Math.max(1, Math.min(maxLev, safeLev)) : 1;
  let lev = canLever ? Math.max(1, Math.min(Math.round(levPick || 1), maxL)) : 1;
  const usable = cash * 0.95;
  if (notional / lev > usable) lev = Math.min(maxL, Math.ceil(notional / usable));
  let capped = false;
  if (notional / lev > usable) { notional = usable * lev; qty = notional / price; capped = true; }
  return { notional: Number(notional.toFixed(2)), margin: Number((notional / lev).toFixed(2)), leverage: lev, riskUsd: Number((qty * stopDist).toFixed(2)), capped };
}

const utcDay = (t) => new Date(t).toISOString().slice(0, 10);

/** Where a scan stopped, for the daily scan counter. */
export function scanOutcome(reason) {
  if (!reason) return 'asked';
  if (/Managing open trade/.test(reason)) return 'inTrade';
  if (/limit/i.test(reason)) return 'limit';
  if (/waiting for/.test(reason)) return 'waiting';
  if (/FVG tap|not A+/.test(reason)) return 'noTap';
  if (/Already evaluated/.test(reason)) return 'seen';
  if (/no fresh IFVG|No fresh IFVG/i.test(reason)) return 'noIfvg';
  return 'other';
}

/** Number of trades opened on the same UTC day as `now` (optionally only one category: 'swing' / 'scalp'). */
export function tradesToday(trades, now = Date.now(), category) {
  const day = utcDay(now);
  return trades.filter((t) => utcDay(t.entryTime) === day && (!category || (t.category || 'swing') === category)).length;
}

/** Price at which the stop moves to breakeven (entry + breakevenAtR x risk), or null when that is off / done. */
export function breakevenLevel(trade) {
  const beR = Number(trade.breakevenAtR) || 0;
  if (!beR || trade.breakeven) return null;
  const risk = Math.abs(trade.entryPrice - (trade.initialStop ?? trade.stop));
  return trade.side === 'short' ? trade.entryPrice - beR * risk : trade.entryPrice + beR * risk;
}

/**
 * Walk the candles that opened after the entry, then the live price, in time order:
 *   stop hit   -> { exitPrice, reason: 'stop' } ('breakeven' once the stop sits at the entry)
 *   target hit -> { exitPrice, reason: 'target' }
 *   price reached the breakeven level -> the stop moves to the entry for the following candles.
 * If one candle touches stop and target the stop is assumed first (conservative).
 * Returns { exitPrice, reason, breakevenAt? }, { breakevenAt } when only the stop moved, or null.
 */
export function checkBracket(trade, candles, price, now = Date.now()) {
  const short = trade.side === 'short';
  const initialStop = trade.initialStop ?? trade.stop;
  let beAt = trade.breakeven ? new Date(trade.breakevenAt || trade.entryTime).getTime() : null;
  let beLevel = breakevenLevel(trade);
  const stopAt = (t) => (beAt !== null && t > beAt ? trade.entryPrice : initialStop);
  const stopHit = (lo, hi, stop) => (short ? hi >= stop : lo <= stop);
  const targetHit = (lo, hi) => (short ? lo <= trade.target : hi >= trade.target);
  const reached = (lo, hi) => beLevel !== null && (short ? lo <= beLevel : hi >= beLevel);
  let pLevel = trade.partialLevel && !trade.partial ? trade.partialLevel : null;
  let partialAt = null;
  const partialHit = (lo, hi) => pLevel !== null && (short ? lo <= pLevel : hi >= pLevel);
  const moved = () => ({ ...(trade.breakeven ? {} : beAt !== null ? { breakevenAt: beAt } : {}), ...(partialAt !== null ? { partialAt } : {}) });
  const exit = (stop) => ({ exitPrice: stop, reason: stop === trade.entryPrice && beAt !== null ? 'breakeven' : 'stop', ...moved() });
  const entryT = new Date(trade.entryTime).getTime();
  const steps = candles.filter((c) => c.time > entryT).map((c) => ({ t: c.time, lo: c.low, hi: c.high }));
  steps.push({ t: now, lo: price, hi: price });
  for (const { t, lo, hi } of steps) {
    const stop = stopAt(t);
    if (stopHit(lo, hi, stop)) return exit(stop);
    if (targetHit(lo, hi)) return { exitPrice: trade.target, reason: 'target', ...moved() };
    if (reached(lo, hi)) { beAt = t; beLevel = null; }
    // first internal liquidity: part of the position is taken off and the stop goes to the entry
    if (partialHit(lo, hi)) { partialAt = t; pLevel = null; if (beAt === null) beAt = t; beLevel = null; }
  }
  const m = moved();
  return Object.keys(m).length ? m : null;
}

/** Minutes between Jev reviews of an open trade: 5 for scalps, 15 for 5m entries, 30 for 15m entries. */
export function reviewMinutes(trade) {
  const g = trade.granularity || 900;
  if (trade.category === 'scalp' || g <= 60) return 5; // scalps (1m / 2m / 3m)
  return g <= 300 ? 15 : 30;
}

/** Is the open trade due for a Jev review (period counted from the last review, or from the entry)? */
export function reviewDue(trade, now = Date.now()) {
  const since = new Date(trade.lastReviewAt || trade.entryTime).getTime();
  return now - since >= reviewMinutes(trade) * 60000 - 5000;
}

function nextReviewLabel(trade) {
  const t = new Date(new Date(trade.lastReviewAt || trade.entryTime).getTime() + reviewMinutes(trade) * 60000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/** partialPct > 0: the first internal liquidity level between entry and target (>= 0.5R, short of the target). */
export function partialFor(settings, liquidity, side, entry, b) {
  const pct = Number(settings.partialPct) || 0;
  if (!pct || !liquidity || !b?.risk) return {};
  const lv = liquidityTargets(liquidity, side, entry, b.risk, { minR: 0.5, maxR: 20, max: 10 })
    .find((t) => (side === 'short' ? t.price > b.target : t.price < b.target) && Math.abs(t.price - b.target) / b.risk >= 0.25);
  return lv ? { partialPct: pct, partialLevel: lv.price } : {};
}

/** Result by the net P&L after fees (older records marked a fee-negative target hit as a win). */
const netStatus = (t) => (t.status === 'win' && t.pnl < 0 && !t.partial ? { ...t, status: 'loss' } : t);

const SIDE_FOR = { bullish: 'long', bearish: 'short' };
const ENTRY_ACTION = { long: 'BUY', short: 'SELL' };
const EXIT_ACTION = { long: 'SELL', short: 'BUY' };

const tfName = (s) => (s >= 3600 ? `${s / 3600}h` : `${s / 60}m`);
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
// prices for any symbol: 83,291 (BTC) / 3,512.40 (ETH) / 2.3457 (XRP)
/**
 * HTF (30m / 1h / 2h / 4h) FVG sitting inside the bracket, between entry and target: its near edge
 * (top of a zone below a short, bottom of a zone above a long), if at least minR away. Nearest one wins.
 */
export function htfTargetInBracket(zones, side, entry, target, risk, { minR = 0.5, tfs = ['30m', '1h', '2h', '4h'] } = {}) {
  if (!risk || !Number.isFinite(target)) return null;
  let best = null;
  for (const z of zones || []) {
    if (!tfs.includes(z.tf)) continue;
    const edge = side === 'short' ? z.top : z.bottom;
    const ahead = side === 'short' ? edge < entry && edge > target : edge > entry && edge < target;
    if (!ahead) continue;
    const r = Math.abs(edge - entry) / risk;
    if (r < minR) continue;
    if (!best || Math.abs(edge - entry) < Math.abs(best.price - entry)) best = { price: edge, r: Number(r.toFixed(2)), zone: z };
  }
  return best;
}

export const fmtPx = (v) => { const a = Math.abs(v); return Number(v).toLocaleString('en-US', { maximumFractionDigits: a >= 1000 ? 0 : a >= 10 ? 2 : 4, minimumFractionDigits: a >= 1000 ? 0 : a >= 10 ? 2 : 4 }); };
const px = fmtPx;

/**
 * Plain-language reason a trade was taken, e.g.
 * "SCALP short · tapped 15m bearish FVG 84,190-84,265 at 07:58 UTC -> 1m bearish IFVG 84,150-84,180 (inverted 2 candles ago)".
 */
export function describeSetup(setup, side) {
  if (!setup) return '';
  const parts = [`${setup.grade ? `${setup.grade} ` : ''}${(setup.category || 'swing').toUpperCase()} ${side || (setup.direction === 'bearish' ? 'short' : 'long')}`];
  if (setup.qualityReasons?.length) parts.push(setup.qualityReasons.join(' + ').replace(' + -> ', ' -> '));
  if (setup.htf) parts.push(`tapped unmitigated ${setup.htf.tf} ${setup.htf.type} FVG ${px(setup.htf.bottom)}-${px(setup.htf.top)}${setup.htf.tappedAt ? ` at ${hhmm(setup.htf.tappedAt)} UTC` : ''}`);
  if (setup.sweep && !setup.qualityReasons?.some((q) => q.startsWith('swept'))) parts.push(`swept ${setup.sweep.tf} ${setup.sweep.type} ${px(setup.sweep.price)}`);
  const age = setup.ageCandles === 0 ? 'on the last closed candle' : `${setup.ageCandles} candle${setup.ageCandles === 1 ? '' : 's'} ago`;
  parts.push(`${setup.htf ? '-> ' : ''}${setup.granularity ? tfName(setup.granularity) : ''} ${setup.direction} IFVG ${px(setup.bottom)}-${px(setup.top)} (formed in ${setup.formationCandles ?? '?'} candles, inverted ${age}${setup.displacement ? ', displacement candle' : ''})`);
  return parts.join(' · ').replace(' · -> ', ' -> ');
}

const sig = (v) => Number(Number(v).toPrecision(8));
const zoneSummary = (z) => z && {
  id: z.id, direction: z.direction, top: sig(z.top), bottom: sig(z.bottom),
  formedAt: z.formedAt, invertedAt: z.invertedAt, ageCandles: z.ageCandles, formationCandles: z.formationCandles, grade: z.grade, qualityReasons: z.qualityReasons, clearPath: z.clearPath, granularity: z.granularity, category: z.category, displacement: z.displacement,
  ...(z.htf && {
    htf: { tf: z.htf.tf, type: z.htf.type, top: sig(z.htf.top), bottom: sig(z.htf.bottom), tappedAt: z.htf.tappedAt },
  }),
  ...(z.sweep && { sweep: z.sweep }),
  ...(z.smt != null && { smt: z.smt }), ...(z.gapAtr != null && { gapAtr: z.gapAtr }), ...(z.bias && { bias: z.bias, withBias: z.withBias }),
};

export class TradingBot {
  /**
   * kv: async key/value store (see store.js). settings: interval / risk / daily-limit settings.
   * autoStart: whether the bot is enabled the first time (saved state wins afterwards).
   */
  /**
   * symbol: the market this bot trades (one bot per symbol). The primary bot (BTCUSDC) owns the shared settings
   * (stored under "bot"); the others keep their own state under "bot_<SYMBOL>" and read the shared settings.
   */
  constructor({ broker, market, ai, settings, kv, autoStart = true, fetchImpl = fetch, now = () => Date.now(), fallbackBroker = null, symbol = 'BTCUSDC', primary = true, pairMarket = null }) {
    this.pairMarket = pairMarket; // correlated market for SMT (BTC <-> ETH)
    this.symbol = symbol;
    this.primary = primary;
    this.broker = broker;
    // Trades opened on another broker (e.g. the simulator before switching to Binance) are closed there.
    this.fallbackBroker = fallbackBroker;
    this.market = market;
    this.ai = ai;
    this.kv = kv;
    this.fetch = fetchImpl;
    this.now = now;
    this.defaults = { maxTradesPerDay: 10, ...settings };
    this.state = { running: autoStart, lastRun: null, lastScan: null, lastError: null, settings: { ...this.defaults }, askedIfvgs: [] };
    this.busy = false;
  }

  get settings() { return this.state.settings; }

  /** Stop zone: the IFVG, widened to the recent swing high / low when stopMode = swing. */
  stopZone(setup) {
    if (this.state.settings.stopMode !== 'swing' || !Number.isFinite(setup?.swingStop)) return setup;
    return setup.direction === 'bearish' ? { ...setup, top: Math.max(setup.top, setup.swingStop) } : { ...setup, bottom: Math.min(setup.bottom, setup.swingStop) };
  }

  /** Reload persisted state (needed per request on serverless, where instances don't share memory). */
  async load() {
    const shared = await this.kv.get('bot', null);
    const saved = this.primary ? shared : await this.kv.get(`bot_${this.symbol}`, null);
    if (saved) this.state = { ...this.state, ...saved };
    this.state.settings = { ...this.defaults, ...(shared?.settings || {}) };
    if (!this.primary && shared) this.state.running = shared.running; // one Start / Stop for every symbol
    // Every entry model is always considered (swing 15m/5m/3m and scalp 1m); daily limits control how many.
    this.state.settings.entryTimeframes = 'all';
    this.state.settings.swingEnabled = this.state.settings.swingEnabled !== false;
    this.state.settings.scalpEnabled = this.state.settings.scalpEnabled !== false;
    // Total trades per day = swing limit + scalp limit.
    this.state.settings.maxTradesPerDay = (this.state.settings.maxSwingPerDay ?? 5) + (this.state.settings.maxScalpPerDay ?? 5);
    return this.state;
  }

  async save() {
    await this.kv.set(this.primary ? 'bot' : `bot_${this.symbol}`, this.state);
  }

  async status() {
    const trades = await this.allTrades();
    const s = this.state;
    return {
      running: s.running,
      busy: this.busy,
      lastRun: s.lastRun,
      lastScan: s.lastScan,
      scanStats: s.scanStats?.day === utcDay(this.now()) ? s.scanStats : null,
      nextRun: s.running && s.lastRun
        ? new Date(new Date(s.lastRun).getTime() + s.settings.intervalMinutes * 60000).toISOString()
        : null,
      lastError: s.lastError,
      settings: s.settings,
      tradesToday: tradesToday(trades, this.now()),
      swingToday: tradesToday(trades, this.now(), 'swing'),
      scalpToday: tradesToday(trades, this.now(), 'scalp'),
      openTrade: trades.find((t) => t.status === 'open') || null,
      openTrades: trades.filter((t) => t.status === 'open'),
      symbol: this.symbol,
      ai: this.ai.apiKey ? `${this.ai.provider}:${this.ai.model === 'auto' ? 'free models' : this.ai.model}` : 'rules (no AI key set)',
      broker: this.broker.name,
      storage: this.kv.name,
      liquidity: s.liquidity ?? null,
    };
  }

  /** A short string that changes whenever trades, decisions or orders change (dashboard live refresh). */
  async changeSignature() {
    const kv = this.kv;
    const mark = async (key) => (typeof kv.latest === 'function'
      ? kv.latest(key)
      : JSON.stringify((await kv.get(key, [])).slice(0, 1)).length + ':' + JSON.stringify((await kv.get(key, [])).slice(0, 1)).slice(0, 80));
    const [t, d, o] = await Promise.all([mark('trades'), mark('decisions'), mark('orders')]);
    return `${t}|${d}|${o}`;
  }

  async decisions(limit = 100) {
    return (await this.kv.get('decisions', [])).slice(0, limit);
  }

  /** This bot's symbol's trades (older trades without a symbol are BTCUSDC). */
  async trades(limit = MAX_TRADES_KEPT) {
    return (await this.allTrades()).filter((t) => (t.symbol || 'BTCUSDC') === this.symbol).slice(0, limit);
  }

  /** Trades of every symbol (daily limits and the open-trade cap are shared). */
  async allTrades(limit = MAX_TRADES_KEPT * 3) {
    return (await this.kv.get('trades', [])).slice(0, limit).map(netStatus);
  }

  shots(id) {
    return this.kv.get(`shot_${id}`, {});
  }

  /**
   * Snapshots for a trade, re-rendered from market candles (and saved) when one is missing,
   * e.g. after a storage reset. Only possible while the exchange still returns candles covering the trade.
   */
  async shotsFor(id) {
    const shots = await this.shots(id);
    const trade = (await this.allTrades()).find((t) => t.id === id);
    if (!trade) return shots;
    const needEntry = !shots.entry;
    const needExit = trade.status !== 'open' && !shots.exit;
    if (!needEntry && !needExit) return shots;
    const granularity = trade.granularity || this.state.settings.granularity;
    const candles = await this.market.getCandles(granularity, 300);
    const entryT = new Date(trade.entryTime).getTime();
    if (!candles.length || candles[0].time > entryT) return shots; // trade is older than the available history
    if (needEntry) {
      const atEntry = { ...trade, status: 'open', exitTime: undefined, exitPrice: undefined, pnl: undefined };
      shots.entry = renderTradeImage({ candles: candles.filter((c) => c.time <= entryT), trade: atEntry, phase: 'entry', granularity });
    }
    if (needExit) shots.exit = renderTradeImage({ candles, trade, phase: 'exit', granularity });
    await this.kv.set(`shot_${id}`, shots);
    return shots;
  }

  async updateSettings(patch) {
    const allowed = ['intervalMinutes', 'minConfidence', 'maxPositionPct', 'maxTradePct', 'granularity', 'maxTradesPerDay', 'ifvgMaxAge', 'maxSwingPerDay', 'maxScalpPerDay', 'maxOpenTrades', 'riskReward', 'breakevenAtR', 'maxLeverage', 'minStopPct', 'riskPerTradeUsd'];
    const s = this.state.settings;
    for (const k of allowed) {
      if (patch[k] !== undefined && patch[k] !== '' && !Number.isNaN(Number(patch[k]))) s[k] = Number(patch[k]);
    }
    if (patch.requireHtfTap !== undefined) s.requireHtfTap = patch.requireHtfTap === true || patch.requireHtfTap === 'true';
    if (['rr', 'liquidity'].includes(patch.targetMode)) s.targetMode = patch.targetMode;
    if (['percent', 'risk'].includes(patch.sizingMode)) s.sizingMode = patch.sizingMode;
    s.riskPerTradeUsd = Math.min(100000, Math.max(1, Number(s.riskPerTradeUsd ?? 50)));
    if (['zone', 'swing'].includes(patch.stopMode)) s.stopMode = patch.stopMode;
    if (['jev', 'displacement'].includes(patch.earlyExit)) s.earlyExit = patch.earlyExit;
    if (['off', 'info', 'require'].includes(patch.smt)) s.smt = patch.smt;
    for (const k of ['requireSweep', 'sessionFilter']) if (patch[k] !== undefined) s[k] = patch[k] === true || patch[k] === 'true';
    for (const k of ['minGapAtr', 'partialPct']) if (patch[k] !== undefined && patch[k] !== '' && !Number.isNaN(Number(patch[k]))) s[k] = Math.max(0, Number(patch[k]));
    s.partialPct = Math.min(90, s.partialPct || 0);
    if (patch.requireDisplacement !== undefined) s.requireDisplacement = patch.requireDisplacement === true || patch.requireDisplacement === 'true';
    // Swing / scalp on-off switches (a disabled type is not scanned at all)
    for (const k of ['swingEnabled', 'scalpEnabled']) if (patch[k] !== undefined) s[k] = patch[k] === true || patch[k] === 'true';
    s.entryTimeframes = 'all'; // all entry models, always
    s.ifvgMaxAge = Math.min(7, Math.max(3, Math.round(s.ifvgMaxAge ?? 7)));
    s.intervalMinutes = Math.max(1, s.intervalMinutes);
    s.minConfidence = Math.min(1, Math.max(0, s.minConfidence));
    s.maxPositionPct = Math.min(100, Math.max(0, s.maxPositionPct));
    s.maxTradePct = Math.min(100, Math.max(0, s.maxTradePct));
    s.maxTradesPerDay = Math.min(100, Math.max(0, Math.round(s.maxTradesPerDay)));
    s.maxSwingPerDay = Math.min(50, Math.max(0, Math.round(s.maxSwingPerDay ?? 5)));
    s.maxScalpPerDay = Math.min(50, Math.max(0, Math.round(s.maxScalpPerDay ?? 5)));
    s.maxTradesPerDay = s.maxSwingPerDay + s.maxScalpPerDay; // total per day = swing + scalp limits
    s.maxOpenTrades = Math.min(6, Math.max(1, Math.round(s.maxOpenTrades ?? 2))); // trades open at once, all symbols
    s.riskReward = Math.min(10, Math.max(0.5, Number(s.riskReward ?? 1)));
    // Breakeven trigger (in R) must sit before the target; 0 = off.
    s.breakevenAtR = Math.max(0, Number(s.breakevenAtR ?? 0));
    if (s.breakevenAtR >= s.riskReward) s.breakevenAtR = 0;
    s.maxLeverage = Math.min(125, Math.max(1, Math.round(s.maxLeverage ?? 5))); // Binance caps each symbol lower (BTC 125x, alts 50-75x)
    s.minStopPct = Math.min(2, Math.max(0.05, Number(s.minStopPct ?? 0.15))); // smallest stop distance, % of price
    await this.save();
    return s;
  }

  async setRunning(running) {
    this.state.running = running;
    await this.save();
    if (running) await this.runOnce().catch(() => {});
    return this.status();
  }

  /**
   * Called on a schedule (every minute locally, or by /api/cron on Vercel).
   * Always enforces open stops/targets; runs a full scan when the bot is on and the interval has passed.
   */
  /** Run fn while holding the cross-instance cycle lock; returns null if another cycle holds it. */
  async locked(fn) {
    const kv = this.kv;
    if (typeof kv.tryLock !== 'function') return fn(); // file / memory stores: single process
    if (!(await kv.tryLock('cycle', 90000))) return null;
    try { return await fn(); } finally { await kv.unlock('cycle').catch(() => {}); }
  }

  tick() {
    return this.locked(() => this.tickUnlocked());
  }

  async tickUnlocked() {
    await this.load();
    const due = !this.state.lastRun
      || this.now() - new Date(this.state.lastRun).getTime() >= this.state.settings.intervalMinutes * 60000 - 5000;
    if (this.state.running && due) return this.runOnceUnlocked();
    const open = (await this.trades()).find((t) => t.status === 'open');
    if (!open) return null;
    const candles = await this.market.getCandles(open.granularity || this.state.settings.granularity, 200);
    const closed = await this.manageOpen(candles, candles.at(-1).close);
    return closed && { closed };
  }

  /** Close the open trade if its stop or target was hit. Returns the closed trade or null. */
  async manageOpen(candles, price) {
    const open = (await this.trades()).find((t) => t.status === 'open');
    if (!open) return null;
    if (open.exchangeBracket && open.broker === this.broker.name && this.broker.supportsBrackets) {
      return this.manageExchangeBracket(open, candles, price);
    }
    const hit = checkBracket(open, candles, price, this.now());
    if (!hit) return null;
    if (hit.partialAt && !open.partial) await this.takePartial(open, hit.partialAt, candles);
    if (hit.breakevenAt && !open.breakeven) await this.moveToBreakeven(open, hit.breakevenAt);
    if (!hit.reason) return null;
    return this.closeTrade(open, hit.exitPrice, hit.reason, candles);
  }

  /**
   * Trade protected by real stop / target orders on the exchange: they fill at the levels by themselves.
   * Here we only move the stop to breakeven when due, and record the result once the position is gone.
   */
  async manageExchangeBracket(open, candles, price) {
    const amt = await this.broker.positionAmt();
    const stillOpen = open.side === 'short' ? amt < 0 : amt > 0;
    if (stillOpen) {
      const hit = checkBracket(open, candles, price, this.now());
      if (hit?.partialAt && !open.partial) await this.takePartial(open, hit.partialAt, candles);
      if (hit?.breakevenAt && !open.breakeven) {
        open.stopAlgoId = await this.broker.moveStop(open, open.entryPrice);
        await this.moveToBreakeven(open, hit.breakevenAt);
      }
      return null;
    }
    // The position is gone: find which exchange order closed it, and its real fill.
    const [sl, tp] = await Promise.all([this.broker.algoStatus(open.stopAlgoId), this.broker.algoStatus(open.targetAlgoId)]);
    const fired = tp?.actualOrderId ? { s: tp, reason: 'target' } : sl?.actualOrderId ? { s: sl, reason: open.breakeven ? 'breakeven' : 'stop' } : null;
    await Promise.all([this.broker.cancelAlgo(open.stopAlgoId), this.broker.cancelAlgo(open.targetAlgoId)]);
    let order = null;
    if (fired) {
      const f = await this.broker.fills(fired.s.actualOrderId);
      if (f) order = { id: fired.s.actualOrderId, price: f.price, qty: f.qty, fee: f.commission, realizedPnl: f.realizedPnl, actualFill: true };
    }
    return this.closeTrade(open, order?.price ?? price, fired ? fired.reason : 'manual', candles, { order });
  }

  /** First internal liquidity reached: close partialPct % of the position at market (the bracket keeps the rest). */
  async takePartial(trade, at) {
    const short = trade.side === 'short';
    const part = Math.min(0.9, Math.max(0.1, (trade.partialPct || 50) / 100));
    const level = trade.partialLevel;
    let qty = trade.qty * part;
    if (this.broker.roundQty) qty = await this.broker.roundQty(qty);
    if (!(qty > 0) || qty >= trade.qty) return;
    let order;
    try {
      order = short ? await this.broker.coverShort({ qty, price: level, source: 'ai', reason: 'partial' })
        : await this.broker.placeOrder({ side: 'sell', qty, price: level, source: 'ai', reason: 'partial' });
    } catch (e) { await this.log({ time: new Date(this.now()).toISOString(), action: 'HOLD', source: 'bracket', executed: false, tradeId: trade.id, note: `Partial at ${level} failed: ${e.message}` }); return; }
    const fill = Number(order?.price) || level;
    const q = Number(order?.qty) || qty;
    const f = q / trade.qty;
    const pnl = order?.actualFill
      ? order.realizedPnl - (trade.entryFee || 0) * f - (order.fee || 0)
      : (short ? trade.entryPrice - fill : fill - trade.entryPrice) * q - (trade.entryFee || 0) * f - (order?.fee || 0);
    const risk = Math.abs(trade.entryPrice - (trade.initialStop ?? trade.stop));
    trade.partial = { time: new Date(at).toISOString(), price: fill, qty: q, fraction: Number(f.toFixed(4)), pnl: Number(pnl.toFixed(2)), r: Number((((short ? -1 : 1) * (fill - trade.entryPrice)) / risk).toFixed(2)) };
    trade.qty -= q;
    trade.notional = Number((trade.notional * (1 - f)).toFixed(2));
    trade.entryFee = (trade.entryFee || 0) * (1 - f);
    const trades = await this.trades();
    const i = trades.findIndex((t) => t.id === trade.id);
    if (i >= 0) { trades[i] = trade; await this.kv.set('trades', trades); }
    await this.log({
      time: new Date(this.now()).toISOString(), price: fill, action: short ? 'BUY' : 'SELL', label: short ? 'PARTIAL SHORT' : 'PARTIAL LONG', source: 'bracket', executed: true, tradeId: trade.id,
      note: `Took ${Math.round(f * 100)}% off at first internal liquidity ${fill} (+${trade.partial.r}R, $${trade.partial.pnl}) · stop to breakeven`,
    });
  }

  /** The trade reached its breakeven level: from here on its stop sits at the entry. */
  async moveToBreakeven(trade, at) {
    Object.assign(trade, { breakeven: true, breakevenAt: new Date(at).toISOString(), stop: trade.entryPrice });
    const trades = await this.trades();
    const i = trades.findIndex((t) => t.id === trade.id);
    if (i >= 0) { trades[i] = trade; await this.kv.set('trades', trades); }
    await this.log({
      time: new Date(this.now()).toISOString(), price: trade.entryPrice, action: 'HOLD', source: 'bracket', executed: false,
      tradeId: trade.id,
      note: `Stop moved to breakeven (${trade.entryPrice}) at +${trade.breakevenAtR}R · target 1:${trade.rr ?? 1} still running`,
    });
  }

  async closeTrade(trade, exitPrice, reason, candles, external = null) {
    const nowIso = new Date(this.now()).toISOString();
    const short = trade.side === 'short';
    const broker = (trade.broker ?? 'local') !== this.broker.name && this.fallbackBroker?.name === (trade.broker ?? 'local')
      ? this.fallbackBroker : this.broker;
    let order = external?.order ?? null;
    let note = '';
    let qty = order?.qty ?? trade.qty;
    if (!external) {
      // closing ourselves (review / signal): remove the exchange stop and target first
      if (trade.exchangeBracket && broker.cancelAlgo) await Promise.all([broker.cancelAlgo(trade.stopAlgoId), broker.cancelAlgo(trade.targetAlgoId)]);
      const account = await broker.getAccount(exitPrice);
      qty = Math.min(trade.qty, short ? account.shortBtc || 0 : account.btc);
    }
    if (external) {
      if (!order) note = 'Closed outside the bot (no matching exchange order)';
    } else if (qty * exitPrice >= 1) {
      order = short
        ? await broker.coverShort({ qty, price: exitPrice, source: 'ai', reason })
        : await broker.placeOrder({ side: 'sell', qty, price: exitPrice, source: 'ai', reason });
    } else {
      note = 'Position was already closed manually';
    }
    // Use the broker's actual fill price when it reports one (Binance), else the stop / target level.
    if (Number(order?.price) > 0) exitPrice = Number(order.price);
    const part = qty / trade.qty;
    const fee = order?.fee ?? 0;
    let pnl = 0;
    if (order) {
      pnl = short
        ? trade.notional * part - (trade.entryFee || 0) * part - exitPrice * qty - fee // proceeds - entry fee - buyback
        : exitPrice * qty - fee - trade.notional * part; // long notional already includes the entry fee
      if ((trade.broker ?? 'local') !== 'local') {
        // real broker: price move x filled qty, minus entry and exit fees; exact from Binance's fills when available
        pnl = order.actualFill
          ? order.realizedPnl - (trade.entryFee || 0) * part - fee
          : (short ? trade.entryPrice - exitPrice : exitPrice - trade.entryPrice) * qty - (trade.entryFee || 0) * part - fee;
      }
    } else {
      // No closing order went through (position already gone): still record the paper result from the prices.
      pnl = (short ? trade.entryPrice - exitPrice : exitPrice - trade.entryPrice) * trade.qty;
    }
    const dir = short ? -1 : 1;
    const pt = trade.partial;
    if (pt) pnl += pt.pnl; // the part already taken off at internal liquidity
    if (trade.trimPnl) pnl += trade.trimPnl; // size trimmed after entry slippage
    const fees = (trade.entryFee || 0) * (qty / trade.qty) + fee;
    Object.assign(trade, {
      // by the net result after fees, like the account balance: a target hit that fees turned negative is a loss
      // (a stop moved to the entry stays breakeven: only fees lost)
      status: reason === 'breakeven' ? (pt && pnl > 0 ? 'win' : 'breakeven') : Math.abs(pnl) < 0.005 ? 'breakeven' : pnl > 0 ? 'win' : 'loss',
      fees: Number(fees.toFixed(2)),
      grossPnl: Number((pnl + fees).toFixed(2)),
      exitTime: nowIso,
      exitPrice,
      exitReason: reason,
      ...(order?.id && { exitOrderId: String(order.id) }),
      pnl: Number(pnl.toFixed(2)),
      r: Number((((dir * (exitPrice - trade.entryPrice)) / Math.abs(trade.entryPrice - (trade.initialStop ?? trade.stop))) * (pt ? 1 - pt.fraction : 1) + (pt ? pt.r * pt.fraction : 0)).toFixed(2)),
      ...(note && { note }),
    });
    const trades = await this.trades();
    const i = trades.findIndex((t) => t.id === trade.id);
    if (i >= 0) trades[i] = trade;
    await this.kv.set('trades', trades);
    const shots = await this.shots(trade.id);
    shots.exit = renderTradeImage({ candles, trade, phase: 'exit', granularity: trade.granularity || this.state.settings.granularity });
    await this.kv.set(`shot_${trade.id}`, shots);
    await this.log({
      time: nowIso, price: exitPrice, action: EXIT_ACTION[trade.side || 'long'], label: `CLOSE ${(trade.side || 'long').toUpperCase()}`,
      source: 'bracket', executed: Boolean(order), tradeId: trade.id,
      note: `${reason === 'target' ? `Target hit (+${trade.rr ?? 1}R)` : reason === 'stop' ? 'Stop hit (-1R)' : reason === 'breakeven' ? 'Stopped at breakeven (0R)' : reason === 'review' ? 'Closed by Jev risk review' : 'Closed on signal'} · P&L ${trade.pnl >= 0 ? '+' : '-'}$${Math.abs(trade.pnl).toFixed(2)}`,
    });
    return trade;
  }

  async openTrade({ side, setup, decision, account, price, candles, liquidity, zones = [] }) {
    const label = side === 'short' ? 'SHORT' : 'BUY';
    // size on the live price, not the last candle close (a stale price under-sizes the stop distance)
    const live = Number(await this.market.getPrice?.().catch(() => null));
    if (live > 0) price = live;
    if (!bracketFor(side, price, setup)) return { note: `${label} skipped: price is on the wrong side of the IFVG, no valid stop` };
    const st = this.state.settings;
    let margin, leverage, size, sizing = '';
    if ((st.sizingMode ?? 'percent') === 'risk') {
      // Risk-based: lose about riskPerTradeUsd if the stop is hit.
      const b0 = bracketFor(side, price, this.stopZone(setup), { rr: st.riskReward ?? 1, minRiskPct: st.minStopPct ?? 0.15 });
      if (!(b0?.risk > 0)) return { note: `${label} skipped: stop distance is zero` };
      const rs = riskSize({
        riskUsd: st.riskPerTradeUsd ?? 50, stopDist: b0.risk, price, cash: account.cash,
        levPick: decision.leverage, maxLev: st.maxLeverage ?? 5, canLever: Boolean(this.broker.supportsLeverage),
      });
      if (rs.notional < MIN_ORDER_USD) return { note: `${label} skipped: not enough cash for the risk size` };
      ({ margin, leverage } = rs);
      size = rs.notional;
      sizing = ` · risk-sized $${rs.riskUsd}${rs.capped ? ` (trimmed from $${st.riskPerTradeUsd ?? 50}: not enough margin at ${leverage}x)` : ''}`;
    } else {
      margin = entryNotional(decision.sizePct, account, st);
      if (!margin) return { note: `${label} skipped: position limit reached or not enough cash` };
      // Leverage: Jev's pick, capped by the Max leverage setting; brokers without leverage (simulator) use 1x.
      leverage = this.broker.supportsLeverage ? Math.max(1, Math.min(Math.round(decision.leverage || 1), st.maxLeverage ?? 5)) : 1;
      size = Number((margin * leverage).toFixed(2));
    }
    const order = side === 'short'
      ? await this.broker.openShort({ notional: size, price, source: 'ai', leverage })
      : await this.broker.placeOrder({ side: 'buy', notional: size, price, source: 'ai', leverage });
    if (Number(order.leverage) > 0) leverage = Number(order.leverage); // what the exchange actually allowed for this symbol
    const entryPrice = Number(order.price) || price;
    // Position value = what actually filled (qty x price); the requested size can differ after quantity rounding.
    let qty = Number(order.qty) || ((Number(order.notional) || size) * 0.999) / entryPrice;
    let notional = this.broker.name === 'local' ? Number(order.notional ?? size) : Number((qty * entryPrice).toFixed(2));
    let entryFee = order.fee || 0;
    let trimPnl = 0;
    const rr = this.state.settings.riskReward ?? 1;
    const minRiskPct = this.state.settings.minStopPct ?? 0.15;
    const sz = this.stopZone(setup);
    const b = bracketFor(side, entryPrice, sz, { rr, minRiskPct }) || bracketFor(side, price, sz, { rr, minRiskPct });
    if (!(b?.risk > 0)) throw new Error(`${this.symbol}: bracket has no stop distance (entry ${entryPrice}), position opened without SL/TP`);
    // Slippage guard (risk sizing): the fill moved away from the stop, so the $ risk grew. Trim the extra size right away.
    let trimmed = '';
    if ((st.sizingMode ?? 'percent') === 'risk') {
      const want = st.riskPerTradeUsd ?? 50;
      const dist = Math.abs(entryPrice - b.stop);
      const keep = want / dist;
      if (qty * dist > want * 1.2 && keep < qty) {
        let extra = qty - keep;
        if (this.broker.roundQty) extra = await this.broker.roundQty(extra);
        if (extra > 0 && extra < qty) {
          try {
            const o2 = side === 'short'
              ? await this.broker.coverShort({ qty: extra, price: entryPrice, source: 'ai', reason: 'risk trim' })
              : await this.broker.placeOrder({ side: 'sell', qty: extra, price: entryPrice, source: 'ai', reason: 'risk trim' });
            const q2 = Number(o2?.qty) || extra;
            const f = q2 / qty;
            trimPnl = Number((o2?.actualFill ? o2.realizedPnl - entryFee * f - (o2.fee || 0) : -(entryFee * f) - (o2?.fee || 0)).toFixed(2));
            trimmed = ` · trimmed ${Number(q2.toPrecision(6))} after slippage (risk was $${(qty * dist).toFixed(2)})`;
            qty -= q2;
            notional = Number((notional * (1 - f)).toFixed(2));
            entryFee *= 1 - f;
          } catch (e) { trimmed = ` · trim failed: ${e.message}`; }
        }
      }
    }
    // Target at liquidity: the nearest level (LRLR / equal highs-lows / PDH-PDL ...) 0.75R-5R away (else the fixed R:R target).
    let targetLevel = null;
    if ((this.state.settings.targetMode ?? 'rr') === 'liquidity') {
      // Jev's pick when it chose one (still on the right side of the fill, >= 0.5R), else the nearest valid level
      const p = decision?.targetPick;
      const pr = p && (side === 'short' ? entryPrice - p.price : p.price - entryPrice) / b.risk;
      const lt = pr >= 0.5 ? { ...p, r: Number(pr.toFixed(2)), byJev: true } : liquidityTarget(liquidity, side, entryPrice, b.risk);
      if (lt) { b.target = lt.price; b.rr = lt.r; targetLevel = `${lt.level.label || lt.level.type} ${fmtPx(lt.price)}${lt.byJev ? ' (Jev pick)' : ''}`; }
    }
    // A 30m-4h FVG inside the bracket (between entry and target) is where price reacts first: target its near edge.
    const hz = htfTargetInBracket(zones, side, entryPrice, b.target, b.risk);
    if (hz) { b.target = hz.price; b.rr = hz.r; targetLevel = `${hz.zone.tf} ${hz.zone.type} FVG ${fmtPx(hz.price)} (HTF in bracket)`; }
    const plan = { note: `${label} $${notional.toFixed(2)}${leverage > 1 ? ` (${leverage}x, margin $${margin.toFixed(2)})` : ''}${sizing}${trimmed}` };
    const trade = {
      id: `T${this.now()}-${this.symbol}`,
      symbol: this.symbol,
      status: 'open',
      side,
      entryTime: new Date(this.now()).toISOString(),
      entryPrice,
      qty,
      notional,
      entryFee,
      ...(trimPnl ? { trimPnl } : {}),
      granularity: setup.granularity || this.state.settings.granularity,
      category: setup.category || 'swing',
      broker: this.broker.name,
      leverage,
      margin,
      stop: b.stop,
      initialStop: b.stop,
      rr: b.rr,
      ...(targetLevel && { targetLevel }),
      breakevenAtR: this.state.settings.breakevenAtR || 0,
      ...partialFor(this.state.settings, liquidity, side, entryPrice, b),
      target: b.target,
      risk: b.risk,
      riskUsd: Number((Math.abs(entryPrice - b.stop) * qty).toFixed(2)), // $ lost if the stop is hit (before fees)
      ifvg: zoneSummary(setup),
      confidence: decision.confidence,
      source: decision.source,
      reasoning: decision.reasoning,
      setupReason: `${describeSetup(setup, side)}${targetLevel ? ` · target liquidity ${targetLevel}` : ''}${liquidity?.draw ? ` · draw on liquidity ${liquidity.draw}${liquidity.lrlr ? ' (LRLR)' : ''}` : ''} · Jev ${decision.action} ${Math.round((decision.confidence || 0) * 100)}%${leverage > 1 ? ` · ${leverage}x` : ''}`,
      orderId: order.id,
    };
    let trades = await this.trades();
    trades.unshift(trade);
    const dropped = trades.slice(MAX_TRADES_KEPT);
    trades = trades.slice(0, MAX_TRADES_KEPT);
    await this.kv.set('trades', trades);
    await Promise.all(dropped.map((t) => this.kv.del(`shot_${t.id}`)));
    await this.kv.set(`shot_${trade.id}`, {
      entry: renderTradeImage({ candles, trade, phase: 'entry', granularity: trade.granularity }),
    });
    // Real stop-loss and take-profit orders on the exchange (fill at the levels without waiting for the bot).
    if (this.broker.supportsBrackets) {
      try {
        Object.assign(trade, await this.broker.placeBracket({ side, stop: trade.stop, target: trade.target }), { exchangeBracket: true });
        const list = await this.trades();
        const k = list.findIndex((x) => x.id === trade.id);
        if (k >= 0) { list[k] = trade; await this.kv.set('trades', list); }
      } catch (e) {
        trade.bracketError = e.message; // falls back to the bot watching stop / target every minute
      }
    }
    const be = trade.breakevenAtR ? ` · breakeven at +${trade.breakevenAtR}R` : '';
    return { trade, order, note: `${trade.setupReason} | ${plan.note} · risking $${trade.riskUsd} · SL ${b.stop} · TP ${b.target} (1:${b.rr})${be}` };
  }

  async log(entry) {
    entry.symbol ??= this.symbol;
    entry.id ??= `D${this.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await appendList(this.kv, 'decisions', entry, MAX_DECISIONS_KEPT);
  }

  /** Record that Jev reviewed the open trade now (the next review is one review period later). */
  async markReviewed(trade) {
    trade.lastReviewAt = new Date(this.now()).toISOString();
    trade.reviews = (trade.reviews || 0) + 1;
    const trades = await this.trades();
    const i = trades.findIndex((t) => t.id === trade.id);
    if (i >= 0) { trades[i] = trade; await this.kv.set('trades', trades); }
  }

  rememberAsked(id) {
    this.state.askedIfvgs = [id, ...(this.state.askedIfvgs || []).filter((x) => x !== id)].slice(0, 50);
  }

  /**
   * One full cycle: enforce brackets, look for a fresh IFVG, ask the AI about it and execute what it decides.
   * manual: true when the user clicked "Ask AI now" (always asks the AI and always logs).
   */
  async runOnce(opts = {}) {
    const r = await this.locked(async () => { await this.load(); return this.runOnceUnlocked(opts); });
    if (r === null) throw new Error('Another bot cycle is running right now, try again in a few seconds');
    return r;
  }

  /** What Jev thinks about this symbol right now: BUY / SELL / HOLD odds and model confidence. Read-only. */
  async jevView() {
    const s = this.state.settings;
    const scan = await scanSetups(this.market, s, this.now(), { pairMarket: this.pairMarket });
    const indicators = summarize(scan.candles);
    const open = (await this.trades()).find((t) => t.status === 'open');
    const st = scan.setup;
    const base = {
      symbol: this.symbol, price: indicators.price, open: open ? open.side || 'long' : null, note: scan.note || null,
      setup: st ? `${st.category} ${st.granularity / 60}m ${st.direction} IFVG${st.grade ? ` (${st.grade})` : ''}` : null,
    };
    if (!this.ai.apiKey || this.ai.provider !== 'jev') return { ...base, error: 'Jev key not set' };
    const account = await this.broker.getAccount(indicators.price).catch(() => ({ cash: 0, equity: 0 }));
    const d = await askJev({
      indicators, account, recentCandles: scan.candles.slice(-24), granularity: scan.granularity, ifvg: zoneSummary(st),
      riskReward: s.riskReward ?? 1, maxLeverage: this.broker.supportsLeverage ? s.maxLeverage ?? 5 : 1, breakevenAtR: s.breakevenAtR ?? 0,
      liquidity: scan.liquidity, targetMode: s.targetMode ?? 'rr', maxTradesPerDay: s.maxTradesPerDay,
      openTrade: open && { side: open.side || 'long', entryPrice: open.entryPrice, stop: open.stop, target: open.target },
    }, this.ai, this.fetch);
    // what the bot does with this answer (entries need Jev's BUY / SELL to match the IFVG setup)
    const all = await this.allTrades();
    const openAll = all.filter((t) => t.status === 'open').length;
    const cap = s.maxOpenTrades ?? 2;
    const want = st ? SIDE_FOR[st.direction] : null;
    let botAction;
    if (open) botAction = d.action === EXIT_ACTION[open.side || 'long']
      ? (d.confidence >= s.minConfidence ? `Jev is against the open ${open.side}: closes on the next review / opposite IFVG` : `Jev leans against the open ${open.side} (below ${s.minConfidence})`)
      : `managing the open ${open.side}`;
    else if (!st) botAction = d.action === 'HOLD' ? 'waiting for a setup' : `no IFVG setup: Jev ${d.action} alone does not open a trade`;
    else if (d.action !== ENTRY_ACTION[want]) botAction = `Jev ${d.action} does not match the ${st.direction} setup: no entry`;
    else if (d.confidence < s.minConfidence) botAction = `confidence below ${s.minConfidence}: no entry`;
    else if (openAll >= cap) botAction = `${want.toUpperCase()} aligned, waiting for a free slot (${openAll}/${cap} open)`;
    else botAction = `${want.toUpperCase()} aligned: the bot enters on its next scan`;
    return { ...base, action: d.action, confidence: d.confidence, odds: d.odds, modelConfidence: d.modelConfidence, sizePct: d.sizePct, leverage: d.leverage, botAction };
  }

  async runOnceUnlocked({ manual = false } = {}) {
    if (this.busy) throw new Error('Bot is already running a cycle');
    this.busy = true;
    const entry = { time: new Date(this.now()).toISOString() };
    let persist = manual;
    let scanClass = 'error';
    try {
      const s = this.state.settings;
      // 1. Enforce the open trade's stop / target on its own timeframe.
      let open = (await this.trades()).find((t) => t.status === 'open');
      if (open) {
        const oc = await this.market.getCandles(open.granularity || s.granularity, 200);
        if (await this.manageOpen(oc, oc.at(-1).close)) persist = true;
      }

      // 2. Multi-timeframe scan. A category whose daily limit is used up is not scanned.
      const before = await this.allTrades(); // daily limits count every symbol
      const swingLeft = tradesToday(before, this.now(), 'swing') < (s.maxSwingPerDay ?? 5);
      const scalpLeft = tradesToday(before, this.now(), 'scalp') < (s.maxScalpPerDay ?? 5);
      const scan = await scanSetups(this.market, {
        ...s, swingEnabled: s.swingEnabled !== false && swingLeft, scalpEnabled: s.scalpEnabled !== false && scalpLeft,
      }, this.now(), { pairMarket: this.pairMarket });
      let { setup } = scan;
      const { candles } = scan;
      const indicators = summarize(candles);
      // Liquidity: PDH/PDL, today's high/low, PWH/PWL, equal highs/lows, HTF swings, LRLR.
      const liquidity = scan.liquidity !== undefined ? scan.liquidity : await liquidityLevels(this.market, this.now()).catch(() => null);
      this.state.liquidity = liquidity && { above: liquidity.above.slice(0, 4), below: liquidity.below.slice(0, 4), lrlr: liquidity.lrlr, draw: liquidity.draw };
      const price = indicators.price;
      entry.price = price;
      // Clear path: no opposing 3m/5m/15m FVG between entry and the (fixed R:R) target.
      if (setup) {
        const sd = SIDE_FOR[setup.direction];
        const b0 = bracketFor(sd, price, this.stopZone(setup), { rr: s.riskReward ?? 1, minRiskPct: s.minStopPct ?? 0.15 });
        if (b0) {
          const blockers = pathBlockers(scan.zones || [], sd, price, b0.target);
          setup.htfInPath = false;
          setup.clearPath = blockers.length === 0;
          const why = setup.clearPath ? 'clear path to TP'
            : `path blocked by ${blockers.slice(0, 2).map((z) => `${z.tf} ${z.type} FVG ${fmtPx(z.bottom)}-${fmtPx(z.top)}`).join(', ')}`;
          setup.qualityReasons = [...(setup.qualityReasons || []), why];
          // A+ needs a clear path; without it an untapped "A+" is not tradeable.
          if (setup.grade === 'A+' && !setup.clearPath) setup.grade = 'A';
          // Hard rule: no trade with an opposing 30m / 1h / 2h / 4h FVG between entry and the target it would use.
          const tgt = (s.targetMode ?? 'rr') === 'liquidity' ? (liquidityTarget(liquidity, sd, price, b0.risk)?.price ?? b0.target) : b0.target;
          const htfBlock = pathBlockers(scan.zones || [], sd, price, tgt, ['30m', '1h', '2h', '4h']);
          if (htfBlock.length) {
            const z = htfBlock[0];
            scan.note = `${setup.category} ${setup.granularity / 60}m ${setup.direction} IFVG skipped: ${z.tf} ${z.type} FVG ${fmtPx(z.bottom)}-${fmtPx(z.top)} sits between entry and TP ${fmtPx(tgt)}`;
            scan.setup = null;
            setup = null;
          }
        }
      }
      if (setup && !setup.htf && !setup.sweep && setup.grade !== 'A+' && s.requireHtfTap !== false) {
        scan.note = `${setup.category} ${setup.granularity / 60}m: ${setup.qualityReasons.at(-1)}, not A+ and no FVG tap`;
        scan.setup = null;
        setup = null;
      }
      entry.setup = zoneSummary(scan.setup);
      const trades = await this.trades();
      open = trades.find((t) => t.status === 'open');
      const everything = await this.allTrades();
      const count = tradesToday(everything, this.now());
      const openAll = everything.filter((t) => t.status === 'open').length;
      const asked = setup && ((this.state.askedIfvgs || []).includes(setup.id) || trades.some((t) => t.ifvg?.id === setup.id));

      const want = setup ? SIDE_FOR[setup.direction] : null; // trade direction the setup offers
      const canShort = typeof this.broker.openShort === 'function';
      // An opposite IFVG while a trade is open is a chance to close it early.
      // earlyExit = displacement: only an opposite IFVG with a displacement candle may close a trade early, no timed reviews
      const strictExit = s.earlyExit === 'displacement';
      const opposite = Boolean(open && want && want !== (open.side || 'long') && !asked && (!strictExit || setup.displacement));
      // Periodic risk review of the open trade: every 20 min (5m entries) / 60 min (15m entries).
      const review = Boolean(open && !opposite && !strictExit && reviewDue(open, this.now()));

      let reason = null; // why the AI is not consulted / an entry can't be taken
      if (open && !opposite && !review) reason = `Managing open trade (bracket active, next review ${nextReviewLabel(open)})`;
      else if (!open && count >= s.maxTradesPerDay) reason = `Daily limit reached (${count}/${s.maxTradesPerDay})`;
      else if (!open && !swingLeft && !scalpLeft) reason = `Daily swing (${s.maxSwingPerDay ?? 5}) and scalp (${s.maxScalpPerDay ?? 5}) limits reached`;
      else if (!open && !setup) reason = `${!swingLeft ? 'Swing limit reached · ' : ''}${!scalpLeft ? 'Scalp limit reached · ' : ''}${scan.note ? `No setup · ${scan.note}` : 'No fresh IFVG setup'}`;
      else if (!open && s.sessionFilter && !inSession(this.now())) reason = `${setup.category} ${setup.granularity / 60}m ${setup.direction} IFVG outside the London / New York session`;
      // open-trade cap: keep scanning, only the entry waits for a free slot
      else if (!open && openAll >= (s.maxOpenTrades ?? 2)) reason = `${setup.category} ${setup.granularity / 60}m ${setup.direction} IFVG found · waiting for a free slot (max ${s.maxOpenTrades ?? 2} trades at a time)`;
      else if (!open && want === 'short' && !canShort) reason = 'Bearish IFVG: this broker cannot short BTC (use BROKER=local)';
      else if (!open && asked) reason = 'Already evaluated this IFVG';

      scanClass = scanOutcome(reason);
      this.state.lastScan = { time: entry.time, setup: entry.setup, note: reason || (review ? 'Jev reviewing open trade' : 'Asked AI') };

      if (reason && !manual) {
        Object.assign(entry, { action: 'HOLD', note: reason, executed: false, source: 'ifvg' });
      } else {
        const account = await this.broker.getAccount(price);
        // Liquidity targets Jev can choose from (target mode = liquidity, new entries only)
        let targets = [];
        if (setup && !open && (s.targetMode ?? 'rr') === 'liquidity') {
          const tb = bracketFor(want, price, this.stopZone(setup), { rr: s.riskReward ?? 1, minRiskPct: s.minStopPct ?? 0.15 });
          if (tb) targets = liquidityTargets(liquidity, want, price, tb.risk);
        }
        const decision = await decide(
          {
            indicators,
            account,
            recentCandles: candles.slice(-24),
            granularity: scan.granularity,
            review: review && open && {
              side: open.side || 'long',
              minutesOpen: Math.round((this.now() - new Date(open.entryTime).getTime()) / 60000),
              unrealizedR: Number(((open.side === 'short' ? open.entryPrice - price : price - open.entryPrice) / Math.abs(open.entryPrice - open.stop)).toFixed(2)),
            },
            recentDecisions: await this.decisions(5),
            ifvg: entry.setup,
            tradesToday: count,
            riskReward: s.riskReward ?? 1,
            maxLeverage: this.broker.supportsLeverage ? s.maxLeverage ?? 5 : 1,
            breakevenAtR: s.breakevenAtR ?? 0,
            liquidity,
            targetMode: s.targetMode ?? 'rr',
            targets,
            maxTradesPerDay: s.maxTradesPerDay,
            openTrade: open && { side: open.side || 'long', entryPrice: open.entryPrice, stop: open.stop, target: open.target },
          },
          this.ai,
          this.fetch,
        );
        persist = true;
        if (setup) this.rememberAsked(setup.id);
        const pick = /^T(\d+)$/.exec(decision.targetChoice || '');
        if (pick && targets[Number(pick[1]) - 1]) decision.targetPick = targets[Number(pick[1]) - 1];
        Object.assign(entry, {
          action: decision.action,
          confidence: decision.confidence,
          sizePct: decision.sizePct,
          reasoning: decision.reasoning,
          source: decision.source,
          aiError: decision.error,
          aiCost: decision.cost,
          executed: false,
        });
        this.state.lastError = decision.error || null;
        const confident = decision.confidence >= s.minConfidence;

        if (review && !opposite) {
          await this.markReviewed(open);
          if (confident && decision.action === EXIT_ACTION[open.side || 'long']) {
            const t = await this.closeTrade(open, price, 'review', candles);
            entry.executed = true;
            entry.tradeId = t.id;
            entry.label = `CLOSE ${(open.side || 'long').toUpperCase()}`;
            entry.note = `Jev review: closed ${open.side || 'long'} early · P&L ${t.pnl >= 0 ? '+' : '-'}$${Math.abs(t.pnl).toFixed(2)}`;
          } else {
            entry.tradeId = open.id;
            entry.label = 'HOLD';
            entry.note = `Jev review: keep ${open.side || 'long'} open (${decision.action}${confident ? '' : ', low confidence'})`;
          }
        } else if (opposite && !reason && confident && decision.action === EXIT_ACTION[open.side || 'long']) {
          const t = await this.closeTrade(open, price, 'signal', candles);
          entry.executed = true;
          entry.tradeId = t.id;
          entry.label = `CLOSE ${(open.side || 'long').toUpperCase()}`;
          entry.note = `Closed ${open.side || 'long'} on ${setup.direction} IFVG · P&L ${t.pnl >= 0 ? '+' : '-'}$${Math.abs(t.pnl).toFixed(2)}`;
        } else if (!open && want && decision.action === ENTRY_ACTION[want]) {
          if (reason) entry.note = `${decision.action} not taken: ${reason}`;
          else if (!confident) entry.note = `Confidence ${decision.confidence} below minimum ${s.minConfidence}`;
          else {
            const res = await this.openTrade({ side: want, setup, decision, account, price, candles, liquidity, zones: scan.zones || [] });
            entry.note = res.note;
            if (res.trade) { entry.executed = true; entry.tradeId = res.trade.id; entry.order = res.order; entry.label = want === 'short' ? 'SHORT' : 'LONG'; }
          }
        } else if (decision.action === 'HOLD') {
          entry.note = reason ? `HOLD · ${reason}` : 'HOLD';
        } else {
          entry.note = reason
            ? `${decision.action} not taken: ${reason}`
            : open && decision.action === EXIT_ACTION[open.side || 'long']
            ? `Jev ${decision.action} ${decision.confidence} against the open ${open.side || 'long'}, below the ${s.minConfidence} minimum to close it`
            : setup ? `Jev ${decision.action} does not match the ${setup.direction} IFVG setup` : `Jev ${decision.action}, but there is no IFVG setup to enter`;
        }
      }
    } catch (err) {
      Object.assign(entry, { action: 'ERROR', note: err.message, executed: false });
      this.state.lastError = err.message;
      persist = true;
    } finally {
      this.busy = false;
      this.state.lastRun = entry.time;
      // daily scan counter (UTC): how many scans ran and where each one stopped
      const day = utcDay(this.now());
      const st = this.state.scanStats?.day === day ? this.state.scanStats : { day };
      const outcome = entry.executed ? 'taken' : scanClass;
      st.scans = (st.scans || 0) + 1;
      st[outcome] = (st[outcome] || 0) + 1;
      if (outcome === 'taken' || (scanClass === 'asked' && entry.confidence !== undefined)) st.askedJev = (st.askedJev || 0) + 1;
      this.state.scanStats = st;
      try {
        if (persist) await this.log(entry);
        await this.save();
      } catch (err) {
        this.state.lastError = `Storage: ${err.message}`;
      }
    }
    return entry;
  }
}
