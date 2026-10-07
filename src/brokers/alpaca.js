// Alpaca free paper-trading account (supports BTC/USD crypto).
// Docs: https://docs.alpaca.markets/reference

const SYMBOL = 'BTC/USD';

export class AlpacaBroker {
  constructor({ key, secret, baseUrl, getPrice }, fetchImpl = fetch) {
    if (!key || !secret) throw new Error('ALPACA_API_KEY and ALPACA_API_SECRET are required for BROKER=alpaca');
    if (!baseUrl.includes('paper')) throw new Error('Refusing to use a non-paper Alpaca URL');
    this.name = 'alpaca';
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, 'Content-Type': 'application/json' };
    this.getPrice = getPrice;
    this.fetch = fetchImpl;
  }

  async req(method, p, body) {
    const res = await this.fetch(`${this.baseUrl}${p}`, {
      method, headers: this.headers, body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && p.startsWith('/v2/positions')) return null;
    if (!res.ok) throw new Error(`Alpaca ${method} ${p} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
  }

  async getAccount(price) {
    const [acct, pos] = await Promise.all([
      this.req('GET', '/v2/account'),
      this.req('GET', `/v2/positions/${encodeURIComponent('BTCUSD')}`),
    ]);
    const p = price ?? (pos ? Number(pos.current_price) : await this.getPrice());
    const btc = pos ? Number(pos.qty) : 0;
    const cash = Number(acct.cash);
    return {
      broker: this.name,
      cash,
      btc,
      avgEntry: pos ? Number(pos.avg_entry_price) : 0,
      price: p,
      equity: cash + btc * p,
      accountEquity: Number(acct.equity),
      startingCash: null,
    };
  }

  async getOrders(limit = 50) {
    const orders = await this.req('GET', `/v2/orders?status=all&limit=${limit}&symbols=${encodeURIComponent(SYMBOL)}`);
    return orders.map((o) => ({
      id: o.id,
      time: o.filled_at || o.submitted_at,
      side: o.side,
      qty: Number(o.filled_qty || o.qty || 0),
      price: o.filled_avg_price ? Number(o.filled_avg_price) : null,
      notional: o.notional ? Number(o.notional) : o.filled_avg_price ? Number(o.filled_qty) * Number(o.filled_avg_price) : null,
      status: o.status,
      source: o.client_order_id?.startsWith('ai-') ? 'ai' : 'manual',
    }));
  }

  async placeOrder({ side, notional, qty, source = 'manual' }) {
    const body = { symbol: SYMBOL, side, type: 'market', time_in_force: 'gtc', client_order_id: `${source}-${Date.now()}` };
    if (side === 'buy') body.notional = Number(notional).toFixed(2);
    else body.qty = Number(qty).toFixed(9);
    const o = await this.req('POST', '/v2/orders', body);
    return { id: o.id, time: o.submitted_at, side, status: o.status, notional: body.notional, qty: body.qty, source };
  }

  async reset() {
    throw new Error('Reset your Alpaca paper account from the Alpaca dashboard');
  }
}
