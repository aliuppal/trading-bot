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
      throw new Error(`Binance ${method} ${path} -> ${res.status}: ${data.msg || JSON.stringify(data).slice(0, 200)}`);
    }
    return data;
  }

  /** One-time setup: quantity step from exchangeInfo and the leverage for the symbol. */
  init() {
    this.ready ??= (async () => {
      try {
        const info = await this.req('GET', '/fapi/v1/exchangeInfo', {}, false);
        const lot = info.symbols?.find((s) => s.symbol === this.symbol)?.filters?.find((f) => f.filterType === 'MARKET_LOT_SIZE');
        if (lot) this.step = Number(lot.stepSize);
      } catch { /* keep the default step */ }
      await this.setLeverage(this.leverage).catch(() => {});
    })();
    return this.ready;
  }

  /** Set the symbol's leverage (only calls Binance when it changes). */
  async setLeverage(leverage) {
    const lev = Math.max(1, Math.round(leverage || 1));
    if (lev === this.currentLeverage) return;
    await this.req('POST', '/fapi/v1/leverage', { symbol: this.symbol, leverage: lev });
    this.currentLeverage = lev;
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

  /** action: buy | sell | short | cover. Closing orders (sell a long, cover a short) are reduce-only. */
  async order(action, qty, source = 'manual', reason, leverage) {
    await this.init();
    if (leverage) await this.setLeverage(leverage);
    const quantity = this.roundQty(qty);
    if (!(quantity > 0)) throw new Error(`Order too small (min ${this.step} BTC, $50)`);
    const o = await this.req('POST', '/fapi/v1/order', {
      symbol: this.symbol,
      side: ACTION_SIDE[action],
      type: 'MARKET',
      quantity,
      reduceOnly: action === 'sell' || action === 'cover' ? 'true' : undefined,
      newClientOrderId: `${source}-${action}-${Date.now()}`,
      newOrderRespType: 'RESULT',
    });
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
      ...(leverage && { leverage }),
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
            price: Number((quote / qty).toFixed(2)),
            commission: Number(rows.reduce((a, r) => a + Number(r.commission), 0).toFixed(6)),
            realizedPnl: Number(rows.reduce((a, r) => a + Number(r.realizedPnl), 0).toFixed(6)),
          };
        }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
    return null;
  }

  // ---- exchange-side bracket (real stop-loss / take-profit orders via the Algo Order API) ----

  get supportsBrackets() { return true; }

  async algo(type, side, trigger) {
    const a = await this.req('POST', '/fapi/v1/algoOrder', {
      algoType: 'CONDITIONAL', symbol: this.symbol, side, type, triggerPrice: Number(trigger).toFixed(1),
      closePosition: 'true', workingType: 'CONTRACT_PRICE', priceProtect: 'true',
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
          source: source === 'ai' ? 'ai' : 'manual',
        };
      })
      .sort((a, b) => new Date(b.time) - new Date(a.time))
      .slice(0, limit);
  }

  reset() {
    throw new Error('Reset the Binance demo account from the Binance Demo Trading page');
  }
}
