// Built-in simulated paper account. Persists under the "account" key of the KV store.
const FEE_RATE = 0.001; // 0.1% simulated taker fee
const KEY = 'account';

export class LocalBroker {
  constructor({ kv, startingCash, getPrice }) {
    this.name = 'local';
    this.kv = kv;
    this.startingCash = startingCash;
    this.getPrice = getPrice;
  }

  fresh() {
    return { cash: this.startingCash, btc: 0, avgEntry: 0, shortBtc: 0, shortEntry: 0, startingCash: this.startingCash, orders: [] };
  }

  read() {
    return this.kv.get(KEY, this.fresh());
  }

  async getAccount(price) {
    const s = await this.read();
    const p = price ?? (await this.getPrice());
    const shortBtc = s.shortBtc || 0;
    return {
      broker: this.name,
      cash: s.cash,
      btc: s.btc,
      avgEntry: s.avgEntry,
      shortBtc,
      shortEntry: s.shortEntry || 0,
      price: p,
      equity: s.cash + s.btc * p - shortBtc * p,
      startingCash: s.startingCash,
    };
  }

  async getOrders(limit = 50) {
    return (await this.read()).orders.slice(0, limit);
  }

  /** side: 'buy' | 'sell'; buy uses notional USD, sell uses BTC qty */
  async placeOrder({ side, notional, qty, price, source = 'manual', reason }) {
    const s = await this.read();
    const p = price ?? (await this.getPrice());
    let order;
    if (side === 'buy') {
      const usd = Math.min(Number(notional), s.cash);
      if (!(usd >= 1)) throw new Error('Insufficient cash (min $1)');
      const fee = usd * FEE_RATE;
      const btc = (usd - fee) / p;
      s.avgEntry = (s.avgEntry * s.btc + p * btc) / (s.btc + btc);
      s.btc += btc;
      s.cash -= usd;
      order = { side, qty: btc, notional: usd, fee };
    } else if (side === 'sell') {
      const btc = Math.min(Number(qty), s.btc);
      if (!(btc > 0) || btc * p < 1) throw new Error('Insufficient BTC (min $1)');
      const gross = btc * p;
      const fee = gross * FEE_RATE;
      const pnl = (p - s.avgEntry) * btc - fee;
      s.btc -= btc;
      s.cash += gross - fee;
      if (s.btc < 1e-10) { s.btc = 0; s.avgEntry = 0; }
      order = { side, qty: btc, notional: gross, fee, pnl };
    } else {
      throw new Error(`Unknown side ${side}`);
    }
    return this.record(s, order, p, source, reason);
  }

  /** Simulated short sale of `notional` USD of BTC. Proceeds are credited to cash; equity subtracts the short. */
  async openShort({ notional, price, source = 'ai' }) {
    const s = await this.read();
    const p = price ?? (await this.getPrice());
    const usd = Math.min(Number(notional), s.cash);
    if (!(usd >= 1)) throw new Error('Insufficient cash to back a short (min $1)');
    const qty = usd / p;
    const fee = usd * FEE_RATE;
    const held = s.shortBtc || 0;
    s.shortEntry = ((s.shortEntry || 0) * held + p * qty) / (held + qty);
    s.shortBtc = held + qty;
    s.cash += usd - fee;
    return this.record(s, { side: 'short', qty, notional: usd, fee }, p, source);
  }

  /** Buy back `qty` BTC of the open short. */
  async coverShort({ qty, price, source = 'ai', reason }) {
    const s = await this.read();
    const p = price ?? (await this.getPrice());
    const btc = Math.min(Number(qty), s.shortBtc || 0);
    if (!(btc > 0) || btc * p < 1) throw new Error('No short position to cover');
    const cost = btc * p;
    const fee = cost * FEE_RATE;
    const pnl = (s.shortEntry - p) * btc - fee;
    s.shortBtc -= btc;
    s.cash -= cost + fee;
    if (s.shortBtc < 1e-10) { s.shortBtc = 0; s.shortEntry = 0; }
    return this.record(s, { side: 'cover', qty: btc, notional: cost, fee, pnl }, p, source, reason);
  }

  async record(s, order, p, source, reason) {
    const rec = {
      id: `L${Date.now()}`, time: new Date().toISOString(), price: p, status: 'filled', source, ...(reason && { reason }), ...order,
    };
    s.orders.unshift(rec);
    s.orders = s.orders.slice(0, 500);
    await this.kv.set(KEY, s);
    return rec;
  }

  async reset() {
    await this.kv.set(KEY, this.fresh());
  }
}
