import path from 'node:path';
import { decide } from './ai.js';
import { summarize } from './indicators.js';
import { JsonStore } from './store.js';

const MIN_ORDER_USD = 10;

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
    const pct = Math.min(sizePct || settings.maxTradePct, settings.maxTradePct);
    const positionValue = account.btc * account.price;
    const room = (settings.maxPositionPct / 100) * account.equity - positionValue;
    const notional = Math.min((pct / 100) * account.equity, room, account.cash * 0.995);
    if (notional < MIN_ORDER_USD) return { order: null, note: 'BUY skipped: position limit reached or not enough cash' };
    return { order: { side: 'buy', notional: Number(notional.toFixed(2)) }, note: `BUY $${notional.toFixed(2)}` };
  }
  // SELL
  const pct = sizePct > 0 ? sizePct : 100;
  const qty = account.btc * (pct / 100);
  if (qty * account.price < MIN_ORDER_USD) return { order: null, note: 'SELL skipped: no meaningful BTC position' };
  return { order: { side: 'sell', qty: Number(qty.toFixed(8)) }, note: `SELL ${qty.toFixed(8)} BTC (${pct}%)` };
}

export class TradingBot {
  constructor({ broker, market, ai, settings, dataDir, fetchImpl = fetch }) {
    this.broker = broker;
    this.market = market;
    this.ai = ai;
    this.settings = { ...settings };
    this.fetch = fetchImpl;
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.lastRun = null;
    this.lastError = null;
    this.log = new JsonStore(path.join(dataDir, 'decisions.json'), []);
  }

  status() {
    return {
      running: this.running,
      busy: this.busy,
      lastRun: this.lastRun,
      nextRun: this.running && this.lastRun
        ? new Date(new Date(this.lastRun).getTime() + this.settings.intervalMinutes * 60000).toISOString()
        : null,
      lastError: this.lastError,
      settings: this.settings,
      ai: this.ai.apiKey ? `${this.ai.provider}:${this.ai.model === 'auto' ? 'free models' : this.ai.model}` : 'rules (no AI key set)',
      broker: this.broker.name,
    };
  }

  decisions(limit = 100) {
    return this.log.read().slice(0, limit);
  }

  updateSettings(patch) {
    const allowed = ['intervalMinutes', 'minConfidence', 'maxPositionPct', 'maxTradePct', 'granularity'];
    for (const k of allowed) {
      if (patch[k] !== undefined && !Number.isNaN(Number(patch[k]))) this.settings[k] = Number(patch[k]);
    }
    this.settings.intervalMinutes = Math.max(1, this.settings.intervalMinutes);
    this.settings.minConfidence = Math.min(1, Math.max(0, this.settings.minConfidence));
    this.settings.maxPositionPct = Math.min(100, Math.max(0, this.settings.maxPositionPct));
    this.settings.maxTradePct = Math.min(100, Math.max(0, this.settings.maxTradePct));
    if (this.running) { this.stop(); this.start(); }
    return this.settings;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.runOnce().catch(() => {});
    this.timer = setInterval(() => this.runOnce().catch(() => {}), this.settings.intervalMinutes * 60000);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce() {
    if (this.busy) throw new Error('Bot is already running a cycle');
    this.busy = true;
    const entry = { time: new Date().toISOString() };
    try {
      const candles = await this.market.getCandles(this.settings.granularity, 200);
      const indicators = summarize(candles);
      const account = await this.broker.getAccount(indicators.price);
      const decision = await decide(
        {
          indicators,
          account,
          recentCandles: candles.slice(-24),
          granularity: this.settings.granularity,
          recentDecisions: this.decisions(5),
        },
        this.ai,
        this.fetch,
      );
      const plan = planTrade(decision, account, this.settings);
      Object.assign(entry, {
        price: indicators.price,
        action: decision.action,
        confidence: decision.confidence,
        sizePct: decision.sizePct,
        reasoning: decision.reasoning,
        source: decision.source,
        aiError: decision.error,
        indicators,
        note: plan.note,
        executed: false,
      });
      if (plan.order) {
        try {
          const order = await this.broker.placeOrder({ ...plan.order, price: indicators.price, source: 'ai' });
          entry.executed = true;
          entry.order = order;
        } catch (err) {
          entry.note = `Order failed: ${err.message}`;
        }
      }
      this.lastError = decision.error || null;
    } catch (err) {
      Object.assign(entry, { action: 'ERROR', note: err.message, executed: false });
      this.lastError = err.message;
    } finally {
      this.busy = false;
      this.lastRun = entry.time;
      const all = this.log.read();
      all.unshift(entry);
      this.log.write(all.slice(0, 1000));
    }
    return entry;
  }
}
