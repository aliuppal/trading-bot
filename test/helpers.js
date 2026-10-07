export function makeCandles(n = 120, start = 60000, drift = 0) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const open = p;
    p = p * (1 + drift + Math.sin(i / 5) * 0.004);
    out.push({ time: Date.UTC(2026, 0, 1) + i * 3600000, open, high: Math.max(open, p) * 1.002, low: Math.min(open, p) * 0.998, close: p, volume: 100 });
  }
  return out;
}

export function geminiResponse(obj) {
  return async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }),
  });
}

/** In-memory stand-in for the FileKV / RedisKV stores. */
export class MemKV {
  constructor() { this.m = new Map(); this.name = 'memory'; }
  async get(k, d) { return this.m.has(k) ? structuredClone(this.m.get(k)) : structuredClone(d); }
  async set(k, v) { this.m.set(k, structuredClone(v)); }
  async del(k) { this.m.delete(k); }
}

/**
 * Flat candles ending in a bullish IFVG: a bearish FVG (zone 59500-59950) that the last candle closes back above.
 * The last candle opens at `end - 1000` ms.
 */
export function ifvgCandles(end = Date.UTC(2026, 9, 7, 12)) {
  const H = 900000;
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ open: 60000, high: 60050, low: 59950, close: 60000 });
  rows.push({ open: 60000, high: 60050, low: 59950, close: 59960 }); // a
  rows.push({ open: 59950, high: 59960, low: 58990, close: 59000 }); // displacement down
  rows.push({ open: 59000, high: 59500, low: 58800, close: 59100 }); // c: a.low 59950 > c.high 59500 -> bearish FVG
  rows.push({ open: 59100, high: 60150, low: 59050, close: 60100 }); // closes above 59950 -> bullish IFVG
  const start = end - 1000 - (rows.length - 1) * H;
  return rows.map((r, i) => ({ ...r, time: start + i * H, volume: 10 }));
}

/** Mirror image of ifvgCandles: ends in a bearish IFVG (a bullish FVG, zone 60500-60050 mirrored, closed back below). */
export function bearishIfvgCandles(end) {
  const K = 120000;
  return ifvgCandles(end).map((c) => ({ ...c, open: K - c.open, close: K - c.close, high: K - c.low, low: K - c.high }));
}
