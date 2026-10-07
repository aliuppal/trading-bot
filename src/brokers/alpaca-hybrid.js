// BROKER=alpaca: longs (buy / sell) go to your Alpaca paper account; shorts are simulated, because
// Alpaca does not allow short selling crypto. Simulated shorts use the local paper account's short book.

export class AlpacaWithSimShorts {
  constructor({ alpaca, sim }) {
    this.alpaca = alpaca;
    this.sim = sim;
    this.name = 'alpaca';
    this.getPrice = alpaca.getPrice;
  }

  /** Alpaca balances plus the simulated short (its unrealized P&L is added to equity). */
  async getAccount(price) {
    const [a, s] = await Promise.all([this.alpaca.getAccount(price), this.sim.getAccount(price)]);
    const p = price ?? a.price;
    const shortPnl = s.shortBtc ? (s.shortEntry - p) * s.shortBtc : 0;
    return { ...a, shortBtc: s.shortBtc, shortEntry: s.shortEntry, equity: a.equity + shortPnl };
  }

  placeOrder(order) {
    return this.alpaca.placeOrder(order);
  }

  async openShort(order) {
    return { ...(await this.sim.openShort(order)), simulated: true };
  }

  async coverShort(order) {
    return { ...(await this.sim.coverShort(order)), simulated: true };
  }

  /** Alpaca orders and simulated short orders, newest first. */
  async getOrders(limit = 50) {
    const [a, s] = await Promise.all([this.alpaca.getOrders(limit), this.sim.getOrders(limit)]);
    const sim = s.filter((o) => o.side === 'short' || o.side === 'cover').map((o) => ({ ...o, status: `${o.status} (simulated)` }));
    return [...a, ...sim].sort((x, y) => new Date(y.time) - new Date(x.time)).slice(0, limit);
  }

  reset() {
    return this.alpaca.reset();
  }
}
