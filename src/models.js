// Strategy models besides IFVG. Each one finds a setup in the same shape as the IFVG scan, so the rest of the
// bot (path checks, Jev confirmation, brackets, reviews) works unchanged:
//   { direction, top, bottom, formedAt, invertedAt, id, granularity, category, displacement, grade,
//     qualityReasons, swingStop, ageCandles, formationCandles, model, htfTarget? }
// top / bottom is the zone the stop is placed beyond (bracketFor puts the stop under bottom / above top).
//
//   ict2022   liquidity sweep -> market structure shift with displacement -> retrace into the displacement FVG
//   unicorn   sweep -> displacement through structure -> FVG overlapping the breaker -> retrace into the overlap
//   amd       Asia range (accumulation) -> sweep of one side (manipulation) -> displacement back through the
//             daily open (distribution), targeting the other side of the range
//   forever   first tap of a 15m / 1h FVG -> IFVG on the entry timeframe -> SMT with the correlated market ->
//             close beyond the last pivot (order-block confirmation)
import { findFvgs, closedCandles, isDisplacement, findHtfTap, latestSetup, minGapFor } from './ifvg.js';
import { swings, liquidityLevels } from './liquidity.js';
import { loadHtfZones, tfLabel, atr14 } from './strategy.js';

export const MODELS = {
  ifvg: { name: 'IFVG', jev: 'assists' },
  jev: { name: 'Jev', jev: 'decides' },
  ict2022: { name: 'ICT 2022', jev: 'assists' },
  unicorn: { name: 'Unicorn', jev: 'assists' },
  amd: { name: 'AMD (Power of 3)', jev: 'assists' },
  forever: { name: 'Forever Model', jev: 'assists' },
};

/** Short rule text per model, for Jev and the strategy pop-up. */
export const MODEL_RULES = {
  ifvg: 'IFVG: first tap of an unmitigated HTF FVG (or an ITH/ITL sweep), then an inverse FVG on the entry timeframe within 3-7 candles counted from the first FVG of the series.',
  jev: 'Jev: no pattern filter. Jev reads price, structure and liquidity and decides BUY / SELL / HOLD by itself, picks scalp or swing, and manages the trade (reviews every 3 min for scalps, 5 min for swings).',
  ict2022: 'ICT 2022: price sweeps a swing low (longs) / swing high (shorts), then a displacement candle closes through the most recent opposing swing (market structure shift). Entry on the retrace into the FVG of that displacement leg; stop beyond the swept extreme; target the liquidity on the other side.',
  unicorn: 'Unicorn: sweep of a swing, displacement through structure, and an FVG of that leg that overlaps the breaker (the last opposite candle before the move). Entry on the retrace into the breaker + FVG overlap; stop beyond the breaker; invalid on a close through the breaker.',
  amd: 'AMD (Power of 3): the Asia session (00:00-06:00 UTC) range is the accumulation; a sweep of one side of it after 06:00 is the manipulation; a displacement candle closing back through the daily open the other way is the distribution entry. Stop beyond the manipulation extreme, target the far side of the range.',
  forever: 'Forever Model: first tap of an unmitigated 15m / 1h FVG, then an IFVG on the entry timeframe, SMT with the correlated market (it did not take the same liquidity) and a close beyond the last pivot (order-block confirmation). Stop at the extreme between the tap and the confirmation.',
};

const categoryOf = (g) => (g <= 180 ? 'scalp' : 'swing');
const sig = (v) => Number(Number(v).toPrecision(8));

/**
 * Sweep -> market structure shift -> FVG of the displacement leg (shared by ICT 2022 and Unicorn).
 * Returns the newest valid sequence whose FVG price is now retracing into, or null.
 */
export function sweepShiftFvg(c, direction, { lookback = 40, maxShift = 12, maxRetrace = 10, minGapPct = 0.02 } = {}) {
  if (c.length < 20) return null;
  const last = c.length - 1;
  const bull = direction === 'bullish';
  const sw = swings(c, 2);
  const pivots = bull ? sw.lows : sw.highs; // liquidity that gets swept
  const opposing = bull ? sw.highs : sw.lows; // structure that gets broken
  const fvgs = findFvgs(c, { minGapPct }).filter((f) => f.type === direction);
  let best = null;
  for (const p of pivots) {
    // first candle that trades through the pivot after it was confirmed
    let s = -1;
    for (let j = p.index + 3; j <= last; j++) {
      if (bull ? c[j].low < p.price : c[j].high > p.price) { s = j; break; }
    }
    if (s < 0 || last - s > lookback) continue;
    // the most recent opposing swing before the sweep: the structure to break
    const struct = opposing.filter((o) => o.index < s && o.index > p.index - 20).at(-1);
    if (!struct) continue;
    let m = -1;
    let extreme = bull ? c[s].low : c[s].high;
    for (let j = s; j <= Math.min(last, s + maxShift); j++) {
      extreme = bull ? Math.min(extreme, c[j].low) : Math.max(extreme, c[j].high);
      const broke = bull ? c[j].close > struct.price : c[j].close < struct.price;
      if (broke && j > s) { m = j; break; }
    }
    if (m < 0) continue;
    let disp = false;
    for (let j = s + 1; j <= m; j++) if (isDisplacement(c, j) && (bull ? c[j].close > c[j].open : c[j].close < c[j].open)) disp = true;
    if (!disp) continue;
    // FVG left by the displacement leg (middle candle between the sweep and the shift)
    if (last - m > maxRetrace || last <= m + 1) continue;
    // the leg can leave several gaps: take the newest one price is retracing into now,
    // without any close through its far side since it formed
    const k = c[last];
    const fvg = fvgs.filter((f) => f.index > s && f.index <= m + 1).reverse().find((f) => {
      const broken = c.slice(f.index + 2, last + 1).some((x) => (bull ? x.close < f.bottom : x.close > f.top));
      const inGap = bull ? k.low <= f.top && k.close > f.bottom : k.high >= f.bottom && k.close < f.top;
      return !broken && inGap;
    });
    if (!fvg) continue;
    if (!best || s > best.s) best = { s, m, fvg, struct, pivot: p, extreme };
  }
  return best;
}

/** The last opposite-colour candle before the displacement leg: the breaker. */
function breakerOf(c, seq, bull) {
  for (let j = seq.m - 1; j >= Math.max(0, seq.s - 3); j--) {
    const k = c[j];
    if (bull ? k.close < k.open : k.close > k.open) return { index: j, low: k.low, high: k.high };
  }
  return null;
}

export function ict2022(c, g) {
  for (const direction of ['bullish', 'bearish']) {
    const seq = sweepShiftFvg(c, direction, { minGapPct: minGapFor(g) });
    if (!seq) continue;
    const bull = direction === 'bullish';
    const { fvg } = seq;
    return {
      direction,
      top: bull ? fvg.top : Math.max(fvg.top, seq.extreme),
      bottom: bull ? Math.min(fvg.bottom, seq.extreme) : fvg.bottom,
      fvg: { top: fvg.top, bottom: fvg.bottom },
      swingStop: seq.extreme,
      formedAt: c[seq.s].time,
      invertedAt: c[seq.m].time,
      id: `ict2022:${g}:${c[seq.s].time}`,
      displacement: true,
      formationCandles: seq.m - seq.s,
      ageCandles: c.length - 1 - seq.m,
      sweep: { type: bull ? 'swing low' : 'swing high', price: seq.pivot.price, tf: tfLabel(g) },
      qualityReasons: [`swept ${bull ? 'swing low' : 'swing high'} ${sig(seq.pivot.price)}`, `MSS: displacement closed ${bull ? 'above' : 'below'} ${sig(seq.struct.price)}`, `retrace into FVG ${sig(fvg.bottom)}-${sig(fvg.top)}`],
    };
  }
  return null;
}

export function unicorn(c, g) {
  for (const direction of ['bullish', 'bearish']) {
    const seq = sweepShiftFvg(c, direction, { minGapPct: minGapFor(g) });
    if (!seq) continue;
    const bull = direction === 'bullish';
    const br = breakerOf(c, seq, bull);
    if (!br) continue;
    const lo = Math.max(seq.fvg.bottom, br.low), hi = Math.min(seq.fvg.top, br.high);
    if (!(hi > lo)) continue; // FVG and breaker must overlap
    const k = c.at(-1);
    const inOverlap = bull ? k.low <= hi && k.close > lo : k.high >= lo && k.close < hi;
    if (!inOverlap) continue;
    return {
      direction,
      // stop beyond the breaker's far extreme
      top: bull ? hi : Math.max(hi, br.high),
      bottom: bull ? Math.min(lo, br.low) : lo,
      fvg: { top: seq.fvg.top, bottom: seq.fvg.bottom },
      breaker: { low: br.low, high: br.high },
      swingStop: seq.extreme,
      formedAt: c[br.index].time,
      invertedAt: c[seq.m].time,
      id: `unicorn:${g}:${c[seq.s].time}`,
      displacement: true,
      formationCandles: seq.m - seq.s,
      ageCandles: c.length - 1 - seq.m,
      sweep: { type: bull ? 'swing low' : 'swing high', price: seq.pivot.price, tf: tfLabel(g) },
      qualityReasons: [`swept ${bull ? 'swing low' : 'swing high'} ${sig(seq.pivot.price)}`, `displacement through ${sig(seq.struct.price)}`, `breaker + FVG overlap ${sig(lo)}-${sig(hi)}`],
    };
  }
  return null;
}

const DAY = 86400000;
/** AMD on 5m: Asia range -> sweep of one side -> displacement back through the daily open. */
export function amd(c, g, now) {
  const dayStart = Math.floor(now / DAY) * DAY;
  const h = (now - dayStart) / 3600000;
  if (h < 6.5 || h > 16) return null; // distribution window 06:30-16:00 UTC
  const today = c.filter((k) => k.time >= dayStart);
  const asia = today.filter((k) => k.time < dayStart + 6 * 3600000);
  if (asia.length < Math.floor((3 * 3600) / g)) return null;
  const open = asia[0].open;
  const rHi = Math.max(...asia.map((k) => k.high)), rLo = Math.min(...asia.map((k) => k.low));
  const later = today.filter((k) => k.time >= dayStart + 6 * 3600000);
  const last = c.length - 1;
  for (const side of ['high', 'low']) {
    // manipulation: first candle beyond the range side, then a close back inside within 6 candles
    const i = later.findIndex((k) => (side === 'high' ? k.high > rHi : k.low < rLo));
    if (i < 0) continue;
    const back = later.slice(i, i + 7).findIndex((k) => (side === 'high' ? k.close < rHi : k.close > rLo));
    if (back < 0) continue;
    const manip = later.slice(i, i + back + 1);
    const extreme = side === 'high' ? Math.max(...manip.map((k) => k.high)) : Math.min(...manip.map((k) => k.low));
    // distribution: displacement candle closing through the daily open, the other way
    const from = c.indexOf(later[i + back]);
    let d = -1;
    for (let j = from; j <= last; j++) {
      const k = c[j];
      const through = side === 'high' ? k.close < open && k.close < k.open : k.close > open && k.close > k.open;
      if (through && isDisplacement(c, j, { mult: 1.3 })) { d = j; break; }
    }
    if (d < 0 || last - d > 3) continue;
    const bull = side === 'low';
    const px = c[last].close;
    if (bull ? px <= open : px >= open) continue; // still beyond the open
    return {
      direction: bull ? 'bullish' : 'bearish',
      top: bull ? Math.max(open, c[d].close) : extreme,
      bottom: bull ? extreme : Math.min(open, c[d].close),
      swingStop: extreme,
      formedAt: asia[0].time,
      invertedAt: c[d].time,
      id: `amd:${g}:${dayStart}:${side}`,
      displacement: true,
      formationCandles: d - from,
      ageCandles: last - d,
      sweep: { type: side === 'high' ? 'Asia high' : 'Asia low', price: side === 'high' ? rHi : rLo, tf: 'Asia' },
      htfTarget: { price: bull ? rHi : rLo, tf: 'Asia', type: bull ? 'range high' : 'range low', inside: false },
      qualityReasons: [`Asia range ${sig(rLo)}-${sig(rHi)}, open ${sig(open)}`, `manipulation swept the ${side} (${sig(extreme)})`, 'distribution: displacement back through the open'],
    };
  }
  return null;
}

/** Forever Model: HTF FVG first tap -> IFVG -> SMT -> close beyond the last pivot. */
export async function forever(c, g, now, zones, pairMarket) {
  const tfs = g <= 180 ? ['5m', '15m'] : ['15m', '1h'];
  const s = latestSetup(c, { maxAge: 3, maxGapAge: 7, minGapPct: minGapFor(g) });
  if (!s) return null;
  const bull = s.direction === 'bullish';
  const since = c.at(-1).time - (g <= 180 ? 60 : 180) * 60000;
  const tap = findHtfTap(c.filter((k) => k.time >= since), zones.filter((z) => tfs.includes(z.tf)), s.direction);
  if (!tap) return null;
  // SMT: we took the liquidity since the tap, the correlated market did not
  let smt = null;
  if (pairMarket) {
    const p = closedCandles(await pairMarket.getCandles(g, 200), g, now);
    const pa = p.filter((k) => k.time >= tap.tappedAt), pb = p.filter((k) => k.time < tap.tappedAt).slice(-24);
    const ma = c.filter((k) => k.time >= tap.tappedAt), mb = c.filter((k) => k.time < tap.tappedAt).slice(-24);
    if (pa.length && pb.length && ma.length && mb.length) {
      const weTook = bull ? Math.min(...ma.map((k) => k.low)) < Math.min(...mb.map((k) => k.low)) : Math.max(...ma.map((k) => k.high)) > Math.max(...mb.map((k) => k.high));
      const theyTook = bull ? Math.min(...pa.map((k) => k.low)) < Math.min(...pb.map((k) => k.low)) : Math.max(...pa.map((k) => k.high)) > Math.max(...pb.map((k) => k.high));
      smt = weTook && !theyTook;
    }
    if (smt === false) return null;
  }
  // order-block confirmation: close beyond the last pivot
  const sw = swings(c.slice(0, -1), 2);
  const pivot = (bull ? sw.highs : sw.lows).at(-1);
  const k = c.at(-1);
  if (!pivot || (bull ? k.close <= pivot.price : k.close >= pivot.price)) return null;
  const between = c.filter((x) => x.time >= tap.tappedAt);
  const extreme = bull ? Math.min(...between.map((x) => x.low)) : Math.max(...between.map((x) => x.high));
  return {
    ...s,
    top: bull ? s.top : Math.max(s.top, extreme),
    bottom: bull ? Math.min(s.bottom, extreme) : s.bottom,
    swingStop: extreme,
    id: `forever:${g}:${s.id}`,
    htf: tap,
    smt,
    qualityReasons: [`tapped ${tap.tf} ${tap.type} FVG`, `IFVG ${sig(s.bottom)}-${sig(s.top)}`, smt ? 'SMT with the correlated market' : 'SMT n/a', `OB confirmation: close beyond pivot ${sig(pivot.price)}`],
  };
}

const ENTRY_TFS = { ict2022: [300, 60], unicorn: [300, 60], amd: [300], forever: [300, 60] };

/**
 * Scan one of the non-IFVG models. Same return shape as scanSetups:
 * { setup, candles, granularity, zones, note, waiting, liquidity }.
 */
export async function scanModel(model, market, settings, now = Date.now(), opts = {}) {
  const cache = new Map();
  const m = { getCandles: (g, n) => { if (!cache.has(g)) cache.set(g, market.getCandles(g, n)); return cache.get(g); }, getPrice: market.getPrice };
  const liquidity = await liquidityLevels(m, now).catch(() => null);
  const zones = await loadHtfZones(m, ['3m', '5m', '15m', '30m', '1h', '2h', '4h'], now);
  const notes = [];
  let first = null;
  for (const g of ENTRY_TFS[model] || []) {
    const cat = categoryOf(g);
    if (cat === 'swing' && settings.swingEnabled === false) continue;
    if (cat === 'scalp' && settings.scalpEnabled === false) continue;
    const c = closedCandles(await m.getCandles(g, 200), g, now);
    if (!first) first = { candles: c, granularity: g };
    let s = null;
    if (model === 'ict2022') s = ict2022(c, g);
    else if (model === 'unicorn') s = unicorn(c, g);
    else if (model === 'amd') s = amd(c, g, now);
    else if (model === 'forever') s = await forever(c, g, now, zones, opts.pairMarket);
    if (s) {
      const atr = atr14(c);
      return {
        setup: { ...s, granularity: g, category: cat, model, grade: s.grade || 'A', gapAtr: atr ? sig((s.top - s.bottom) / atr) : null },
        candles: c, granularity: g, zones, note: null, waiting: false, liquidity,
      };
    }
    notes.push(`${MODELS[model]?.name || model} ${tfLabel(g)}: no setup`);
  }
  return { setup: null, candles: first?.candles || [], granularity: first?.granularity || 300, zones, note: notes.join(' · '), waiting: false, liquidity };
}
