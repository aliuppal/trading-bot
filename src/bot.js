import { decide, askJev, researchSuggestions, askJevShadow, SHADOW_PROMPT_VERSION } from './ai.js';
import { summarize } from './indicators.js';
import { bracketFor, closedCandles } from './ifvg.js';
import { scanModel, MODELS, MODEL_RULES } from './models.js';
import { inSession, scanSetups, pathBlockers, wickBlockers } from './strategy.js';
import { gradeV2, killzoneOf, applyV2Rules, corrCapHit, dailyR, cooldownUntil, stopV2Level, invalidationCandle, limitEntryPrice } from './grade.js';
import { renderTradeImage } from './snapshot.js';
import { appendList } from './store.js';
import { liquidityLevels, liquidityTarget, liquidityTargets, describeLevels } from './liquidity.js';
import { trackRecord, approvedEffects, experienceSuggestions } from './learn.js';

/** Strategy v2 (section 3) on / off switches, all off by default: off = today's behaviour. */
export const V2_SWITCHES = ['poolSweeps', 'openBias', 'ceCheck', 'singularCheck', 'chopCheck', 'speedCheck', 'pdCheck', 'smtV2', 'gradeV2',
  'riskByGrade', 'corrCap', 'lossCooldown', 'killzoneTest', 'stopV2', 'limitEntry', 'invalidationExit'];
/** Settings only the pattern models use; the Jev model ignores them, so suggestions for it skip them. */
const PATTERN_ONLY = ['requireDisplacement', 'requireSweep', 'stopMode', 'earlyExit', 'smt', 'ifvgMaxAge', 'minGapAtr', 'requireHtfTap'];

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
  // breakeven switched on while the trade was open: only price action from then on counts
  const beSince = trade.breakevenSince ? Date.parse(trade.breakevenSince) : 0;
  const stopAt = (t) => (beAt !== null && t > beAt ? trade.entryPrice : initialStop);
  const stopHit = (lo, hi, stop) => (short ? hi >= stop : lo <= stop);
  const targetHit = (lo, hi) => (short ? lo <= trade.target : hi >= trade.target);
  const reached = (t, lo, hi) => beLevel !== null && t >= beSince && (short ? lo <= beLevel : hi >= beLevel);
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
    if (reached(t, lo, hi)) { beAt = t; beLevel = null; }
    // first internal liquidity: part of the position is taken off and the stop goes to the entry
    if (partialHit(lo, hi)) { partialAt = t; pLevel = null; if (beAt === null) beAt = t; beLevel = null; }
  }
  const m = moved();
  return Object.keys(m).length ? m : null;
}

/** Minutes between Jev reviews of an open trade: 3 for scalps, 2 for 5m swings, 30 for 15m swings. */
export function reviewMinutes(trade) {
  const g = trade.granularity || 900;
  if (trade.category !== 'scalp' && g === 300) return 2; // 5m swings (all models)
  if (trade.reviewEvery) return trade.reviewEvery; // Jev model: 3 min scalps
  if (trade.category === 'scalp' || g <= 60) return 3; // scalps (1m / 2m / 3m)
  return g < 300 ? 3 : 30;
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

/** Models that use the IFVG scan and filters. */
const isIfvg = (model) => model === 'ifvg' || model === 'ifvg_nojev';

/**
 * IFVG (no Jev): the rules decide. A qualifying setup is taken (BUY on bullish, SELL on bearish) and an opposite
 * IFVG closes the open trade. Leverage 1 = the lowest leverage that fits the risk size.
 */
export function rulesDecision({ want, open, opposite, s = {} }) {
  const action = open ? (opposite ? EXIT_ACTION[open.side || 'long'] : 'HOLD') : want ? ENTRY_ACTION[want] : 'HOLD';
  return { action, confidence: 1, sizePct: action === 'HOLD' ? 0 : s.maxTradePct ?? 10, leverage: 1, reasoning: 'IFVG (no Jev): rules only, every qualifying setup is taken.', source: 'rules (no Jev)' };
}

const tfName = (s) => (s >= 3600 ? `${s / 3600}h` : `${s / 60}m`);
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);

/** Weekend = Saturday 00:00 UTC to Monday 00:00 UTC. */
export const isWeekend = (t) => [0, 6].includes(new Date(t).getUTCDay());
/** The Saturday (UTC date) a weekend moment belongs to: one key per weekend. */
export const weekendKey = (t) => { const d = new Date(t); const back = d.getUTCDay() === 0 ? 1 : 0; return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10); };
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
  const parts = [`${setup.grade ? `${setup.grade} ` : ''}${setup.entryModel === 'mech' ? 'MECH ' : setup.entryModel === 'cont' ? 'CONT ' : ''}${(setup.category || 'swing').toUpperCase()} ${side || (setup.direction === 'bearish' ? 'short' : 'long')}`];
  if (setup.qualityReasons?.length) parts.push(setup.qualityReasons.join(' + ').replace(' + -> ', ' -> '));
  // Jev model: no pattern, Jev's own call; the stop sits beyond the recent swing high/low.
  if (setup.model === 'jev') return [...parts, `stop beyond the ${tfName(setup.granularity)} swing ${setup.direction === 'bearish' ? 'high' : 'low'} ${px(setup.swingStop)}`].join(' · ');
  if (setup.htf) parts.push(`tapped unmitigated ${setup.htf.tf} ${setup.htf.type} FVG ${px(setup.htf.bottom)}-${px(setup.htf.top)}${setup.htf.tappedAt ? ` at ${hhmm(setup.htf.tappedAt)} UTC` : ''}`);
  if (setup.sweep && !setup.qualityReasons?.some((q) => q.startsWith('swept'))) parts.push(`swept ${setup.sweep.tf} ${setup.sweep.type} ${px(setup.sweep.price)}`);
  const age = setup.ageCandles === 0 ? 'on the last closed candle' : `${setup.ageCandles} candle${setup.ageCandles === 1 ? '' : 's'} ago`;
  parts.push(`${setup.htf ? '-> ' : ''}${setup.granularity ? tfName(setup.granularity) : ''} ${setup.direction} IFVG ${px(setup.bottom)}-${px(setup.top)} (formed in ${setup.formationCandles ?? '?'} candles${setup.seriesFvgs > 1 ? ` from the first of ${setup.seriesFvgs} FVGs` : ''}, inverted ${age}${setup.displacement ? ', displacement candle' : ''})`);
  return parts.join(' · ').replace(' · -> ', ' -> ');
}

const sig = (v) => Number(Number(v).toPrecision(8));
const zoneSummary = (z) => z && {
  id: z.id, direction: z.direction, top: sig(z.top), bottom: sig(z.bottom),
  formedAt: z.formedAt, invertedAt: z.invertedAt, ageCandles: z.ageCandles, formationCandles: z.formationCandles, seriesFvgs: z.seriesFvgs, grade: z.grade, qualityReasons: z.qualityReasons, clearPath: z.clearPath, granularity: z.granularity, category: z.category, displacement: z.displacement, ...(z.entryModel && { entryModel: z.entryModel }),
  ...(z.htf && {
    htf: { tf: z.htf.tf, type: z.htf.type, top: sig(z.htf.top), bottom: sig(z.htf.bottom), tappedAt: z.htf.tappedAt },
  }),
  ...(z.sweep && { sweep: z.sweep }), ...(z.htfTarget && { htfTarget: z.htfTarget }), ...(z.lrlrToTp != null && { lrlrToTp: z.lrlrToTp }),
  ...(z.smt != null && { smt: z.smt }), ...(z.gapAtr != null && { gapAtr: z.gapAtr }), ...(z.bias && { bias: z.bias, withBias: z.withBias }),
  ...(z.v2 && { v2: z.v2 }),
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

  /** Limit entry price for a setup (limitEntry, 3.8): the IFVG edge when the price is far from it, else null (market). */
  limitFor(side, price, setup) {
    const st = this.state.settings;
    const b0 = bracketFor(side, price, this.stopZone(setup), { rr: st.riskReward ?? 1, minRiskPct: st.minStopPct ?? 0.15 });
    return b0 ? limitEntryPrice(side, price, setup, b0.stop) : null;
  }

  /**
   * A waiting limit entry: filled (entered, with the normal bracket) once a 1m candle trades to the limit before it
   * expires, kept while it waits (also when all trade slots are taken), cancelled after 3 entry candles.
   * Returns { done, side, trade?, order?, note }.
   */
  async checkPendingEntry(p, { candles, liquidity, zones, openAll = 0 }) {
    const now = this.now();
    const short = p.side === 'short';
    const recent = (await this.market.getCandles(60, 20).catch(() => [])).filter((c) => c.time + 60000 > p.createdAt && c.time < p.expiresAt);
    const touched = recent.some((c) => (short ? c.high >= p.limit : c.low <= p.limit));
    const until = new Date(p.expiresAt).toISOString().slice(11, 16);
    const slots = this.state.settings.maxOpenTrades ?? 2;
    if (!touched || openAll >= slots) {
      if (now >= p.expiresAt) {
        delete this.state.pendingEntry;
        return { done: true, side: p.side, note: `Limit ${p.side} at ${fmtPx(p.limit)} not filled within 3 candles: cancelled` };
      }
      return { done: false, side: p.side, note: touched ? `Limit ${p.side} at ${fmtPx(p.limit)} touched, waiting for a free slot (until ${until} UTC)` : `Waiting for the limit ${p.side} at ${fmtPx(p.limit)} (IFVG edge, until ${until} UTC)` };
    }
    delete this.state.pendingEntry;
    const account = await this.broker.getAccount(p.limit);
    const res = await this.openTrade({ side: p.side, setup: p.setup, decision: p.decision, account, price: p.limit, candles, liquidity, zones, limitPrice: p.limit });
    return { done: true, side: p.side, trade: res.trade, order: res.order, note: `Limit ${p.side} at ${fmtPx(p.limit)} reached · ${res.note}` };
  }

  /** $ risk of a trade: riskPerTradeUsd, halved for A setups when riskByGrade is on (A+ = full risk, 4.). */
  riskUsd(setup) {
    const st = this.state.settings;
    const base = st.riskPerTradeUsd ?? 50;
    return st.riskByGrade && setup?.grade !== 'A+' ? base / 2 : base;
  }

  /** Stop zone: the IFVG, widened to the recent swing high / low when stopMode = swing. */
  stopZone(setup) {
    // v2 stop (stopV2, off by default): beyond the raided extreme or the swing (nearer one) + 0.1 x ATR
    const v2 = this.state.settings.stopV2 && setup ? stopV2Level(setup) : null;
    if (v2 != null) return setup.direction === 'bearish' ? { ...setup, top: v2 } : { ...setup, bottom: v2 };
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
      weekendPaused: Boolean(s.weekendPaused),
      weekendPause: s.settings.weekendPause !== false,
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
      // with the time of the next Jev review
      openTrades: trades.filter((t) => t.status === 'open').map((t) => ({ ...t, nextReviewAt: new Date(new Date(t.lastReviewAt || t.entryTime).getTime() + reviewMinutes(t) * 60000).toISOString() })),
      symbol: this.symbol,
      model: s.settings.model || 'ifvg',
      models: Object.fromEntries(Object.entries(MODELS).map(([k, v]) => [k, v.name])),
      modelRules: MODEL_RULES,
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
    // Model switch: each model keeps its own saved settings (risk, limits, filters...)
    if (patch.model && MODELS[patch.model] && patch.model !== (this.state.settings.model || 'ifvg')) {
      const cur = this.state.settings;
      const old = cur.model || 'ifvg';
      const { modelConfigs = {}, ...cfg } = cur;
      modelConfigs[old] = cfg;
      const next = modelConfigs[patch.model];
      this.state.settings = { ...cur, ...(next || {}), model: patch.model, modelConfigs };
    }
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
    if (MODELS[patch.model]) s.model = patch.model;
    if (['jev', 'displacement'].includes(patch.earlyExit)) s.earlyExit = patch.earlyExit;
    if (['off', 'info', 'require'].includes(patch.smt)) s.smt = patch.smt;
    for (const k of ['requireSweep', 'sessionFilter', 'weekendPause', 'learnFromTrades', 'jevShadow', ...V2_SWITCHES]) if (patch[k] !== undefined) s[k] = patch[k] === true || patch[k] === 'true';
    // strategy v2: daily loss stop in R (0 = off) and the smallest first target in R (0.75 = today's rule)
    if (patch.dailyStopR !== undefined && patch.dailyStopR !== '' && !Number.isNaN(Number(patch.dailyStopR))) s.dailyStopR = Math.min(20, Math.max(0, Number(patch.dailyStopR)));
    if (patch.minTargetR !== undefined && patch.minTargetR !== '' && !Number.isNaN(Number(patch.minTargetR))) s.minTargetR = Math.min(3, Math.max(0.5, Number(patch.minTargetR)));
    for (const k of ['minGapAtr', 'partialPct']) if (patch[k] !== undefined && patch[k] !== '' && !Number.isNaN(Number(patch[k]))) s[k] = Math.max(0, Number(patch[k]));
    s.partialPct = Math.min(90, s.partialPct || 0);
    if (patch.requireDisplacement !== undefined) s.requireDisplacement = patch.requireDisplacement === true || patch.requireDisplacement === 'true';
    // Swing / scalp on-off switches (a disabled type is not scanned at all)
    for (const k of ['swingEnabled', 'scalpEnabled', 'mechEnabled']) if (patch[k] !== undefined) s[k] = patch[k] === true || patch[k] === 'true';
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
    // with a fixed R:R target the breakeven trigger must sit before it; liquidity targets are set per trade
    if ((s.targetMode ?? 'rr') === 'rr' && s.breakevenAtR >= s.riskReward) s.breakevenAtR = 0;
    s.maxLeverage = Math.min(125, Math.max(1, Math.round(s.maxLeverage ?? 5))); // Binance caps each symbol lower (BTC 125x, alts 50-75x)
    s.minStopPct = Math.min(2, Math.max(0.05, Number(s.minStopPct ?? 0.15))); // smallest stop distance, % of price
    await this.save();
    return s;
  }

  async setRunning(running) {
    this.state.running = running;
    // a manual switch overrides the weekend pause until the next weekend
    this.state.weekendPaused = false;
    if (isWeekend(this.now())) this.state.weekendPausedFor = weekendKey(this.now());
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

  /**
   * Weekend pause (setting weekendPause, on by default): auto-trading switches itself off on Saturday 00:00 UTC
   * and back on on Monday 00:00 UTC, but only if it was on. Manual On / Off keeps working at any time; switching
   * by hand during the weekend is respected until the next weekend. Runs on the primary bot (it owns On / Off).
   */
  async weekendGuard() {
    const s = this.state;
    if (s.settings.weekendPause === false) return null;
    const now = this.now();
    const note = (msg) => this.log({ time: new Date(now).toISOString(), action: 'HOLD', source: 'weekend', executed: false, note: msg }).catch(() => null);
    if (isWeekend(now)) {
      const key = weekendKey(now);
      if (s.running && s.weekendPausedFor !== key) {
        Object.assign(s, { running: false, weekendPaused: true, weekendPausedFor: key });
        await this.save();
        await note('Weekend: auto-trading paused until Monday 00:00 UTC (open trades keep their stop and target)');
        return 'paused';
      }
    } else if (s.weekendPaused) {
      Object.assign(s, { running: true, weekendPaused: false });
      await this.save();
      await note('Weekend over: auto-trading resumed');
      return 'resumed';
    }
    return null;
  }

  async tickUnlocked() {
    await this.load();
    if (this.primary) await this.weekendGuard();
    const due = !this.state.lastRun
      || this.now() - new Date(this.state.lastRun).getTime() >= this.state.settings.intervalMinutes * 60000 - 5000;
    if (this.state.running && due) return this.runOnceUnlocked();
    const open = (await this.trades()).find((t) => t.status === 'open');
    if (!open) return this.flattenUnknown();
    const candles = await this.market.getCandles(open.granularity || this.state.settings.granularity, 200);
    let closed;
    try {
      closed = await this.manageOpen(candles, candles.at(-1).close);
    } catch (err) {
      // make failures while managing an open trade visible (once per trade and message, not every minute)
      const key = `${open.id}:${err.message}`;
      if (this.state.lastManageError !== key) {
        this.state.lastManageError = key;
        await this.log({ time: new Date(this.now()).toISOString(), action: 'ERROR', source: 'bracket', executed: false, tradeId: open.id, note: `Managing the open ${open.side}: ${err.message}` });
        await this.save();
      }
      throw err;
    }
    return closed && { closed };
  }

  /**
   * Real exchange, no open trade on record for this symbol, but the exchange holds a position: it is not the bot's
   * (a leftover of a partial fill, or opened outside the bot). Close it reduce-only, cancel the symbol's stop /
   * take-profit orders and log it, so the account only ever holds positions the bot shows.
   */
  async flattenUnknown() {
    const b = this.broker;
    if (!b.positionAmt || !b.placeOrder || !b.coverShort) return null;
    const amt = await b.positionAmt();
    if (!amt) return null;
    const price = Number(await this.market.getPrice?.().catch(() => null)) || null;
    if (b.cancelAllAlgos) await b.cancelAllAlgos();
    let order = null;
    try {
      order = amt < 0
        ? await b.coverShort({ qty: Math.abs(amt), price, source: 'ai', reason: 'unknown position' })
        : await b.placeOrder({ side: 'sell', qty: amt, price, source: 'ai', reason: 'unknown position' });
    } catch (err) {
      if (err.code !== 'ALREADY_FLAT') throw err;
    }
    await this.log({
      time: new Date(this.now()).toISOString(), price: order?.price ?? price, action: amt < 0 ? 'BUY' : 'SELL', source: 'bracket', executed: Boolean(order),
      note: `Closed a ${amt < 0 ? 'short' : 'long'} of ${Math.abs(amt)} the bot had no record of${order ? ` at ${order.price}${order.realizedPnl != null ? ` (realized ${Number(order.realizedPnl).toFixed(2)})` : ''}` : ''}`,
    });
    return order ? { flattened: { qty: amt, price: order.price } } : null;
  }

  /** Close the open trade if its stop or target was hit. Returns the closed trade or null. */
  async manageOpen(candles, price) {
    const opens = (await this.trades()).filter((t) => t.status === 'open');
    const open = opens[0];
    if (!open) return null;
    // Real broker: reconcile the records with the exchange position (one position per symbol, newest record first).
    // Records the exchange no longer holds (closed outside the bot, or duplicates) are closed and their stop /
    // target orders cancelled, so they cannot close a later position.
    if (this.broker.positionAmt && opens.every((t) => t.broker === this.broker.name)) {
      const live = (t, amt) => (t.side === 'short' ? amt < 0 : amt > 0);
      const amt = await this.broker.positionAmt();
      const stale = opens.filter((t, i) => i > 0 || (!live(t, amt) && !t.exchangeBracket));
      if (stale.length) {
        let last = null;
        for (const t of stale) {
          if (t.exchangeBracket && this.broker.cancelAlgo) await Promise.all([this.broker.cancelAlgo(t.stopAlgoId), this.broker.cancelAlgo(t.targetAlgoId)]);
          last = await this.closeTrade(t, price, 'manual', candles, { order: null });
        }
        if (!live(open, amt) && this.broker.cancelAllAlgos) await this.broker.cancelAllAlgos(); // flat: no leftovers
        return last;
      }
    }
    // strategy v2 invalidation exit (invalidationExit, off by default, 3.9): an entry-timeframe candle body closes back
    // through the far side of the IFVG before TP1 (no partial taken yet): close at market
    if (this.state.settings.invalidationExit && open.ifvg && !open.partial) {
      const g = open.ifvg.granularity || open.granularity;
      const inv = g ? invalidationCandle(await this.market.getCandles(g, 60).catch(() => []), open, g, this.now()) : null;
      // an exchange stop / target that already filled is booked by the bracket check below, not closed again here
      const live = inv && (!(open.exchangeBracket && this.broker.positionAmt)
        || ((a) => (open.side === 'short' ? a < 0 : a > 0))(await this.broker.positionAmt()));
      if (live) {
        await this.log({
          time: new Date(this.now()).toISOString(), price, action: 'HOLD', source: 'rules', executed: false, tradeId: open.id,
          note: `Invalidation: ${g / 60}m candle at ${new Date(inv.time).toISOString().slice(11, 16)} UTC closed its body ${open.side === 'short' ? 'above' : 'below'} the IFVG (${open.ifvg.bottom}-${open.ifvg.top}): closing the ${open.side || 'long'} at market`,
        });
        return this.closeTrade(open, price, 'invalidation', candles);
      }
    }
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
      // Safety net: the live price is already beyond the target or the stop, but the exchange order has not closed the
      // position (it did not trigger, or it is gone). Close it at market ourselves and record why.
      const short = open.side === 'short';
      const pastT = Number.isFinite(price) && (short ? price <= open.target : price >= open.target);
      const pastS = Number.isFinite(price) && (short ? price >= open.stop : price <= open.stop);
      if (pastT || pastS) {
        const [sl, tp] = await Promise.all([this.broker.algoStatus(open.stopAlgoId), this.broker.algoStatus(open.targetAlgoId)]);
        await this.log({
          time: new Date(this.now()).toISOString(), price, action: 'HOLD', source: 'bracket', executed: false, tradeId: open.id,
          note: `Exchange ${pastT ? 'take-profit' : 'stop'} did not close the ${open.side} (price ${price} is past ${pastT ? `TP ${open.target}` : `SL ${open.stop}`}; exchange stop ${sl?.status || 'not found'}, take-profit ${tp?.status || 'not found'}): closing at market`,
        });
        return this.closeTrade(open, price, pastT ? 'target' : open.breakeven ? 'breakeven' : 'stop', candles);
      }
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

  /**
   * The trade's full result from the exchange: the entry order's fills plus every closing fill since entry (up to the
   * entry quantity). Returns { exitPrice, pnl, fees, grossPnl, r, bookedFromFills } or null when the exchange cannot
   * tell yet (not a real-broker trade, or the position is not fully closed).
   */
  async exchangeBook(t) {
    const b = this.broker;
    if ((t.broker ?? 'local') !== b.name || !b.closingFills || !b.fills || !t.orderId) return null;
    const entry = await b.fills(String(t.orderId));
    if (!entry?.qty) return null;
    const closes = await b.closingFills({ sinceMs: Date.parse(t.entryTime), side: t.side === 'short' ? 'BUY' : 'SELL', qty: entry.qty, excludeOrderId: t.orderId });
    if (!closes || closes.qty < entry.qty * 0.98) return null;
    const fees = entry.commission + closes.commission;
    const pnl = closes.realizedPnl - fees;
    const risk = Math.abs(t.entryPrice - (t.initialStop ?? t.stop));
    return {
      exitPrice: closes.price,
      pnl: Number(pnl.toFixed(2)),
      fees: Number(fees.toFixed(2)),
      grossPnl: Number(closes.realizedPnl.toFixed(2)),
      r: Number((((t.side === 'short' ? -1 : 1) * (closes.price - t.entryPrice)) / risk).toFixed(2)),
      bookedFromFills: true,
    };
  }

  /** Re-book a closed trade from the exchange fills (all closing fills since entry). */
  async rebook(id) {
    const trades = await this.trades();
    const i = trades.findIndex((t) => t.id === id);
    if (i < 0) throw new Error(`Trade ${id} not found on ${this.symbol}`);
    const t = trades[i];
    if (t.status === 'open') throw new Error('Trade is still open');
    const booked = await this.exchangeBook(t);
    if (!booked) throw new Error('The exchange fills do not show this position fully closed');
    const before = t.pnl;
    Object.assign(t, booked, {
      status: Math.abs(booked.pnl) < 0.005 ? 'breakeven' : booked.pnl > 0 ? 'win' : 'loss',
      note: `Re-booked from every Binance closing fill since entry (P&L ${before} -> ${booked.pnl})`,
    });
    trades[i] = t;
    await this.kv.set('trades', trades);
    await this.log({ time: new Date(this.now()).toISOString(), price: booked.exitPrice, action: 'HOLD', source: 'bracket', executed: false, tradeId: t.id, note: t.note });
    return t;
  }

  /**
   * Repair a closed trade whose exit was booked against the wrong order: take the exit from a real Binance order
   * (its fills: price, qty, fee, realized P&L) and recompute P&L, fees, R and the result like closeTrade does.
   */
  async fixExit(id, orderId, reason) {
    const trades = await this.trades();
    const i = trades.findIndex((t) => t.id === id);
    if (i < 0) throw new Error(`Trade ${id} not found on ${this.symbol}`);
    const t = trades[i];
    if (t.status === 'open') throw new Error('Trade is still open');
    const f = await this.broker.fills?.(String(orderId));
    if (!f) throw new Error(`No fills found for order ${orderId}`);
    const short = t.side === 'short';
    const part = Math.min(1, f.qty / t.qty);
    let pnl = f.realizedPnl - (t.entryFee || 0) * part - f.commission;
    if (t.partial) pnl += t.partial.pnl;
    if (t.trimPnl) pnl += t.trimPnl;
    const fees = (t.entryFee || 0) * part + f.commission;
    const risk = Math.abs(t.entryPrice - (t.initialStop ?? t.stop));
    const pt = t.partial;
    const exitReason = reason || t.exitReason;
    Object.assign(t, {
      exitPrice: f.price,
      exitOrderId: String(orderId),
      exitReason,
      status: exitReason === 'breakeven' ? (pt && pnl > 0 ? 'win' : 'breakeven') : Math.abs(pnl) < 0.005 ? 'breakeven' : pnl > 0 ? 'win' : 'loss',
      pnl: Number(pnl.toFixed(2)),
      fees: Number(fees.toFixed(2)),
      grossPnl: Number((pnl + fees).toFixed(2)),
      r: Number(((((short ? -1 : 1) * (f.price - t.entryPrice)) / risk) * (pt ? 1 - pt.fraction : 1) + (pt ? pt.r * pt.fraction : 0)).toFixed(2)),
      note: `Exit corrected to Binance order ${orderId} (${f.qty} @ ${f.price}, realized ${f.realizedPnl.toFixed(2)}, fee ${f.commission.toFixed(2)})`,
    });
    trades[i] = t;
    await this.kv.set('trades', trades);
    await this.log({ time: new Date(this.now()).toISOString(), price: f.price, action: 'HOLD', source: 'bracket', executed: false, tradeId: t.id, note: t.note });
    return t;
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

  /** Breakeven setting changed: open trades of the model (not yet at breakeven) use it from now on. */
  async applyBreakeven(beR, model) {
    const trades = await this.trades();
    let n = 0;
    for (const t of trades) {
      if (t.status !== 'open' || t.breakeven || (t.model || 'ifvg') !== model || (Number(t.breakevenAtR) || 0) === beR) continue;
      Object.assign(t, { breakevenAtR: beR, breakevenSince: new Date(this.now()).toISOString() });
      n++;
    }
    if (n) await this.kv.set('trades', trades);
    return n;
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
      // closing ourselves (review / signal / safety net): remove the exchange stop and target first
      if (trade.exchangeBracket && broker.cancelAllAlgos) await broker.cancelAllAlgos();
      else if (trade.exchangeBracket && broker.cancelAlgo) await Promise.all([broker.cancelAlgo(trade.stopAlgoId), broker.cancelAlgo(trade.targetAlgoId)]);
      if (broker.positionAmt) {
        // real exchange, one position per symbol: close ALL of it in this direction (the close is reduce-only, so it
        // can never flip the position), leftovers from partial fills included
        const amt = await broker.positionAmt();
        qty = (short ? amt < 0 : amt > 0) ? Math.abs(amt) : 0;
      } else {
        const account = await broker.getAccount(exitPrice);
        qty = Math.min(trade.qty, short ? account.shortBtc || 0 : account.btc);
      }
    }
    if (external) {
      if (!order) note = 'Closed outside the bot (no matching exchange order)';
    } else if (qty * exitPrice >= 1) {
      try {
        order = short
          ? await broker.coverShort({ qty, price: exitPrice, source: 'ai', reason })
          : await broker.placeOrder({ side: 'sell', qty, price: exitPrice, source: 'ai', reason });
      } catch (err) {
        if (err.code !== 'ALREADY_FLAT') throw err;
        note = 'Already closed on the exchange (its stop / take-profit filled first)';
      }
    } else {
      note = 'Position was already closed on the exchange';
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
    // Real exchange: book the full result from every fill that closed the position (stop / target, partial, trim,
    // a bot or manual close), not just the last order: a stop that fills in parts is counted completely.
    const booked = await this.exchangeBook(trade).catch(() => null);
    if (booked) Object.assign(trade, booked, { status: reason === 'breakeven' && booked.pnl <= 0 ? 'breakeven' : Math.abs(booked.pnl) < 0.005 ? 'breakeven' : booked.pnl > 0 ? 'win' : 'loss' });
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

  async openTrade({ side, setup, decision, account, price, candles, liquidity, zones = [], limitPrice = null }) {
    const label = side === 'short' ? 'SHORT' : 'BUY';
    // size on the live price, not the last candle close (a stale price under-sizes the stop distance).
    // A touched limit entry fills at the limit in the simulator; a real exchange fills it at market.
    const live = limitPrice && this.broker.name === 'local' ? limitPrice : Number(await this.market.getPrice?.().catch(() => null));
    if (live > 0) price = live;
    if (!bracketFor(side, price, setup)) return { note: `${label} skipped: price is on the wrong side of the IFVG, no valid stop` };
    const st = this.state.settings;
    let margin, leverage, size, sizing = '';
    if ((st.sizingMode ?? 'percent') === 'risk') {
      // Risk-based: lose about riskPerTradeUsd if the stop is hit.
      const b0 = bracketFor(side, price, this.stopZone(setup), { rr: st.riskReward ?? 1, minRiskPct: st.minStopPct ?? 0.15 });
      if (!(b0?.risk > 0)) return { note: `${label} skipped: stop distance is zero` };
      const rs = riskSize({
        riskUsd: this.riskUsd(setup), stopDist: b0.risk, price, cash: account.cash,
        levPick: decision.leverage, maxLev: st.maxLeverage ?? 5, canLever: Boolean(this.broker.supportsLeverage),
      });
      if (rs.notional < MIN_ORDER_USD) return { note: `${label} skipped: not enough cash for the risk size` };
      ({ margin, leverage } = rs);
      size = rs.notional;
      sizing = ` · risk-sized $${rs.riskUsd}${st.riskByGrade ? ` (${setup.grade || 'A'} risk)` : ''}${rs.capped ? ` (trimmed from $${this.riskUsd(setup)}: not enough margin at ${leverage}x)` : ''}`;
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
      const want = this.riskUsd(setup);
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
      const lt = pr >= 0.5 ? { ...p, r: Number(pr.toFixed(2)), byJev: true } : liquidityTarget(liquidity, side, entryPrice, b.risk, { category: setup.category, minR: st.minTargetR ?? 0.75 });
      if (lt) { b.target = lt.price; b.rr = lt.r; targetLevel = `${lt.level.label || lt.level.type} ${fmtPx(lt.price)}${lt.byJev ? ' (Jev pick)' : ''}`; }
    }
    // HTF FVG chosen as the target at scan time (it was in the way): recompute from the actual fill
    if (setup.htfTarget) {
      const ht = setup.htfTarget.price;
      const hr = (side === 'short' ? entryPrice - ht : ht - entryPrice) / b.risk;
      if (hr >= 0.5) { b.target = ht; b.rr = Number(hr.toFixed(2)); targetLevel = `${setup.htfTarget.tf} ${setup.htfTarget.type} FVG ${setup.htfTarget.inside ? 'far edge (gap fill)' : 'near edge'} ${fmtPx(ht)}`; }
    }
    // A 30m-4h FVG inside the bracket (between entry and target) is where price reacts first: target its near edge.
    const hz = htfTargetInBracket(zones, side, entryPrice, b.target, b.risk);
    if (hz) { b.target = hz.price; b.rr = hz.r; targetLevel = `${hz.zone.tf} ${hz.zone.type} FVG ${fmtPx(hz.price)} (HTF in bracket)`; }
    // Binance moved the leverage tier or cut the size to fit its position limit: margin follows the filled position
    if (order.limitNote) margin = Number((notional / leverage).toFixed(2));
    const plan = { note: `${label} $${notional.toFixed(2)}${leverage > 1 ? ` (${leverage}x, margin $${margin.toFixed(2)})` : ''}${sizing}${trimmed}${order.limitNote ? ` · ${order.limitNote}` : ''}` };
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
      model: setup.model || this.state.settings.model || 'ifvg',
      ...(setup.reviewEvery && { reviewEvery: setup.reviewEvery }),
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

  /** Jev shadow grade of a setup (once per setup id), kept in 'jev_shadow' (newest first). Never affects a trade. */
  async shadowJev(setup, { liquidity, candles = [], granularity }) {
    if (!this.ai?.apiKey || this.ai.provider !== 'jev') return null;
    const seen = this.state.shadowed || [];
    if (seen.includes(setup.id)) return null;
    this.state.shadowed = [...seen, setup.id].slice(-50);
    const base = {
      id: `${this.symbol}:${setup.id}`, setupId: setup.id, symbol: this.symbol, time: new Date(this.now()).toISOString(),
      direction: setup.direction, category: setup.category, entryModel: setup.entryModel || null, granularity,
      grade: setup.grade ?? null, v2grade: setup.v2?.grade ?? null,
    };
    let rec;
    try {
      rec = { ...base, ...(await askJevShadow({ setup, symbol: this.symbol, liquidity, recentCandles: candles.slice(-24), granularity, now: this.now() }, this.ai, this.fetch)) };
    } catch (err) {
      rec = { ...base, error: err.message, promptVersion: SHADOW_PROMPT_VERSION };
    }
    const list = await this.kv.get('jev_shadow', []);
    await this.kv.set('jev_shadow', [rec, ...list.filter((x) => x.id !== rec.id)].slice(0, 1000));
    return rec;
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
  /** JEV · all symbols pop-up when the Jev model is selected: no pattern scan, Jev's own read of the market. */
  async jevModelView(s, open) {
    const candles = closedCandles(await this.market.getCandles(300, 200), 300, this.now());
    const indicators = summarize(candles);
    const base = {
      symbol: this.symbol, price: indicators.price, open: open ? open.side || 'long' : null,
      setup: 'Jev model: no pattern filter, Jev reads the market every 3 min', note: null,
    };
    if (!this.ai.apiKey || this.ai.provider !== 'jev') return { ...base, error: 'Jev key not set' };
    const liquidity = await liquidityLevels(this.market, this.now()).catch(() => null);
    const account = await this.broker.getAccount(indicators.price).catch(() => ({ cash: 0, equity: 0 }));
    const d = await askJev({
      indicators, account, recentCandles: candles.slice(-24), granularity: 300, ifvg: null, jevOnly: !open, model: 'jev',
      review: open && { side: open.side || 'long', minutesOpen: Math.round((this.now() - new Date(open.entryTime).getTime()) / 60000), unrealizedR: 0 },
      riskReward: s.riskReward ?? 1, maxLeverage: this.broker.supportsLeverage ? s.maxLeverage ?? 5 : 1, breakevenAtR: s.breakevenAtR ?? 0,
      liquidity, targetMode: s.targetMode ?? 'rr', maxTradesPerDay: s.maxTradesPerDay,
      openTrade: open && { side: open.side || 'long', entryPrice: open.entryPrice, stop: open.stop, target: open.target },
    }, this.ai, this.fetch);
    const all = await this.allTrades();
    const openAll = all.filter((t) => t.status === 'open').length;
    const cap = s.maxOpenTrades ?? 2;
    let botAction;
    if (open) botAction = d.action === EXIT_ACTION[open.side || 'long'] && d.confidence >= s.minConfidence
      ? `Jev wants to close the ${open.side}: it closes on the next review` : `managing the open ${open.side} (Jev ${d.action === 'HOLD' ? 'holds' : 'leans against it'})`;
    else if (d.action === 'HOLD') botAction = 'Jev: no trade now';
    else if (d.confidence < s.minConfidence) botAction = `Jev ${d.action} below ${s.minConfidence}: no entry`;
    else if (openAll >= cap) botAction = `${d.action === 'BUY' ? 'LONG' : 'SHORT'} wanted, waiting for a free slot (${openAll}/${cap} open)`;
    else botAction = `${d.action === 'BUY' ? 'LONG' : 'SHORT'}${d.style ? ` (${d.style.toLowerCase()})` : ''}: the bot opens it at the next 3-min check`;
    return { ...base, action: d.action, confidence: d.confidence, odds: d.odds, modelConfidence: d.modelConfidence, sizePct: d.sizePct, leverage: d.leverage, botAction };
  }

  async jevView() {
    const s = this.state.settings;
    const model = s.model || 'ifvg';
    const open = (await this.trades()).find((t) => t.status === 'open');
    if (model === 'jev') return this.jevModelView(s, open);
    // the selected model's own scan (IFVG, ICT 2022, Unicorn, AMD, Forever)
    const scan = isIfvg(model)
      ? await scanSetups(this.market, s, this.now(), { pairMarket: this.pairMarket, symbol: this.symbol })
      : await scanModel(model, this.market, s, this.now(), { pairMarket: this.pairMarket });
    const indicators = summarize(scan.candles);
    const st = scan.setup;
    const name = MODELS[model]?.name || model;
    const base = {
      symbol: this.symbol, price: indicators.price, open: open ? open.side || 'long' : null, note: scan.note || null,
      setup: st ? `${name}: ${st.category} ${st.granularity / 60}m ${st.direction}${isIfvg(model) ? ' IFVG' : ' setup'}${st.grade ? ` (${st.grade})` : ''}` : null,
    };
    // IFVG (no Jev): the rules alone decide, nothing to ask
    if (model === 'ifvg_nojev') {
      const want = st ? SIDE_FOR[st.direction] : null;
      return {
        ...base, action: want ? ENTRY_ACTION[want] : 'HOLD', confidence: want ? 1 : null, noJev: true,
        botAction: open ? `managing the open ${open.side || 'long'} (stop / target; an opposite IFVG closes it)`
          : st ? `rules: ${want.toUpperCase()} on the next scan unless a filter or limit blocks it` : 'waiting for an IFVG setup',
      };
    }
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
    else if (!st) botAction = d.action === 'HOLD' ? `waiting for a ${name} setup` : `no ${name} setup: Jev ${d.action} alone does not open a trade`;
    else if (d.action !== ENTRY_ACTION[want]) botAction = `Jev ${d.action} does not match the ${st.direction} setup: no entry`;
    else if (d.confidence < s.minConfidence) botAction = `confidence below ${s.minConfidence}: no entry`;
    else if (openAll >= cap) botAction = `${want.toUpperCase()} aligned, waiting for a free slot (${openAll}/${cap} open)`;
    else botAction = `${want.toUpperCase()} aligned: the bot enters on its next scan`;
    return { ...base, action: d.action, confidence: d.confidence, odds: d.odds, modelConfidence: d.modelConfidence, sizePct: d.sizePct, leverage: d.leverage, botAction };
  }

  /**
   * Jev model: no pattern. Every 3 min (per symbol, no open trade) Jev reads price, structure and liquidity and
   * decides BUY / SELL / HOLD and SCALP / SWING; the stop goes beyond the recent swing (1m for scalps, 5m for swings)
   * and the target on liquidity. Open trades are reviewed every 3 min (scalps) / 2 min (swings) and Jev may close them.
   * Fills entry (the decision log row) and returns the scan outcome class.
   */
  async runJevOnly(entry, s, { swingLeft, scalpLeft }) {
    const open = (await this.trades()).find((t) => t.status === 'open');
    const all = await this.allTrades();
    const count = tradesToday(all, this.now());
    const openAll = all.filter((t) => t.status === 'open').length;
    const candles = closedCandles(await this.market.getCandles(300, 200), 300, this.now());
    const indicators = summarize(candles);
    const liquidity = await liquidityLevels(this.market, this.now()).catch(() => null);
    this.state.liquidity = liquidity && { above: liquidity.above.slice(0, 4), below: liquidity.below.slice(0, 4), lrlr: liquidity.lrlr, draw: liquidity.draw };
    const price = Number(await this.market.getPrice?.().catch(() => null)) || indicators.price;
    entry.price = price;
    entry.source = 'jev-only';
    const lastAsk = this.state.lastJevAsk ? Date.parse(this.state.lastJevAsk) : 0;
    const review = Boolean(open && reviewDue(open, this.now()));
    let reason = null;
    if (open && !review) reason = `Jev model: managing open trade (next review ${nextReviewLabel(open)})`;
    else if (!open && this.now() - lastAsk < 3 * 60000 - 5000) reason = `Jev model: next market check ${hhmm(lastAsk + 3 * 60000)} UTC`;
    else if (!open && count >= s.maxTradesPerDay) reason = `Daily limit reached (${count}/${s.maxTradesPerDay})`;
    else if (!open && openAll >= (s.maxOpenTrades ?? 2)) reason = `Jev model: waiting for a free slot (${openAll}/${s.maxOpenTrades ?? 2} open)`;
    else if (!open && !swingLeft && !scalpLeft) reason = 'Daily swing and scalp limits reached';
    else if (!open && s.sessionFilter && !inSession(this.now())) reason = 'Jev model: outside the London / New York session';
    this.state.lastScan = { time: entry.time, note: reason || (review ? 'Jev reviewing open trade (Jev model)' : 'Asked Jev (Jev model)') };
    if (reason) { Object.assign(entry, { action: 'HOLD', note: reason, executed: false }); return open ? 'inTrade' : 'other'; }
    if (!open) this.state.lastJevAsk = entry.time;
    const account = await this.broker.getAccount(price);
    const decision = await decide({
      indicators, account, recentCandles: candles.slice(-24), granularity: 300, ifvg: null, jevOnly: !review, model: 'jev',
      review: review && { side: open.side || 'long', minutesOpen: Math.round((this.now() - new Date(open.entryTime).getTime()) / 60000), unrealizedR: Number(((open.side === 'short' ? open.entryPrice - price : price - open.entryPrice) / Math.abs(open.entryPrice - (open.initialStop ?? open.stop))).toFixed(2)) },
      recentDecisions: await this.decisions(5), tradesToday: count, riskReward: s.riskReward ?? 1, liquidity, targetMode: s.targetMode ?? 'rr',
      trackRecord: this.learned(all, 'jev'),
      maxLeverage: this.broker.supportsLeverage ? s.maxLeverage ?? 5 : 1, breakevenAtR: s.breakevenAtR ?? 0, maxTradesPerDay: s.maxTradesPerDay,
      openTrade: open && { side: open.side || 'long', entryPrice: open.entryPrice, stop: open.stop, target: open.target },
    }, this.ai, this.fetch);
    Object.assign(entry, { action: decision.action, confidence: decision.confidence, sizePct: decision.sizePct, reasoning: decision.reasoning, source: `jev-only · ${decision.source}`, executed: false });
    const confident = decision.confidence >= s.minConfidence;
    if (review) {
      await this.markReviewed(open);
      entry.tradeId = open.id;
      if (confident && decision.action === EXIT_ACTION[open.side || 'long']) {
        const t = await this.closeTrade(open, price, 'review', candles);
        Object.assign(entry, { executed: true, label: `CLOSE ${(open.side || 'long').toUpperCase()}`, note: `Jev model: Jev closed the ${open.side || 'long'} · P&L ${t.pnl >= 0 ? '+' : '-'}$${Math.abs(t.pnl).toFixed(2)}` });
      } else {
        Object.assign(entry, { label: 'HOLD', note: `Jev model: keep ${open.side || 'long'} open (${decision.action}${confident ? '' : ', low confidence'}) · next review ${nextReviewLabel(open)}` });
      }
      return 'inTrade';
    }
    if (!['BUY', 'SELL'].includes(decision.action)) { entry.note = 'Jev model: HOLD, no trade'; return 'asked'; }
    if (!confident) { entry.note = `Jev model: ${decision.action} ${decision.confidence} below minimum ${s.minConfidence}`; return 'asked'; }
    const side = decision.action === 'BUY' ? 'long' : 'short';
    let style = decision.style === 'SCALP' ? 'scalp' : 'swing';
    if (style === 'scalp' && (!scalpLeft || s.scalpEnabled === false)) style = 'swing';
    if (style === 'swing' && (!swingLeft || s.swingEnabled === false)) style = 'scalp';
    if ((style === 'scalp' && (!scalpLeft || s.scalpEnabled === false)) || (style === 'swing' && (!swingLeft || s.swingEnabled === false))) { entry.note = 'Jev model: no swing or scalp trades left today'; return 'limit'; }
    const g = style === 'scalp' ? 60 : 300;
    const sc = closedCandles(await this.market.getCandles(g, 200), g, this.now());
    const win = sc.slice(-12);
    const extreme = side === 'long' ? Math.min(...win.map((k) => k.low)) : Math.max(...win.map((k) => k.high));
    const setup = {
      direction: side === 'long' ? 'bullish' : 'bearish',
      top: side === 'long' ? price : extreme, bottom: side === 'long' ? extreme : price, swingStop: extreme,
      id: `jev:${this.symbol}:${entry.time}`, granularity: g, category: style, model: 'jev', grade: 'JEV',
      reviewEvery: style === 'scalp' ? 3 : 2, ageCandles: 0, formedAt: Date.parse(entry.time), invertedAt: Date.parse(entry.time),
      qualityReasons: [`Jev model: Jev ${decision.action} ${Math.round(decision.confidence * 100)}%, ${style}`],
    };
    const res = await this.openTrade({ side, setup, decision, account, price, candles: sc, liquidity, zones: [] });
    entry.note = res.note;
    if (res.trade) Object.assign(entry, { executed: true, tradeId: res.trade.id, order: res.order, label: side === 'short' ? 'SHORT' : 'LONG' });
    return 'asked';
  }

  // ---------------- daily suggestions (selected model only) ----------------

  async suggestions() { return this.kv.get('suggestions', []); }

  /** The model's 14-day track record for Jev (this symbol in detail), or null when learning is off / no trades. */
  learned(trades, model) {
    if (this.state.settings.learnFromTrades === false) return null;
    return trackRecord(trades, { model, symbol: this.symbol, now: this.now() }).text || null;
  }

  /**
   * Look at one UTC day's closed trades of the selected model and suggest concrete setting changes.
   * Each suggestion: { id, day, model, title, detail, patch, status: pending | approved | ignored }.
   */
  async generateSuggestions(day = utcDay(this.now() - 86400000)) {
    const s = this.state.settings;
    const model = s.model || 'ifvg';
    const T = (await this.allTrades()).filter((t) => t.status !== 'open' && t.exitTime && utcDay(t.entryTime) === day && (t.model || 'ifvg') === model);
    const R = (a) => a.reduce((x, t) => x + (t.r || 0), 0);
    const P = (a) => a.reduce((x, t) => x + (t.pnl || 0), 0);
    const W = (a) => a.filter((t) => t.status === 'win').length;
    const out = [];
    const add = (title, detail, patch) => out.push({ id: `S${day}-${out.length}-${model}`, day, model, title, detail, patch, status: patch ? 'pending' : 'info', createdAt: new Date(this.now()).toISOString() });
    if (T.length === 0) add('No closed trades', `No closed ${MODELS[model]?.name || model} trades on ${day}: nothing to tune yet.`, null);
    else {
      const wins = W(T);
      add('Day summary', `${T.length} trades · ${wins} wins · net ${R(T).toFixed(2)}R · P&L $${P(T).toFixed(2)}`, null);
      // fees eating the edge
      const feeR = T.filter((t) => t.fees != null && t.riskUsd).map((t) => t.fees / t.riskUsd);
      const avgFee = feeR.length ? feeR.reduce((a, b) => a + b, 0) / feeR.length : 0;
      if (avgFee > 0.25) add('Fees are eating the edge', `Fees averaged ${avgFee.toFixed(2)}R per trade. A wider minimum stop means a smaller position and lower fees for the same $ risk.`, { minStopPct: Math.min(1, Math.max(0.3, Number(((s.minStopPct ?? 0.15) * 2).toFixed(2)))) });
      // no displacement losers
      const noDisp = T.filter((t) => t.ifvg && !t.ifvg.displacement);
      if (noDisp.length >= 2 && R(noDisp) < 0 && !s.requireDisplacement) add('Require a displacement candle', `Trades without displacement: ${noDisp.length}, net ${R(noDisp).toFixed(2)}R.`, { requireDisplacement: true });
      // early exits
      const early = T.filter((t) => ['review', 'signal'].includes(t.exitReason));
      if (early.length >= 2 && R(early) < 0 && s.earlyExit !== 'displacement') add('Stop closing trades early', `Jev's early closes: ${early.length}, net ${R(early).toFixed(2)}R. Let trades run to stop / target (close only on an opposite IFVG with displacement).`, { earlyExit: 'displacement' });
      // swing vs scalp
      const sw = T.filter((t) => t.category !== 'scalp'), sc = T.filter((t) => t.category === 'scalp');
      if (sc.length >= 3 && R(sc) < 0 && R(sw) >= 0) add('Fewer scalps', `Scalps: ${sc.length}, net ${R(sc).toFixed(2)}R; swings net ${R(sw).toFixed(2)}R.`, { maxScalpPerDay: Math.max(0, Math.floor((s.maxScalpPerDay ?? 5) / 2)) });
      if (sw.length >= 3 && R(sw) < 0 && R(sc) >= 0) add('Fewer swings', `Swings: ${sw.length}, net ${R(sw).toFixed(2)}R; scalps net ${R(sc).toFixed(2)}R.`, { maxSwingPerDay: Math.max(0, Math.floor((s.maxSwingPerDay ?? 5) / 2)) });
      // quick stop-outs: stop too tight
      const losses = T.filter((t) => t.status === 'loss');
      const quick = losses.filter((t) => t.exitReason === 'stop' && Date.parse(t.exitTime) - Date.parse(t.entryTime) < 10 * 60000);
      if (losses.length >= 2 && quick.length / losses.length >= 0.4 && s.stopMode !== 'swing') add('Stop beyond the recent swing', `${quick.length} of ${losses.length} losses were stopped within 10 minutes: the stop sits too close.`, { stopMode: 'swing' });
      // confidence
      const lowC = T.filter((t) => (t.confidence ?? 1) < 0.85), highC = T.filter((t) => (t.confidence ?? 0) >= 0.85);
      if (lowC.length >= 2 && R(lowC) < 0 && R(highC) > 0 && (s.minConfidence ?? 0.6) < 0.85) add('Raise the Jev confidence minimum', `Below 0.85: net ${R(lowC).toFixed(2)}R · 0.85+: net ${R(highC).toFixed(2)}R.`, { minConfidence: 0.85 });
      // small winners
      const wr = wins / T.length;
      const winR = T.filter((t) => t.status === 'win');
      if (wr >= 0.6 && winR.length && R(winR) / winR.length < 1 && (s.targetMode ?? 'rr') === 'rr') add('Let winners run further', `Win rate ${Math.round(wr * 100)}% but the average win is ${(R(winR) / winR.length).toFixed(2)}R.`, { riskReward: Math.min(5, (s.riskReward ?? 1) + 0.5) });
      // sessions (UTC): Asia 00-07, London 07-12, New York 12-17, late 17-24
      const sessionOf = (t) => { const h = new Date(t.entryTime).getUTCHours(); return h < 7 ? 'Asian' : h < 12 ? 'London' : h < 17 ? 'New York' : 'late (after New York)'; };
      const wrOf = (a) => { const w = W(a), l = a.filter((t) => t.status === 'loss').length; return w + l ? w / (w + l) : null; };
      const overall = wrOf(T);
      const bySession = {};
      for (const t of T) (bySession[sessionOf(t)] ||= []).push(t);
      const worst = Object.entries(bySession).filter(([, a]) => a.length >= 3).map(([k, a]) => ({ k, a, wr: wrOf(a) })).filter((x) => x.wr !== null).sort((x, y) => x.wr - y.wr)[0];
      if (worst && overall !== null && worst.wr < overall - 0.15 && !s.sessionFilter) {
        add(`Weak ${worst.k} session`, `Your win rate drops to ${Math.round(worst.wr * 100)}% during ${worst.k} hours (${worst.a.length} trades, net ${R(worst.a).toFixed(2)}R) against ${Math.round(overall * 100)}% overall. I recommend enabling the Session Filter: only trade the London open (07:00-10:00 UTC) and New York open (12:30-16:00 UTC).`, { sessionFilter: true });
      }
      // against the 4h bias (information)
      const against = T.filter((t) => t.ifvg?.withBias === false);
      if (against.length >= 2 && R(against) < 0) add('Losses against the 4h bias', `${against.length} trades against the 4h bias, net ${R(against).toFixed(2)}R. No setting for this yet: information only.`, null);
    }
    // Experience: the model's last 14 days (not just this day) and how earlier approved changes worked out
    const allTrades = await this.allTrades();
    const rec = trackRecord(allTrades, { model, now: Date.parse(`${day}T23:59:59Z`) });
    const effects = approvedEffects(await this.suggestions(), allTrades, { model, now: this.now() });
    if (rec.n) {
      const o = rec.overall;
      out.push({ id: `S${day}-${out.length}-${model}`, day, model, title: 'Track record (14 days)', detail: `${o.n} trades · ${o.wins} wins${o.winRate == null ? '' : ` (${Math.round(o.winRate * 100)}%)`} · net ${o.r >= 0 ? '+' : ''}${o.r}R. ${rec.bySymbol.map((g) => `${g.key} ${g.r >= 0 ? '+' : ''}${g.r}R`).join(' · ')}`, patch: null, origin: 'trade history', status: 'info', createdAt: new Date(this.now()).toISOString() });
      const have = new Set(out.flatMap((x) => Object.keys(x.patch || {})));
      for (const x of experienceSuggestions(rec, s)) {
        if (x.patch && Object.keys(x.patch).some((k) => have.has(k))) continue;
        out.push({ id: `S${day}-${out.length}-${model}`, day, model, ...x, origin: 'trade history', status: x.patch ? 'pending' : 'info', createdAt: new Date(this.now()).toISOString() });
      }
    }
    for (const e of effects) {
      const better = e.after.r / e.after.n > e.before.r / e.before.n;
      out.push({ id: `S${day}-${out.length}-${model}`, day, model, title: `Result of "${e.title}"`, detail: `${better ? 'Better since' : 'Not better since'} it was enabled. ${e.text.slice(e.text.indexOf(': ') + 2)}`, patch: null, origin: 'trade history', status: 'info', createdAt: new Date(this.now()).toISOString() });
    }
    // Web research (OpenRouter model with web search): sourced ideas for this model, given the day's results and the track record
    if (this.ai.apiKey && this.ai.provider !== 'gemini') {
      const by = (f) => { const a = T.filter(f); return `${a.length} trades, ${W(a)} wins, ${R(a).toFixed(2)}R`; };
      const stats = T.length
        ? `${day}: ${by(() => true)}, P&L $${P(T).toFixed(2)}; swing ${by((t) => t.category !== 'scalp')}; scalp ${by((t) => t.category === 'scalp')}; `
          + `long ${by((t) => t.side !== 'short')}; short ${by((t) => t.side === 'short')}; stopped out ${by((t) => t.exitReason === 'stop')}; `
          + `closed early by Jev ${by((t) => ['review', 'signal'].includes(t.exitReason))}; average fees ${(T.reduce((x, t) => x + (t.fees || 0), 0) / T.length).toFixed(2)} $ per trade on ${s.riskPerTradeUsd ?? 50} $ risk`
        : `${day}: no closed trades yet`;
      try {
        const experience = [rec.text, ...effects.map((e) => `earlier change ${e.text}`)].filter(Boolean).join(' | ');
        const web = await researchSuggestions({ modelName: MODELS[model]?.name || model, rules: MODEL_RULES[model] || '', stats, experience, ignoreKeys: model === 'jev' ? PATTERN_ONLY : model === 'ifvg_nojev' ? ['minConfidence'] : [], settings: s, apiKey: this.ai.apiKey, fetchImpl: this.fetch });
        for (const w of web) {
          out.push({ id: `S${day}-${out.length}-${model}`, day, model, title: w.title, detail: w.detail, patch: w.patch, sources: w.sources, origin: `web research (${w.model})`, status: w.patch ? 'pending' : 'info', createdAt: new Date(this.now()).toISOString() });
        }
      } catch (err) {
        out.push({ id: `S${day}-${out.length}-${model}`, day, model, title: 'Web research unavailable', detail: err.message.slice(0, 200), patch: null, origin: 'web research', status: 'info', createdAt: new Date(this.now()).toISOString() });
      }
    }
    // Jev model: pattern-only settings (displacement, sweep, session filter, stop mode, early exit...) do nothing, drop them
    const skipKeys = model === 'jev' ? PATTERN_ONLY : model === 'ifvg_nojev' ? ['minConfidence'] : [];
    if (skipKeys.length) {
      for (let i = out.length - 1; i >= 0; i--) {
        const p = out[i].patch;
        if (!p) continue;
        for (const k of skipKeys) delete p[k];
        if (Object.keys(p).length) continue;
        if (out[i].origin?.startsWith('web research')) Object.assign(out[i], { patch: null, status: 'info' });
        else out.splice(i, 1);
      }
    }
    const list = await this.suggestions();
    const kept = list.filter((x) => !(x.day === day && x.model === model && x.status !== 'approved' && x.status !== 'ignored'));
    await this.kv.set('suggestions', [...out, ...kept].slice(0, 300));
    return out;
  }

  /** Once a day (first cycle after 00:05 UTC): suggestions for the previous day, selected model only. */
  async maybeDailySuggestions() {
    const today = utcDay(this.now());
    if (this.state.lastSuggestDay === today) return null;
    if ((this.now() - Date.parse(`${today}T00:00:00Z`)) < 5 * 60000) return null;
    this.state.lastSuggestDay = today;
    await this.save();
    return this.generateSuggestions(utcDay(this.now() - 86400000));
  }

  /** Approve: apply the change to the selected model's settings. Ignore: keep it in history only. */
  async decideSuggestion(id, approve) {
    const list = await this.suggestions();
    const x = list.find((y) => y.id === id);
    if (!x) throw new Error('Suggestion not found');
    if (x.status !== 'pending') throw new Error(`Already ${x.status}`);
    if (approve) {
      if ((this.state.settings.model || 'ifvg') !== x.model) throw new Error(`Switch to the ${MODELS[x.model]?.name || x.model} model first: this change belongs to it`);
      await this.updateSettings(x.patch);
    }
    x.status = approve ? 'approved' : 'ignored';
    x.decidedAt = new Date(this.now()).toISOString();
    await this.kv.set('suggestions', list);
    return x;
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
      } else if (await this.flattenUnknown()) persist = true; // exchange position the bot has no record of


      // 2. Multi-timeframe scan. A category whose daily limit is used up is not scanned.
      const before = await this.allTrades(); // daily limits count every symbol
      const swingLeft = tradesToday(before, this.now(), 'swing') < (s.maxSwingPerDay ?? 5);
      const scalpLeft = tradesToday(before, this.now(), 'scalp') < (s.maxScalpPerDay ?? 5);
      const model = s.model || 'ifvg';
      // Jev model: no pattern filter, Jev decides entries and manages trades by itself
      if (model === 'jev') {
        scanClass = await this.runJevOnly(entry, s, { swingLeft, scalpLeft });
        if (entry.confidence !== undefined || entry.executed) persist = true;
        return entry;
      }
      const scanSettings = { ...s, swingEnabled: s.swingEnabled !== false && swingLeft, scalpEnabled: s.scalpEnabled !== false && scalpLeft };
      const scan = isIfvg(model)
        ? await scanSetups(this.market, scanSettings, this.now(), { pairMarket: this.pairMarket, symbol: this.symbol })
        : await scanModel(model, this.market, scanSettings, this.now(), { pairMarket: this.pairMarket });
      let { setup } = scan;
      const { candles } = scan;
      const indicators = summarize(candles);
      // Liquidity: PDH/PDL, today's high/low, PWH/PWL, equal highs/lows, HTF swings, LRLR.
      const liquidity = scan.liquidity !== undefined ? scan.liquidity : await liquidityLevels(this.market, this.now()).catch(() => null);
      this.state.liquidity = liquidity && { above: liquidity.above.slice(0, 4), below: liquidity.below.slice(0, 4), lrlr: liquidity.lrlr, draw: liquidity.draw };
      let price = indicators.price;
      entry.price = price;
      // Clear path: no opposing 3m/5m/15m FVG between entry and the (fixed R:R) target.
      if (setup) {
        const sd = SIDE_FOR[setup.direction];
        // check the path from the live price (the order fills there, not at the last candle close)
        const livePx = Number(await this.market.getPrice?.().catch(() => null)) || price;
        const b0 = bracketFor(sd, livePx, this.stopZone(setup), { rr: s.riskReward ?? 1, minRiskPct: s.minStopPct ?? 0.15 });
        if (!b0) {
          scan.note = `${setup.category} ${setup.granularity / 60}m ${setup.direction} IFVG skipped: price ${fmtPx(livePx)} is on the wrong side of the IFVG, no valid stop`;
          scan.setup = null;
          setup = null;
        }
        price = livePx;
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
          const minR = s.minTargetR ?? 0.75; // smallest first target (strategy v2 proposes 1R)
          let tgt = (s.targetMode ?? 'rr') === 'liquidity' ? (liquidityTarget(liquidity, sd, price, b0.risk, { category: setup.category, minR })?.price ?? b0.target) : b0.target;
          // Mech: the target is the nearest opposing 5m / 15m FVG 0.75R-5R away (near edge, far edge when price is inside it)
          let mech = null;
          if (setup.entryModel === 'mech') {
            const far = sd === 'short' ? price - 5 * b0.risk : price + 5 * b0.risk;
            mech = pathBlockers(scan.zones || [], sd, price, far, ['5m', '15m']).map((z) => {
              const inside = z.bottom < price && z.top > price;
              const edge = sd === 'short' ? (inside ? z.bottom : z.top) : (inside ? z.top : z.bottom);
              return { z, inside, edge, r: Math.abs(price - edge) / b0.risk };
            }).filter((e) => (sd === 'short' ? e.edge < price : e.edge > price) && e.r >= minR)
              .sort((x, y) => Math.abs(x.edge - price) - Math.abs(y.edge - price))[0] || null;
            if (mech) tgt = mech.edge;
          }
          let htfBlock = pathBlockers(scan.zones || [], sd, price, tgt, ['30m', '1h', '2h', '4h']);
          // An opposing 30m-4h FVG in the way becomes the target: its near edge, or its far edge (gap fill) when
          // price is already inside it. The trade is skipped only if that target is closer than 0.75R.
          if (htfBlock.length) {
            const edges = htfBlock.map((z) => {
              const inside = z.bottom < price && z.top > price;
              const edge = sd === 'short' ? (inside ? z.bottom : z.top) : (inside ? z.top : z.bottom);
              return { z, inside, edge, r: Math.abs(price - edge) / b0.risk };
            }).filter((e) => (sd === 'short' ? e.edge < price : e.edge > price))
              .sort((x, y) => Math.abs(x.edge - price) - Math.abs(y.edge - price));
            const first = edges[0];
            if (first && first.r >= minR) {
              tgt = first.edge;
              setup.htfTarget = { price: first.edge, tf: first.z.tf, type: first.z.type, inside: first.inside };
              setup.qualityReasons = [...(setup.qualityReasons || []), `target ${first.z.tf} ${first.z.type} FVG ${first.inside ? 'far edge (gap fill)' : 'near edge'} ${fmtPx(first.edge)} (${first.r.toFixed(2)}R)`];
              htfBlock = [];
            } else if (first) {
              htfBlock = [{ ...first.z, tooClose: first.r }];
            }
          }
          if (setup.entryModel === 'mech') {
            if (!mech) htfBlock = [{ tf: '5m/15m', type: sd === 'short' ? 'bullish' : 'bearish', bottom: price, top: price, mechNone: true }];
            else if (!setup.htfTarget && !htfBlock.length) {
              setup.htfTarget = { price: mech.edge, tf: mech.z.tf, type: mech.z.type, inside: mech.inside };
              setup.qualityReasons = [...(setup.qualityReasons || []), `mech target ${mech.z.tf} ${mech.z.type} FVG ${mech.inside ? 'far edge (gap fill)' : 'near edge'} ${fmtPx(mech.edge)} (${mech.r.toFixed(2)}R)`];
            }
          }
          // Scalps (HTF FVG tapped -> IFVG on 1m-3m): an opposing 5m / 15m FVG in the way can be the target too
          // (near edge, or far edge when price is inside it), if it is at least 0.75R away.
          if (setup.category === 'scalp' && !setup.entryModel && !setup.htfTarget && !htfBlock.length) {
            const ltf = pathBlockers(scan.zones || [], sd, price, tgt, ['5m', '15m']).map((z) => {
              const inside = z.bottom < price && z.top > price;
              const edge = sd === 'short' ? (inside ? z.bottom : z.top) : (inside ? z.top : z.bottom);
              return { z, inside, edge, r: Math.abs(price - edge) / b0.risk };
            }).filter((e) => (sd === 'short' ? e.edge < price : e.edge > price) && e.r >= minR)
              .sort((x, y) => Math.abs(x.edge - price) - Math.abs(y.edge - price));
            if (ltf[0]) {
              const f = ltf[0];
              tgt = f.edge;
              setup.htfTarget = { price: f.edge, tf: f.z.tf, type: f.z.type, inside: f.inside };
              setup.qualityReasons = [...(setup.qualityReasons || []), `scalp target ${f.z.tf} ${f.z.type} FVG ${f.inside ? 'far edge (gap fill)' : 'near edge'} ${fmtPx(f.edge)} (${f.r.toFixed(2)}R)`];
            }
          }
          // v2 grade (log only): clear target = the nearest FVG / liquidity target at least 1R away
          if (setup.v2 && !setup.v2.error) {
            const rOf = (p) => Math.abs(p - price) / b0.risk;
            const clear = [setup.htfTarget && rOf(setup.htfTarget.price), liquidityTargets(liquidity, sd, price, b0.risk, { minR: 1, category: setup.category })[0]?.r]
              .filter((r) => r >= 1);
            const targetR = clear.length ? Number(Math.min(...clear).toFixed(2)) : null;
            const g2 = gradeV2({ ...setup.v2, targetR });
            setup.v2 = { ...setup.v2, targetR, killzone: killzoneOf(this.now()), grade: g2.grade, missing: g2.missing, ...(g2.smtLift && { smtLift: g2.smtLift }) };
          }
          // strategy v2 rules (section 3), each behind its own switch: grade caps now, skips after the checks below
          let v2Skip = null;
          if (V2_SWITCHES.some((k) => s[k])) {
            const rules = applyV2Rules(setup, s, { now: this.now(), opens: setup.v2?.opens, price });
            if (rules.notes.length) setup.qualityReasons = [...(setup.qualityReasons || []), ...rules.notes];
            setup.grade = rules.grade;
            v2Skip = rules.skip;
          }
          // and no recent long-wick rejection candle (15m and the entry timeframe) between entry and target
          const m15 = await this.market.getCandles(900, 120).catch(() => []);
          const wicks = [...wickBlockers(m15, sd, price, tgt, { lookback: 48 }), ...(scan.granularity !== 900 ? wickBlockers(scan.candles || [], sd, price, tgt, { lookback: 60 }) : [])];
          // exception: strong liquidity (equal lows for a short, equal highs for a long) at or before the target pulls price through the wick
          const eqType = sd === 'short' ? 'EQL' : 'EQH';
          const lvls = sd === 'short' ? liquidity?.below || [] : liquidity?.above || [];
          const eq = lvls.find((l) => l.type.split('+').includes(eqType) && (sd === 'short' ? l.price < price && l.price >= tgt * 0.9995 : l.price > price && l.price <= tgt * 1.0005));
          // LRLR in the trade direction with its stepped swings between entry and TP: a low-resistance run to the target
          const toward = sd === 'short' ? 'below' : 'above';
          const run = liquidity?.lrlr?.side === toward ? liquidity.lrlr.prices.filter((p) => (sd === 'short' ? p < price && p >= tgt * 0.9995 : p > price && p <= tgt * 1.0005)) : [];
          setup.lrlrToTp = run.length >= 2;
          if (setup.lrlrToTp) setup.qualityReasons = [...(setup.qualityReasons || []), `LRLR to TP (${run.length} stepped swings)`];
          if (wicks.length && !eq && setup.lrlrToTp) setup.qualityReasons.push('long wick in the path ignored: LRLR runs to TP');
          if (wicks.length && eq) setup.qualityReasons = [...(setup.qualityReasons || []), `long wick in the path ignored: ${eqType} ${fmtPx(eq.price)} draws price through it`];
          if (!htfBlock.length && wicks.length && !eq && !setup.lrlrToTp) {
            const w = wicks.sort((x, y) => y.time - x.time)[0];
            const hhmm2 = new Date(w.time).toISOString().slice(11, 16);
            scan.note = `${setup.category} ${setup.granularity / 60}m ${setup.direction} IFVG skipped: long-wick rejection candle at ${hhmm2} UTC (${fmtPx(w.wickFrom)}-${fmtPx(w.wickTo)}) between entry and TP ${fmtPx(tgt)}`;
            scan.setup = null;
            setup = null;
          }
          if (htfBlock.length && setup) {
            const z = htfBlock[0];
            scan.note = z.mechNone
              ? `mech ${setup.granularity / 60}m ${setup.direction} IFVG skipped: no opposing 5m / 15m FVG 0.75R-5R away to target`
              : `${setup.category} ${setup.granularity / 60}m ${setup.direction} IFVG skipped: ${z.tf} ${z.type} FVG ${fmtPx(z.bottom)}-${fmtPx(z.top)} in the way${z.tooClose != null ? `, only ${z.tooClose.toFixed(2)}R to it` : ` of TP ${fmtPx(tgt)}`}`;
            scan.setup = null;
            setup = null;
          }
          // a strategy v2 rule said no trade: keep the setup for the log (B setups are logged, not traded)
          if (v2Skip && setup) {
            scan.note = `${setup.category} ${setup.granularity / 60}m ${setup.direction} IFVG skipped (strategy v2): ${v2Skip}`;
            scan.v2Skipped = setup;
            scan.setup = null;
            setup = null;
          }
        }
      }
      if (isIfvg(model) && setup && !setup.htf && !setup.sweep && s.requireHtfTap !== false) {
        scan.note = `${setup.category} ${setup.granularity / 60}m: ${setup.qualityReasons.at(-1)}, not A+ and no FVG tap`;
        scan.setup = null;
        setup = null;
      }
      entry.setup = zoneSummary(scan.setup);
      // a setup a v2 rule skipped is logged once with the rule that skipped it
      if (scan.v2Skipped && !(this.state.askedIfvgs || []).includes(scan.v2Skipped.id)) {
        entry.v2Skipped = zoneSummary(scan.v2Skipped);
        this.rememberAsked(scan.v2Skipped.id);
        persist = true;
      }
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
      // IFVG (no Jev): no timed reviews, trades run to stop / target (an opposite IFVG still closes them)
      const review = Boolean(open && !opposite && !strictExit && model !== 'ifvg_nojev' && reviewDue(open, this.now()));

      // strategy v2 limit entry waiting on this symbol: fill it when price trades back to the limit, cancel after 3 candles
      let pendingNote = null;
      if (this.state.pendingEntry && open) delete this.state.pendingEntry;
      else if (this.state.pendingEntry) {
        const pr = await this.checkPendingEntry(this.state.pendingEntry, { candles, liquidity, zones: scan.zones || [], openAll });
        if (pr.done) {
          persist = true;
          Object.assign(entry, { action: pr.trade ? ENTRY_ACTION[pr.side] : 'HOLD', note: pr.note, executed: Boolean(pr.trade), source: 'rules' });
          if (pr.trade) Object.assign(entry, { tradeId: pr.trade.id, order: pr.order, label: pr.side === 'short' ? 'SHORT' : 'LONG' });
          return entry;
        }
        pendingNote = pr.note;
      }

      let reason = null; // why the AI is not consulted / an entry can't be taken
      if (pendingNote) reason = pendingNote;
      else if (open && !opposite && !review) reason = `Managing open trade (bracket active, next review ${nextReviewLabel(open)})`;
      else if (!open && count >= s.maxTradesPerDay) reason = `Daily limit reached (${count}/${s.maxTradesPerDay})`;
      else if (!open && !swingLeft && !scalpLeft) reason = `Daily swing (${s.maxSwingPerDay ?? 5}) and scalp (${s.maxScalpPerDay ?? 5}) limits reached`;
      else if (!open && !setup) reason = `${!swingLeft ? 'Swing limit reached · ' : ''}${!scalpLeft ? 'Scalp limit reached · ' : ''}${scan.note ? `No setup · ${scan.note}` : 'No fresh IFVG setup'}`;
      else if (!open && s.sessionFilter && !inSession(this.now())) reason = `${setup.category} ${setup.granularity / 60}m ${setup.direction} IFVG outside the London / New York session`;
      // open-trade cap: keep scanning, only the entry waits for a free slot
      else if (!open && openAll >= (s.maxOpenTrades ?? 2)) reason = `${setup.category} ${setup.granularity / 60}m ${setup.direction} IFVG found · waiting for a free slot (max ${s.maxOpenTrades ?? 2} trades at a time)`;
      // strategy v2 portfolio filters (3.7), each off by default
      else if (!open && s.corrCap && corrCapHit(everything, this.symbol, want)) reason = `${setup.category} ${setup.granularity / 60}m ${setup.direction} IFVG found · correlation cap: ${corrCapHit(everything, this.symbol, want)} ${want} trades already open in the ${/^XA[UG]/.test(this.symbol) ? 'metals' : 'crypto'} cluster (max 2)`;
      else if (!open && s.dailyStopR > 0 && dailyR(everything, this.now()) <= -s.dailyStopR) reason = `Daily loss stop: ${dailyR(everything, this.now())}R closed today (stop at -${s.dailyStopR}R), no new entries until 00:00 UTC`;
      else if (!open && s.lossCooldown && cooldownUntil(everything, this.symbol, this.now())) reason = `${this.symbol} cooldown after 2 losses in a row, until ${new Date(cooldownUntil(everything, this.symbol, this.now())).toISOString().slice(11, 16)} UTC`;
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
          if (tb) targets = liquidityTargets(liquidity, want, price, tb.risk, { category: setup.category });
        }
        const decision = model === 'ifvg_nojev' ? rulesDecision({ want, open, opposite, s }) : await decide(
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
            model,
            trackRecord: this.learned(everything, model),
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
            entry.note = `Jev review: keep ${open.side || 'long'} open (${decision.action}${confident ? '' : ', low confidence'}) · next review ${nextReviewLabel(open)}`;
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
          else if (s.limitEntry && this.limitFor(want, price, setup)) {
            // strategy v2 limit entry: the inversion candle closed far from the IFVG edge, wait for price to come back
            const lim = this.limitFor(want, price, setup);
            const g = setup.granularity || 300;
            this.state.pendingEntry = { side: want, limit: lim, setup, decision, createdAt: this.now(), expiresAt: this.now() + 3 * g * 1000 };
            entry.note = `Limit ${want} at ${fmtPx(lim)} (IFVG edge) for 3 ${g / 60}m candles: price ${fmtPx(price)} closed more than 40% of the stop distance away`;
            entry.label = 'LIMIT';
          } else {
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
      // Jev shadow (strategy v2, 5.1): on the no-Jev model Jev grades each new setup once, after any order is placed.
      // Logged only: the answer never opens, sizes or closes a trade.
      const shadowOf = setup || scan.v2Skipped; // B setups a v2 rule skipped are graded too (5.1)
      if (shadowOf && model === 'ifvg_nojev' && s.jevShadow === true) {
        const sh = await this.shadowJev(shadowOf, { liquidity, candles: scan.candles || candles, granularity: scan.granularity }).catch(() => null);
        if (sh) { entry.jevShadow = { verdict: sh.verdict ?? null, total: sh.total ?? null, error: sh.error ?? null }; persist = true; }
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
