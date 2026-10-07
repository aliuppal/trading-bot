export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** Full EMA series (same length as input; leading entries null until seeded). */
export function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function ema(values, period) {
  const s = emaSeries(values, period);
  return s[s.length - 1] ?? null;
}

/** Wilder's RSI */
export function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  if (values.length < slow + signal) return null;
  const f = emaSeries(values, fast);
  const s = emaSeries(values, slow);
  const line = values.map((_, i) => (f[i] !== null && s[i] !== null ? f[i] - s[i] : null)).filter((v) => v !== null);
  const sig = ema(line, signal);
  const m = line[line.length - 1];
  return { macd: m, signal: sig, histogram: m - sig };
}

export function bollinger(values, period = 20, mult = 2) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  return { upper: mid + mult * sd, middle: mid, lower: mid - mult * sd };
}

export function summarize(candles) {
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const pct = (n) => (closes.length > n ? ((last - closes[closes.length - 1 - n]) / closes[closes.length - 1 - n]) * 100 : null);
  const round = (v, d = 2) => (v === null || v === undefined ? null : Number(v.toFixed(d)));
  const m = macd(closes);
  const bb = bollinger(closes);
  return {
    price: round(last),
    change_1: round(pct(1)),
    change_6: round(pct(6)),
    change_24: round(pct(24)),
    sma_20: round(sma(closes, 20)),
    sma_50: round(sma(closes, 50)),
    ema_12: round(ema(closes, 12)),
    ema_26: round(ema(closes, 26)),
    rsi_14: round(rsi(closes, 14)),
    macd: m && { macd: round(m.macd), signal: round(m.signal), histogram: round(m.histogram) },
    bollinger: bb && { upper: round(bb.upper), middle: round(bb.middle), lower: round(bb.lower) },
    high_24: round(Math.max(...candles.slice(-24).map((c) => c.high))),
    low_24: round(Math.min(...candles.slice(-24).map((c) => c.low))),
  };
}
