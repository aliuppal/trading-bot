import { decide } from './ai.js';
import { summarize } from './indicators.js';
import { latestSetup, bracketFor } from './ifvg.js';
import { renderTradeSvg } from './snapshot.js';

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

const utcDay = (t) => new Date(t).toISOString().slice(0, 10);

/** Number of trades opened on the same UTC day as `now`. */
export function tradesToday(trades, now = Date.now()) {
  const day = utcDay(now);
  return trades.filter((t) => utcDay(t.entryTime) === day).length;
}

/**
 * Has a bracket been hit? Looks at candles that opened after the entry, then the live price.
 * If one candle touches both levels the stop is assumed first (conservative).
 * Returns { exitPrice, reason: 'stop' | 'target' } or null.
 */
export function checkBracket(trade, candles, price) {
  const short = trade.side === 'short';
  const stopHit = (lo, hi) => (short ? hi >= trade.stop : lo <= trade.stop);
  const targetHit = (lo, hi) => (short ? lo <= trade.target : hi >= trade.target);
  const entryT = new Date(trade.entryTime).getTime();
  for (const c of candles) {
    if (c.time <= entryT) continue;
    if (stopHit(c.low, c.high)) return { exitPrice: trade.stop, reason: 'stop' };
    if (targetHit(c.low, c.high)) return { exitPrice: trade.target, reason: 'target' };
  }
  if (stopHit(price, price)) return { exitPrice: trade.stop, reason: 'stop' };
  if (targetHit(price, price)) return { exitPrice: trade.target, reason: 'target' };
  return null;
}

const SIDE_FOR = { bullish: 'long', bearish: 'short' };
const ENTRY_ACTION = { long: 'BUY', short: 'SELL' };
const EXIT_ACTION = { long: 'SELL', short: 'BUY' };

const zoneSummary = (z) => z && {
  id: z.id, direction: z.direction, top: Number(z.top.toFixed(2)), bottom: Number(z.bottom.toFixed(2)),
  formedAt: z.formedAt, invertedAt: z.invertedAt, ageCandles: z.ageCandles,
};

export class TradingBot {
  /**
   * kv: async key/value store (see store.js). settings: interval / risk / daily-limit settings.
   * autoStart: whether the bot is enabled the first time (saved state wins afterwards).
   */
  constructor({ broker, market, ai, settings, kv, autoStart = true, fetchImpl = fetch, now = () => Date.now() }) {
    this.broker = broker;
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

  /** Reload persisted state (needed per request on serverless, where instances don't share memory). */
  async load() {
    const saved = await this.kv.get('bot', null);
    if (saved) this.state = { ...this.state, ...saved, settings: { ...this.defaults, ...saved.settings } };
    return this.state;
  }

  async save() {
    await this.kv.set('bot', this.state);
  }

  async status() {
    const trades = await this.trades();
    const s = this.state;
    return {
      running: s.running,
      busy: this.busy,
      lastRun: s.lastRun,
      lastScan: s.lastScan,
      nextRun: s.running && s.lastRun
        ? new Date(new Date(s.lastRun).getTime() + s.settings.intervalMinutes * 60000).toISOString()
        : null,
      lastError: s.lastError,
      settings: s.settings,
      tradesToday: tradesToday(trades, this.now()),
      openTrade: trades.find((t) => t.status === 'open') || null,
      ai: this.ai.apiKey ? `${this.ai.provider}:${this.ai.model === 'auto' ? 'free models' : this.ai.model}` : 'rules (no AI key set)',
      broker: this.broker.name,
      storage: this.kv.name,
    };
  }

  async decisions(limit = 100) {
    return (await this.kv.get('decisions', [])).slice(0, limit);
  }

  async trades(limit = MAX_TRADES_KEPT) {
    return (await this.kv.get('trades', [])).slice(0, limit);
  }

  shots(id) {
    return this.kv.get(`shot_${id}`, {});
  }

  async updateSettings(patch) {
    const allowed = ['intervalMinutes', 'minConfidence', 'maxPositionPct', 'maxTradePct', 'granularity', 'maxTradesPerDay'];
    const s = this.state.settings;
    for (const k of allowed) {
      if (patch[k] !== undefined && patch[k] !== '' && !Number.isNaN(Number(patch[k]))) s[k] = Number(patch[k]);
    }
    s.intervalMinutes = Math.max(1, s.intervalMinutes);
    s.minConfidence = Math.min(1, Math.max(0, s.minConfidence));
    s.maxPositionPct = Math.min(100, Math.max(0, s.maxPositionPct));
    s.maxTradePct = Math.min(100, Math.max(0, s.maxTradePct));
    s.maxTradesPerDay = Math.min(10, Math.max(0, Math.round(s.maxTradesPerDay)));
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
  async tick() {
    await this.load();
    const due = !this.state.lastRun
      || this.now() - new Date(this.state.lastRun).getTime() >= this.state.settings.intervalMinutes * 60000 - 5000;
    if (this.state.running && due) return this.runOnce();
    const open = (await this.trades()).find((t) => t.status === 'open');
    if (!open) return null;
    const candles = await this.market.getCandles(this.state.settings.granularity, 200);
    const closed = await this.manageOpen(candles, candles.at(-1).close);
    return closed && { closed };
  }

  /** Close the open trade if its stop or target was hit. Returns the closed trade or null. */
  async manageOpen(candles, price) {
    const open = (await this.trades()).find((t) => t.status === 'open');
    if (!open) return null;
    const hit = checkBracket(open, candles, price);
    if (!hit) return null;
    return this.closeTrade(open, hit.exitPrice, hit.reason, candles);
  }

  async closeTrade(trade, exitPrice, reason, candles) {
    const nowIso = new Date(this.now()).toISOString();
    const short = trade.side === 'short';
    const account = await this.broker.getAccount(exitPrice);
    const qty = Math.min(trade.qty, short ? account.shortBtc || 0 : account.btc);
    let order = null;
    let note = '';
    if (qty * exitPrice >= 1) {
      order = short
        ? await this.broker.coverShort({ qty, price: exitPrice, source: 'ai', reason })
        : await this.broker.placeOrder({ side: 'sell', qty, price: exitPrice, source: 'ai', reason });
    } else {
      note = 'Position was already closed manually';
    }
    const part = qty / trade.qty;
    const fee = order?.fee ?? 0;
    let pnl = 0;
    if (order) {
      pnl = short
        ? trade.notional * part - (trade.entryFee || 0) * part - exitPrice * qty - fee // proceeds - entry fee - buyback
        : exitPrice * qty - fee - trade.notional * part; // long notional already includes the entry fee
    }
    const dir = short ? -1 : 1;
    Object.assign(trade, {
      status: reason === 'target' ? 'win' : reason === 'stop' ? 'loss' : pnl >= 0 ? 'win' : 'loss',
      exitTime: nowIso,
      exitPrice,
      exitReason: reason,
      pnl: Number(pnl.toFixed(2)),
      r: Number(((dir * (exitPrice - trade.entryPrice)) / Math.abs(trade.entryPrice - trade.stop)).toFixed(2)),
      ...(note && { note }),
    });
    const trades = await this.trades();
    const i = trades.findIndex((t) => t.id === trade.id);
    if (i >= 0) trades[i] = trade;
    await this.kv.set('trades', trades);
    const shots = await this.shots(trade.id);
    shots.exit = renderTradeSvg({ candles, trade, phase: 'exit', granularity: this.state.settings.granularity });
    await this.kv.set(`shot_${trade.id}`, shots);
    await this.log({
      time: nowIso, price: exitPrice, action: EXIT_ACTION[trade.side || 'long'], source: 'bracket', executed: Boolean(order), tradeId: trade.id,
      note: `${reason === 'target' ? 'Target hit (+1R)' : reason === 'stop' ? 'Stop hit (-1R)' : 'Closed on signal'} · P&L ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl}`,
    });
    return trade;
  }

  async openTrade({ side, setup, decision, account, price, candles }) {
    const label = side === 'short' ? 'SHORT' : 'BUY';
    if (!bracketFor(side, price, setup)) return { note: `${label} skipped: price is on the wrong side of the IFVG, no valid stop` };
    const size = entryNotional(decision.sizePct, account, this.state.settings);
    if (!size) return { note: `${label} skipped: position limit reached or not enough cash` };
    const order = side === 'short'
      ? await this.broker.openShort({ notional: size, price, source: 'ai' })
      : await this.broker.placeOrder({ side: 'buy', notional: size, price, source: 'ai' });
    const entryPrice = Number(order.price ?? price);
    const notional = Number(order.notional ?? size);
    const qty = Number(order.qty) || (notional * 0.999) / entryPrice;
    const b = bracketFor(side, entryPrice, setup) || bracketFor(side, price, setup);
    const plan = { note: `${label} $${notional.toFixed(2)}` };
    const trade = {
      id: `T${this.now()}`,
      status: 'open',
      side,
      entryTime: new Date(this.now()).toISOString(),
      entryPrice,
      qty,
      notional,
      entryFee: order.fee || 0,
      stop: b.stop,
      target: b.target,
      risk: b.risk,
      ifvg: zoneSummary(setup),
      confidence: decision.confidence,
      source: decision.source,
      reasoning: decision.reasoning,
      orderId: order.id,
    };
    let trades = await this.trades();
    trades.unshift(trade);
    const dropped = trades.slice(MAX_TRADES_KEPT);
    trades = trades.slice(0, MAX_TRADES_KEPT);
    await this.kv.set('trades', trades);
    await Promise.all(dropped.map((t) => this.kv.del(`shot_${t.id}`)));
    await this.kv.set(`shot_${trade.id}`, {
      entry: renderTradeSvg({ candles, trade, phase: 'entry', granularity: this.state.settings.granularity }),
    });
    return { trade, order, note: `${plan.note} · SL ${b.stop} · TP ${b.target} (1:1)` };
  }

  async log(entry) {
    const all = await this.kv.get('decisions', []);
    all.unshift(entry);
    await this.kv.set('decisions', all.slice(0, MAX_DECISIONS_KEPT));
  }

  rememberAsked(id) {
    this.state.askedIfvgs = [id, ...(this.state.askedIfvgs || []).filter((x) => x !== id)].slice(0, 50);
  }

  /**
   * One full cycle: enforce brackets, look for a fresh IFVG, ask the AI about it and execute what it decides.
   * manual: true when the user clicked "Ask AI now" (always asks the AI and always logs).
   */
  async runOnce({ manual = false } = {}) {
    if (this.busy) throw new Error('Bot is already running a cycle');
    this.busy = true;
    const entry = { time: new Date(this.now()).toISOString() };
    let persist = manual;
    try {
      const s = this.state.settings;
      const candles = await this.market.getCandles(s.granularity, 200);
      const indicators = summarize(candles);
      const price = indicators.price;
      const closed = await this.manageOpen(candles, price);
      if (closed) persist = true;

      const setup = latestSetup(candles);
      entry.price = price;
      entry.setup = zoneSummary(setup);
      const trades = await this.trades();
      const open = trades.find((t) => t.status === 'open');
      const count = tradesToday(trades, this.now());
      const asked = setup && ((this.state.askedIfvgs || []).includes(setup.id) || trades.some((t) => t.ifvg?.id === setup.id));

      const want = setup ? SIDE_FOR[setup.direction] : null; // trade direction the setup offers
      const canShort = typeof this.broker.openShort === 'function';
      // An opposite IFVG while a trade is open is a chance to close it early.
      const opposite = Boolean(open && want && want !== (open.side || 'long'));

      let reason = null; // why the AI is not consulted / an entry can't be taken
      if (open && !opposite) reason = 'Managing open trade (bracket active)';
      else if (!open && count >= s.maxTradesPerDay) reason = `Daily limit reached (${count}/${s.maxTradesPerDay})`;
      else if (!setup) reason = 'No fresh IFVG setup';
      else if (!open && want === 'short' && !canShort) reason = 'Bearish IFVG: this broker cannot short BTC (use BROKER=local)';
      else if (asked) reason = 'Already evaluated this IFVG';

      this.state.lastScan = { time: entry.time, setup: entry.setup, note: reason || 'Asked AI' };

      if (reason && !manual) {
        Object.assign(entry, { action: 'HOLD', note: reason, executed: false, source: 'ifvg' });
      } else {
        const account = await this.broker.getAccount(price);
        const decision = await decide(
          {
            indicators,
            account,
            recentCandles: candles.slice(-24),
            granularity: s.granularity,
            recentDecisions: await this.decisions(5),
            ifvg: entry.setup,
            tradesToday: count,
            maxTradesPerDay: s.maxTradesPerDay,
            openTrade: open && { side: open.side || 'long', entryPrice: open.entryPrice, stop: open.stop, target: open.target },
          },
          this.ai,
          this.fetch,
        );
        persist = true;
        if (setup) this.rememberAsked(setup.id);
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

        if (opposite && !reason && confident && decision.action === EXIT_ACTION[open.side || 'long']) {
          const t = await this.closeTrade(open, price, 'signal', candles);
          entry.executed = true;
          entry.tradeId = t.id;
          entry.note = `Closed ${open.side || 'long'} on ${setup.direction} IFVG · P&L ${t.pnl >= 0 ? '+' : ''}$${t.pnl}`;
        } else if (!open && want && decision.action === ENTRY_ACTION[want]) {
          if (reason) entry.note = `${decision.action} not taken: ${reason}`;
          else if (!confident) entry.note = `Confidence ${decision.confidence} below minimum ${s.minConfidence}`;
          else {
            const res = await this.openTrade({ side: want, setup, decision, account, price, candles });
            entry.note = res.note;
            if (res.trade) { entry.executed = true; entry.tradeId = res.trade.id; entry.order = res.order; }
          }
        } else if (decision.action === 'HOLD') {
          entry.note = reason ? `HOLD · ${reason}` : 'HOLD';
        } else {
          entry.note = reason
            ? `${decision.action} not taken: ${reason}`
            : `${decision.action} does not match the ${setup?.direction || 'missing'} IFVG setup`;
        }
      }
    } catch (err) {
      Object.assign(entry, { action: 'ERROR', note: err.message, executed: false });
      this.state.lastError = err.message;
      persist = true;
    } finally {
      this.busy = false;
      this.state.lastRun = entry.time;
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
