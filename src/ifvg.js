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

// rr: reward / risk multiple for the target (1 = 1:1, 3 = 1:3).
export function bracketLong(entry, zone, { bufferPct = 0.05, rr = 1, ...lim } = {}) {
  const rawStop = zone.bottom * (1 - bufferPct / 100);
  if (!(rawStop < entry)) return null;
  const risk = clampRisk(entry - rawStop, entry, lim);
  return { stop: round2(entry - risk), target: round2(entry + risk * rr), risk: round2(risk), rr };
}

/** Bracket for a short entry off a bearish IFVG: stop just above the zone top, target rr x that distance below. */
export function bracketShort(entry, zone, { bufferPct = 0.05, rr = 1, ...lim } = {}) {
  const rawStop = zone.top * (1 + bufferPct / 100);
  if (!(rawStop > entry)) return null;
  const risk = clampRisk(rawStop - entry, entry, lim);
  return { stop: round2(entry + risk), target: round2(entry - risk * rr), risk: round2(risk), rr };
}

/** side: 'long' | 'short' */
export function bracketFor(side, entry, zone, opts) {
  return side === 'short' ? bracketShort(entry, zone, opts) : bracketLong(entry, zone, opts);
}

// ---------------------------------------------------------------------------------------------
// Higher-timeframe (HTF) FVGs and taps
// ---------------------------------------------------------------------------------------------

/** Merge candles into a larger timeframe (e.g. 1h -> 2h / 4h), buckets aligned to UTC. */
export function aggregate(candles, toSeconds) {
  const size = toSeconds * 1000;
  const out = [];
  for (const c of candles) {
    const t = Math.floor(c.time / size) * size;
    const last = out.at(-1);
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume || 0;
    } else {
      out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    }
  }
  return out;
}

/**
 * FVGs on a higher timeframe that are still active (price has not closed through them).
 * readyAt: when the 3rd candle closed, i.e. from when the gap exists.
 */
export function activeFvgs(candles, seconds, { minGapPct = 0.05, label } = {}) {
  return findFvgs(candles, { minGapPct })
    .filter((f) => f.invertedIndex === undefined)
    .map((f) => ({
      tf: label || `${seconds / 3600}h`,
      type: f.type,
      top: f.top,
      bottom: f.bottom,
      formedAt: f.formedAt,
      readyAt: candles[f.index + 1].time + seconds * 1000,
    }));
}

/**
 * Has price tapped an HTF FVG of the same direction recently?
 * Bullish setups need a bullish HTF FVG (demand), bearish setups a bearish one (supply).
 * A tap is any lower-timeframe candle in `recent` that traded into the zone after it formed.
 * Returns the most recently tapped zone (with tappedAt) or null.
 */
export function findHtfTap(recent, zones, direction) {
  let best = null;
  for (const z of zones) {
    if (z.type !== direction) continue;
    for (let i = recent.length - 1; i >= 0; i--) {
      const c = recent[i];
      if (c.time < z.readyAt) break;
      if (c.low <= z.top && c.high >= z.bottom) {
        if (!best || c.time > best.tappedAt) best = { ...z, tappedAt: c.time };
        break;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Closed vs. forming candles (multi-timeframe priority)
// ---------------------------------------------------------------------------------------------

/** Drop the last candle while it is still forming (now is before its close). */
export function closedCandles(candles, seconds, now = Date.now()) {
  const last = candles.at(-1);
  return last && now < last.time + seconds * 1000 ? candles.slice(0, -1) : candles;
}

/**
 * Is an IFVG in the given direction forming right now? True when the still-open candle's live price is
 * beyond a recent active FVG (above a bearish FVG's top for bullish, below a bullish FVG's bottom for bearish),
 * so the inversion will be confirmed if the candle closes there. Returns the zone or null.
 */
export function formingIfvg(candles, seconds, direction, now = Date.now(), { minGapPct = 0.03, lookback = 30 } = {}) {
  const last = candles.at(-1);
  if (!last || now >= last.time + seconds * 1000) return null; // nothing forming
  const closed = candles.slice(0, -1);
  const fvgType = direction === 'bullish' ? 'bearish' : 'bullish';
  const live = last.close;
  const f = findFvgs(closed, { minGapPct })
    .filter((z) => z.type === fvgType && z.invertedIndex === undefined && closed.length - 1 - z.index <= lookback)
    .find((z) => (direction === 'bullish' ? live > z.top : live < z.bottom));
  return f ? { direction, top: f.top, bottom: f.bottom } : null;
}
