// Public, key-less BTC market data. Coinbase first, Binance as fallback.

const COINBASE = 'https://api.exchange.coinbase.com';
const BINANCE = 'https://api.binance.com';

const BINANCE_INTERVALS = { 60: '1m', 300: '5m', 900: '15m', 3600: '1h', 21600: '6h', 86400: '1d' };
// Timeframes Coinbase doesn't offer, built from a smaller one: seconds -> [base seconds, candles per bucket].
const BUILT = { 180: [60, 3], 1800: [900, 2], 7200: [3600, 2], 14400: [3600, 4] };

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'trading-bot/1.0' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/** Returns candles oldest-first: { time (ms), open, high, low, close, volume } */
export async function getCandles(granularity = 3600, limit = 200) {
  if (BUILT[granularity]) return built(granularity, limit);
  try {
    const rows = await getJson(`${COINBASE}/products/BTC-USD/candles?granularity=${granularity}`);
    // Coinbase: [time(s), low, high, open, close, volume], newest first
    return rows
      .slice(0, limit)
      .map(([t, low, high, open, close, volume]) => ({ time: t * 1000, open, high, low, close, volume }))
      .reverse();
  } catch (err) {
    const interval = BINANCE_INTERVALS[granularity] || '1h';
    const rows = await getJson(`${BINANCE}/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`);
    return rows.map((r) => ({
      time: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
    }));
  }
}

export async function getPrice() {
  try {
    const t = await getJson(`${COINBASE}/products/BTC-USD/ticker`);
    return Number(t.price);
  } catch {
    const t = await getJson(`${BINANCE}/api/v3/ticker/price?symbol=BTCUSDT`);
    return Number(t.price);
  }
}

/** 3m / 30m / 2h / 4h candles merged from 1m / 15m / 1h candles (300 base candles), buckets aligned to UTC. */
async function built(granularity, limit) {
  const [base] = BUILT[granularity];
  const rows = await getCandles(base, 300);
  const size = granularity * 1000;
  const out = [];
  for (const c of rows) {
    const t = Math.floor(c.time / size) * size;
    const last = out.at(-1);
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else {
      out.push({ ...c, time: t });
    }
  }
  return out.slice(-limit);
}
