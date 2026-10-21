// Binance USDⓈ-M futures demo account (BTCUSDT perpetual): real order engine, demo money, longs AND shorts.
// Default endpoint is Binance Demo Trading (https://demo-fapi.binance.com); the older futures testnet
// (https://testnet.binancefuture.com) works too. Orders are one-way mode, market, at BINANCE_LEVERAGE (default 1x).
import crypto from 'node:crypto';

const ACTION_SIDE = { buy: 'BUY', sell: 'SELL', short: 'SELL', cover: 'BUY' };
const TAKER_FEE = 0.0004; // estimate for display; Binance charges the real fee on the demo account

export class BinanceFuturesBroker {
  constructor({ key, secret, baseUrl = 'https://demo-fapi.binance.com', symbol = 'BTCUSDT', leverage = 1, getPrice }, fetchImpl = fetch) {
    if (!key || !secret) throw new Error('BINANCE_API_KEY and BINANCE_API_SECRET are required for BROKER=binance');
    if (!/demo|testnet/.test(baseUrl)) throw new Error('Refusing to use a non-demo Binance URL');
    this.name = 'binance';
    this.key = key;
    this.secret = secret;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.symbol = symbol;
    this.leverage = leverage;
    this.getPrice = getPrice;
    this.fetch = fetchImpl;
    this.step = 0.0001;
    this.ready = null;
    this.supportsLeverage = true;
    this.currentLeverage = null;
  }

  async req(method, path, params = {}, signed = true) {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    if (signed) {
      q.set('timestamp', String(Date.now()));
      q.set('recvWindow', '10000');
      q.set('signature', crypto.createHmac('sha256', this.secret).update(q.toString()).digest('hex'));
    }
    const res = await this.fetch(`${this.baseUrl}${path}?${q}`, { method, headers: { 'X-MBX-APIKEY': this.key } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.code && data.code < 0)) {
      const err = new Error(`Binance ${method} ${path} -> ${res.status}: ${data.msg || JSON.stringify(data).slice(0, 200)}`);
      err.code = data.code;
      throw err;
    }
    return data;
  }

  /** One-time setup: quantity step from exchangeInfo and the leverage for the symbol. */
  init() {
    this.ready ??= (async () => {
      try {
        const info = await this.req('GET', '/fapi/v1/exchangeInfo', {}, false);
        const filters = info.symbols?.find((s) => s.symbol === this.symbol)?.filters || [];
        const lot = filters.find((f) => f.filterType === 'MARKET_LOT_SIZE');
        if (lot) this.step = Number(lot.stepSize);
        const pf = filters.find((f) => f.filterType === 'PRICE_FILTER');
        if (pf) this.tick = Number(pf.tickSize);
      } catch { /* keep the default step */ }
      await this.setLeverage(this.leverage).catch(() => {});
    })();
    return this.ready;
  }

  /** Set the symbol's leverage (only calls Binance when it changes). */
  async setLeverage(leverage) {
    const lev = Math.max(1, Math.round(leverage || 1));
    if (lev === this.currentLeverage) return lev;
    // each symbol has its own maximum (BTC 125x, most alts 50-75x): step down until Binance accepts
    for (const l of [lev, ...[100, 75, 50, 25, 20, 10, 5, 3, 2, 1].filter((x) => x < lev)]) {
      try {
        await this.req('POST', '/fapi/v1/leverage', { symbol: this.symbol, leverage: l });
        this.currentLeverage = l;
        return l;
      } catch (e) { if (l === 1) throw e; }
    }
    return this.currentLeverage;
  }

  /** Price rounded to the symbol's tick size (e.g. 0.1 BTC, 0.0001 XRP), as a string. */
  fmtPrice(p) {
    const tick = this.tick || 0.1;
    const decimals = Math.max(0, -Math.floor(Math.log10(tick) + 1e-9));
    return (Math.round(Number(p) / tick) * tick).toFixed(decimals);
  }

  roundQty(q) {
    const decimals = Math.max(0, -Math.floor(Math.log10(this.step)));
    return Number((Math.floor(q / this.step + 1e-9) * this.step).toFixed(decimals));
  }

  async getAccount(price) {
    await this.init();
    const [acct, positions] = await Promise.all([
      this.req('GET', '/fapi/v2/account'),
      this.req('GET', '/fapi/v2/positionRisk', { symbol: this.symbol }),
    ]);
    const pos = positions.find((x) => x.symbol === this.symbol) || {};
    const amt = Number(pos.positionAmt || 0);
    const p = price ?? (Number(pos.markPrice) || (await this.getPrice()));
    // Balances in the contract's margin asset (USDT for BTCUSDT, USDC for BTCUSDC).
    const marginAsset = this.symbol.endsWith('USDC') ? 'USDC' : 'USDT';
    const asset = (acct.assets || []).find((x) => x.asset === marginAsset);
    const equity = Number(asset ? asset.marginBalance : acct.totalMarginBalance);
    const cash = Number(asset ? asset.availableBalance : acct.availableBalance);
    return {
      broker: this.name,
      marginAsset,
      cash,
      btc: amt > 0 ? amt : 0,
      avgEntry: amt > 0 ? Number(pos.entryPrice) : 0,
      shortBtc: amt < 0 ? -amt : 0,
      shortEntry: amt < 0 ? Number(pos.entryPrice) : 0,
      price: p,
      equity,
      accountEquity: equity,
      startingCash: null,
    };
  }

  /** Leverage tiers of the symbol, highest leverage first: [{ lev, cap }] (cap = max position value at that leverage). Cached 1h. */
  async brackets() {
    if (this.bracketCache && Date.now() - this.bracketCache.at < 3600000) return this.bracketCache.list;
    const data = await this.req('GET', '/fapi/v1/leverageBracket', { symbol: this.symbol });
    const row = (Array.isArray(data) ? data : [data]).find((x) => x.symbol === this.symbol) || data[0] || data;
    const list = (row?.brackets || []).map((b) => ({ lev: Number(b.initialLeverage), cap: Number(b.notionalCap) })).sort((a, b) => b.lev - a.lev);
    this.bracketCache = { at: Date.now(), list };
    return list;
  }

  /**
   * Binance -2027 ("maximum allowable position at current leverage"): each leverage tier caps the position value.
   * Pick the highest leverage whose cap holds the full position and whose margin fits the available balance; if none
   * does, the largest position any tier allows. Returns { lev, qty, capped }.
   */
  async fitToBrackets(qty, price) {
    const tiers = await this.brackets();
    const cash = (await this.getAccount(price).catch(() => null))?.cash ?? Infinity;
    const want = qty * price;
    const usable = cash * 0.95;
    const full = tiers.find((t) => t.cap >= want && want / t.lev <= usable);
    if (full) return { lev: full.lev, qty, capped: false };
    // the most any tier allows: limited by its cap and by the margin it needs
    const best = tiers.map((t) => ({ lev: t.lev, value: Math.min(t.cap * 0.98, usable * t.lev) })).sort((a, b) => b.value - a.value)[0];
    if (!best || !(best.value > 0)) throw new Error('No Binance leverage tier fits this position');
    return { lev: best.lev, qty: Math.min(qty, best.value / price), capped: true };
  }

  /** action: buy | sell | short | cover. Closing orders (sell a long, cover a short) are reduce-only. */
  async order(action, qty, source = 'manual', reason, leverage) {
    await this.init();
    if (leverage) await this.setLeverage(leverage);
    let quantity = this.roundQty(qty);
    if (!(quantity > 0)) throw new Error(`Order too small (min ${this.step} BTC, $50)`);
    const closing = action === 'sell' || action === 'cover';
    const send = (q) => this.req('POST', '/fapi/v1/order', {
      symbol: this.symbol,
      side: ACTION_SIDE[action],
      type: 'MARKET',
      quantity: q,
      reduceOnly: closing ? 'true' : undefined,
      newClientOrderId: `${source}-${action}-${Date.now()}`,
      newOrderRespType: 'RESULT',
    });
    let o;
    let limitNote = null;
    try {
      o = await send(quantity);
    } catch (err) {
      if (closing && (err.code === -2022 || /reduce ?only/i.test(err.message))) {
        // A close is ALWAYS reduce-only, so it can never open or flip a position. Binance rejects it while one of the
        // symbol's stop / take-profit orders is holding (triggering on) the position: cancel those, then retry
        // reduce-only for whatever is still open in this direction. Nothing left = the exchange already closed it.
        await this.cancelAllAlgos();
        const amt = await this.positionAmt();
        const reduces = ACTION_SIDE[action] === 'BUY' ? amt < 0 : amt > 0;
        if (!reduces) throw Object.assign(new Error('Position already closed on the exchange'), { code: 'ALREADY_FLAT' });
        const q2 = this.roundQty(Math.min(quantity, Math.abs(amt)));
        if (!(q2 > 0)) throw Object.assign(new Error('Position already closed on the exchange'), { code: 'ALREADY_FLAT' });
        try {
          o = await send(q2);
        } catch (e2) {
          throw new Error(`${e2.message} (after cancelling the symbol's orders: ${await this.openOrdersSummary()})`);
        }
        limitNote = 'retried after cancelling the exchange stop / take-profit that held the position';
        quantity = q2;
      } else {
        // too large for the current leverage tier: move to a tier that holds it (or shrink to the most allowed), retry once
        if (closing || err.code !== -2027) throw err;
        const px = await this.getPrice();
        const fit = await this.fitToBrackets(quantity, px);
        this.currentLeverage = null;
        await this.setLeverage(fit.lev);
        const q2 = this.roundQty(fit.qty);
        if (!(q2 > 0)) throw err;
        o = await send(q2);
        limitNote = fit.capped
          ? `size cut to ${q2} (${(q2 / quantity * 100).toFixed(0)}%) to fit Binance's limit at ${this.currentLeverage}x`
          : `leverage moved to ${this.currentLeverage}x to fit Binance's position limit`;
        quantity = q2;
      }
    }
    // The actual fills (price, fee, realized P&L) from Binance's own trade records.
    const fills = await this.fills(o.orderId);
    const filled = fills ? fills.qty : Number(o.executedQty) || quantity;
    const notional = fills ? fills.quote : Number(o.cumQuote) || null;
    const avg = fills ? fills.price : Number(o.avgPrice) || (notional ? notional / filled : null);
    return {
      id: String(o.orderId),
      time: new Date(o.updateTime || Date.now()).toISOString(),
      side: action,
      qty: filled,
      price: avg,
      notional,
      fee: fills ? fills.commission : notional ? notional * TAKER_FEE : 0,
      ...(fills && { realizedPnl: fills.realizedPnl, actualFill: true }),
      status: String(o.status || 'NEW').toLowerCase(),
      source,
      ...(reason && { reason }),
      ...((leverage || limitNote) && { leverage: this.currentLeverage || leverage }),
      ...(limitNote && { limitNote }),
    };
  }

  /**
   * Fills of one order from GET /fapi/v1/userTrades: average price, qty, quote value, commission and Binance's
   * realized P&L (non-zero on closing orders). Retries briefly because fills can take a moment to appear.
   */
  async fills(orderId) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const rows = await this.req('GET', '/fapi/v1/userTrades', { symbol: this.symbol, orderId });
        if (rows.length) {
          const qty = rows.reduce((a, r) => a + Number(r.qty), 0);
          const quote = rows.reduce((a, r) => a + Number(r.quoteQty), 0);
          return {
            qty: Number(qty.toFixed(8)),
            quote: Number(quote.toFixed(4)),
            price: Number((quote / qty).toPrecision(10)), // exact average fill (XRP / LINK need more than 2 decimals)
            commission: Number(rows.reduce((a, r) => a + Number(r.commission), 0).toFixed(6)),
            realizedPnl: Number(rows.reduce((a, r) => a + Number(r.realizedPnl), 0).toFixed(6)),
          };
        }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
    return null;
  }

  /**
   * Every fill that closed a position opened at `sinceMs` (side BUY closes a short, SELL a long), in time order, up to
   * `qty`: the exchange stop / take-profit, partial and trim fills, the bot's or a manual close. Returns
   * { qty, quote, price, commission, realizedPnl, lastTime } or null when nothing closed it yet.
   */
  async closingFills({ sinceMs, side, qty, excludeOrderId }) {
    const rows = await this.req('GET', '/fapi/v1/userTrades', { symbol: this.symbol, startTime: Math.max(0, Math.floor(sinceMs) - 1000), limit: 1000 });
    const out = { qty: 0, quote: 0, commission: 0, realizedPnl: 0, lastTime: null };
    for (const r of rows.filter((x) => x.side === side && String(x.orderId) !== String(excludeOrderId)).sort((a, b) => a.time - b.time)) {
      if (out.qty >= qty - 1e-9) break;
      const take = Math.min(Number(r.qty), qty - out.qty);
      const f = take / Number(r.qty);
      out.qty += take;
      out.quote += Number(r.quoteQty) * f;
      out.commission += Number(r.commission) * f;
      out.realizedPnl += Number(r.realizedPnl) * f;
      out.lastTime = r.time;
    }
    if (!(out.qty > 0)) return null;
    return {
      qty: Number(out.qty.toFixed(8)),
      quote: Number(out.quote.toFixed(4)),
      price: Number((out.quote / out.qty).toPrecision(10)),
      commission: Number(out.commission.toFixed(6)),
      realizedPnl: Number(out.realizedPnl.toFixed(6)),
      lastTime: out.lastTime,
    };
  }

  // ---- exchange-side bracket (real stop-loss / take-profit orders via the Algo Order API) ----

  get supportsBrackets() { return true; }

  async algo(type, side, trigger) {
    await this.init();
    const a = await this.req('POST', '/fapi/v1/algoOrder', {
      algoType: 'CONDITIONAL', symbol: this.symbol, side, type, triggerPrice: this.fmtPrice(trigger),
      // priceProtect off: on the demo exchange mark and last price drift apart and a protected order stays stuck in
      // TRIGGERING (fired but never filled); the bot's own safety net still closes a position past its levels
      closePosition: 'true', workingType: 'CONTRACT_PRICE', priceProtect: 'false',
    });
    return String(a.algoId);
  }

  /** Stop-loss and take-profit that close the whole position on Binance. Returns their algo ids. */
  async placeBracket({ side, stop, target }) {
    const close = side === 'long' ? 'SELL' : 'BUY';
    const stopAlgoId = await this.algo('STOP_MARKET', close, stop);
    const targetAlgoId = await this.algo('TAKE_PROFIT_MARKET', close, target);
    return { stopAlgoId, targetAlgoId };
  }

  async cancelAlgo(algoId) {
    if (!algoId) return;
    try { await this.req('DELETE', '/fapi/v1/algoOrder', { algoId }); } catch { /* already triggered / gone */ }
  }

  /** Cancel every open stop / take-profit (algo) order on the symbol, including ones whose ids were lost. */
  async cancelAllAlgos() {
    // conditional (algo) orders, and any regular open orders (older-style stops / limits) on the symbol
    try { await this.req('DELETE', '/fapi/v1/algoOpenOrders', { symbol: this.symbol }); } catch { /* none open */ }
    try { await this.req('DELETE', '/fapi/v1/allOpenOrders', { symbol: this.symbol }); } catch { /* none open */ }
  }

  /** What is still open on the symbol (for error messages): algo and regular order counts and the position. */
  async openOrdersSummary() {
    const algos = await this.req('GET', '/fapi/v1/openAlgoOrders', { symbol: this.symbol }).catch((e) => ({ error: e.message }));
    const regular = await this.req('GET', '/fapi/v1/openOrders', { symbol: this.symbol }).catch((e) => ({ error: e.message }));
    const positions = await this.req('GET', '/fapi/v2/positionRisk', { symbol: this.symbol }).catch(() => []);
    const count = (x) => (Array.isArray(x) ? x.length : Array.isArray(x?.orders) ? x.orders.length : x?.error ? `? (${String(x.error).slice(0, 60)})` : '?');
    const pos = (Array.isArray(positions) ? positions : []).map((p) => `${p.positionSide || 'BOTH'} ${p.positionAmt}`).join(', ');
    return `open algo orders ${count(algos)}, open orders ${count(regular)}, position ${pos || '?'}`;
  }

  /** Replace the stop-loss (e.g. move to breakeven). Returns the new algo id. */
  async moveStop(trade, newStop) {
    await this.cancelAlgo(trade.stopAlgoId);
    return this.algo('STOP_MARKET', trade.side === 'long' ? 'SELL' : 'BUY', newStop);
  }

  /** { status, actualOrderId } of an algo order (actualOrderId is set once it triggered). */
  async algoStatus(algoId) {
    if (!algoId) return null;
    try {
      const a = await this.req('GET', '/fapi/v1/algoOrder', { algoId });
      return { status: a.algoStatus, actualOrderId: a.actualOrderId ? String(a.actualOrderId) : null };
    } catch { return null; }
  }

  /** Signed position size (+ long, - short). */
  async positionAmt() {
    const positions = await this.req('GET', '/fapi/v2/positionRisk', { symbol: this.symbol });
    return Number((positions.find((x) => x.symbol === this.symbol) || {}).positionAmt || 0);
  }

  /** side: 'buy' (USD notional) | 'sell' (BTC qty, closes a long) */
  async placeOrder({ side, notional, qty, price, source = 'manual', reason, leverage }) {
    if (side === 'buy') {
      const p = price ?? (await this.getPrice());
      return this.order('buy', Number(notional) / p, source, reason, leverage);
    }
    if (side === 'sell') return this.order('sell', Number(qty), source, reason);
    throw new Error(`Unknown side ${side}`);
  }

  async openShort({ notional, price, source = 'ai', leverage }) {
    const p = price ?? (await this.getPrice());
    return this.order('short', Number(notional) / p, source, undefined, leverage);
  }

  coverShort({ qty, source = 'ai', reason }) {
    return this.order('cover', Number(qty), source, reason);
  }

  async getOrders(limit = 50) {
    const orders = await this.req('GET', '/fapi/v1/allOrders', { symbol: this.symbol, limit: Math.min(limit, 1000) });
    return orders
      .map((o) => {
        const [source, action] = String(o.clientOrderId || '').split('-');
        return {
          id: String(o.orderId),
          time: new Date(o.updateTime || o.time).toISOString(),
          side: ACTION_SIDE[action] ? action : String(o.side).toLowerCase(),
          qty: Number(o.executedQty || o.origQty),
          price: Number(o.avgPrice) || null,
          notional: Number(o.cumQuote) || null,
          status: String(o.status).toLowerCase(),
          // ai = the bot; manual = the app's Buy / Sell buttons; otherwise Binance itself (a triggered stop /
          // take-profit) or an order placed on the Binance website
          source: source === 'ai' ? 'ai' : source === 'manual' ? 'manual'
            : /STOP/.test(o.origType || o.type) ? 'exchange stop' : /TAKE_PROFIT/.test(o.origType || o.type) ? 'exchange take-profit' : 'binance',
        };
      })
      .sort((a, b) => new Date(b.time) - new Date(a.time))
      .slice(0, limit);
  }

  reset() {
    throw new Error('Reset the Binance demo account from the Binance Demo Trading page');
  }
}
