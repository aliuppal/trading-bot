// Inverse Fair Value Gap (IFVG) detection.
//
// A fair value gap (FVG) is a 3-candle imbalance:
//   bullish FVG: candle[i-2].high < candle[i].low   -> gap zone [c[i-2].high, c[i].low]
//   bearish FVG: candle[i-2].low  > candle[i].high  -> gap zone [c[i].high, c[i-2].low]
// The FVG is "inverted" when a later candle CLOSES through the whole gap on the opposite side:
//   bearish FVG closed above its top    -> bullish IFVG (old resistance becomes support) -> long setup
//   bullish FVG closed below its bottom -> bearish IFVG (old support becomes resistance) -> short setup

/**
 * Find every FVG in the candles and whether/when it was inverted.
 * candles: oldest-first { time, open, high, low, close }.
 * minGapPct: ignore gaps smaller than this % of price (noise filter).
 */
export function findFvgs(candles, { minGapPct = 0.03 } = {}) {
  const out = [];
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2], c = candles[i];
    let fvg = null;
    if (a.high < c.low) fvg = { type: 'bullish', bottom: a.high, top: c.low };
    else if (a.low > c.high) fvg = { type: 'bearish', bottom: c.high, top: a.low };
    if (!fvg) continue;
    if (((fvg.top - fvg.bottom) / c.close) * 100 < minGapPct) continue;
    fvg.index = i - 1; // middle (displacement) candle
    fvg.formedAt = candles[i - 1].time;
    for (let j = i + 1; j < candles.length; j++) {
      const close = candles[j].close;
      if ((fvg.type === 'bearish' && close > fvg.top) || (fvg.type === 'bullish' && close < fvg.bottom)) {
        fvg.invertedIndex = j;
        fvg.invertedAt = candles[j].time;
        break;
      }
    }
    out.push(fvg);
  }
  return out;
}

/** All IFVGs (inverted FVGs), oldest inversion first. direction is the trade direction after inversion. */
export function findIfvgs(candles, opts) {
  return findFvgs(candles, opts)
    .filter((f) => f.invertedIndex !== undefined)
    .map((f) => ({
      id: `${f.type === 'bearish' ? 'bull' : 'bear'}-${f.formedAt}`,
      direction: f.type === 'bearish' ? 'bullish' : 'bearish',
      top: f.top,
      bottom: f.bottom,
      formedAt: f.formedAt,
      invertedAt: f.invertedAt,
      formedIndex: f.index,
      invertedIndex: f.invertedIndex,
    }))
    .sort((x, y) => x.invertedIndex - y.invertedIndex);
}

/**
 * The freshest tradeable IFVG: inverted within the last `maxAge` candles and price still respecting it
 * (above the zone bottom for bullish, below the zone top for bearish). Returns null when there is none.
 */
export function latestSetup(candles, { maxAge = 3, minGapPct = 0.03 } = {}) {
  if (candles.length < 5) return null;
  const last = candles.length - 1;
  const price = candles[last].close;
  const fresh = findIfvgs(candles, { minGapPct })
    .filter((z) => last - z.invertedIndex <= maxAge)
    .filter((z) => (z.direction === 'bullish' ? price > z.bottom : price < z.top));
  const z = fresh.at(-1);
  return z ? { ...z, ageCandles: last - z.invertedIndex } : null;
}

/**
 * 1:1 bracket for a long entry off a bullish IFVG.
 * Stop sits just under the zone bottom; target is the same distance above entry.
 * Stop distance is clamped to [minRiskPct, maxRiskPct] of entry; returns null if the stop would be above entry.
 */
const clampRisk = (risk, entry, { minRiskPct = 0.15, maxRiskPct = 3 }) =>
  Math.min(Math.max(risk, (entry * minRiskPct) / 100), (entry * maxRiskPct) / 100);
const round2 = (v) => Number(v.toFixed(2));

export function bracketLong(entry, zone, { bufferPct = 0.05, ...lim } = {}) {
  const rawStop = zone.bottom * (1 - bufferPct / 100);
  if (!(rawStop < entry)) return null;
  const risk = clampRisk(entry - rawStop, entry, lim);
  return { stop: round2(entry - risk), target: round2(entry + risk), risk: round2(risk), rr: 1 };
}

/** 1:1 bracket for a short entry off a bearish IFVG: stop just above the zone top, target the same distance below. */
export function bracketShort(entry, zone, { bufferPct = 0.05, ...lim } = {}) {
  const rawStop = zone.top * (1 + bufferPct / 100);
  if (!(rawStop > entry)) return null;
  const risk = clampRisk(rawStop - entry, entry, lim);
  return { stop: round2(entry + risk), target: round2(entry - risk), risk: round2(risk), rr: 1 };
}

/** side: 'long' | 'short' */
export function bracketFor(side, entry, zone, opts) {
  return side === 'short' ? bracketShort(entry, zone, opts) : bracketLong(entry, zone, opts);
}
