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
    return { cash: this.startingCash, btc: 0, avgEntry: 0, startingCash: this.startingCash, orders: [] };
  }

  read() {
    return this.kv.get(KEY, this.fresh());
  }

  async getAccount(price) {
    const s = await this.read();
    const p = price ?? (await this.getPrice());
    return {
      broker: this.name,
      cash: s.cash,
      btc: s.btc,
      avgEntry: s.avgEntry,
      price: p,
      equity: s.cash + s.btc * p,
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
    const record = {
      id: `L${Date.now()}`, time: new Date().toISOString(), price: p, status: 'filled', source, ...(reason && { reason }), ...order,
    };
    s.orders.unshift(record);
    s.orders = s.orders.slice(0, 500);
    await this.kv.set(KEY, s);
    return record;
  }

  async reset() {
    await this.kv.set(KEY, this.fresh());
  }
}
