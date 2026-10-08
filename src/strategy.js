// Multi-timeframe IFVG setup scan, in two categories.
//
//   SWING  zone: active FVG on 30m / 1h / 2h / 4h      entry: IFVG on 15m > 5m > 3m
//            15m entries need a 1h / 2h / 4h tap; 5m entries a 30m / 1h / 2h / 4h tap; 3m entries a 30m / 1h tap.
//            A lower-timeframe IFVG waits while a higher entry timeframe has an IFVG forming in the same direction.
//   SCALP  zone: active FVG on 5m / 15m / 30m           entry: IFVG on 1m
//
// In both, bullish setups need a first tap of an unmitigated bullish FVG (demand) and bearish setups a bearish one (supply),
// OR a liquidity sweep: an ITL raided before a long, an ITH raided before a short (on 15m for swings, 5m for scalps),
// and the entry IFVG must be confirmed on a closed candle: gap formed -> inverted within `ifvgMaxAge` candles (3-7),
// entry within 2 candles of the inversion.
import { activeFvgs, closedCandles, findHtfTap, formingIfvg, latestSetup, minGapFor } from './ifvg.js';
import { liquidityLevels, findSweep } from './liquidity.js';

/**
 * Setup grade.
 *   A+  perfect IFVG (gap -> inversion in <= 5 candles) + displacement candle + draw on liquidity in the trade
 *       direction (an LRLR that way adds to it). Tradeable even without a higher-timeframe FVG tap.
 *   A+  also: context (unmitigated FVG tap or ITH/ITL sweep) + displacement + LRLR in the trade direction.
 *   A   the normal setup: IFVG after a tap of a same-direction higher-timeframe FVG or an ITH/ITL sweep.
 */
/**
 * Opposing 3m/5m/15m FVGs between entry and target: for a long, active bearish FVGs (resistance) in the way up;
 * for a short, active bullish FVGs (support) in the way down. Returns the blocking zones.
 */
export function pathBlockers(zones, side, entry, target, tfs = ['3m', '5m', '15m']) {
  const lo = Math.min(entry, target), hi = Math.max(entry, target);
  const type = side === 'long' ? 'bearish' : 'bullish';
  return zones.filter((z) => tfs.includes(z.tf) && z.type === type && z.top > lo && z.bottom < hi);
}

export function gradeSetup(s, liquidity, context = false) {
  const toward = s.direction === 'bullish' ? 'above' : 'below';
  const perfect = s.formationCandles != null && s.formationCandles <= 5;
  const reasons = [];
  if (perfect) reasons.push(`perfect IFVG (${s.formationCandles} candles)`);
  if (s.displacement) reasons.push('displacement');
  const draw = liquidity?.draw === toward;
  if (draw) reasons.push(`draw on liquidity ${toward}`);
  if (liquidity?.lrlr?.side === toward) reasons.push(`LRLR ${toward}`);
  const next = (toward === 'above' ? liquidity?.above : liquidity?.below)?.[0];
  if (draw && next) reasons.push(`-> ${next.type} ${Math.round(next.price).toLocaleString('en-US')}`);
  const lrlr = liquidity?.lrlr?.side === toward;
  return { grade: s.displacement && ((perfect && draw) || (context && lrlr)) ? 'A+' : 'A', qualityReasons: reasons };
}

// Swing entries (15m preferred over 5m). Scalp entries are SCALP_TIMEFRAMES.
export const ENTRY_TIMEFRAMES = { all: [300, 900], both: [300, 900], 300: [300], 900: [900] };
/** Scalp entries, higher timeframe preferred: 3m > 2m > 1m. */
export const SCALP_TIMEFRAMES = [180, 120, 60];
/** Which zone timeframes may trigger each entry timeframe. */
export const ZONES_FOR_ENTRY = {
  60: ['5m', '15m', '30m'], // scalp entries
  120: ['5m', '15m', '30m'],
  180: ['5m', '15m', '30m'],
  300: ['30m', '1h', '2h', '4h'],
  900: ['1h', '2h', '4h'],
};
const ZONE_TFS = { '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400 };
const TAP_WINDOW_MINUTES = { swing: 180, scalp: 60 }; // how recent the zone tap / liquidity sweep must be
/** Timeframe whose intermediate-term highs / lows are swept before an entry. */
const SWEEP_TF = { swing: 900, scalp: 300 };
export const tfLabel = (s) => (s >= 3600 ? `${s / 3600}h` : `${s / 60}m`);

/** ATR(14) of the candles. */
export function atr14(c) {
  if (c.length < 15) return null;
  let s = 0;
  for (let i = c.length - 14; i < c.length; i++) s += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  return s / 14;
}

/** Did the pair simply trade through its recent low (bullish) / high (bearish) in the window (no clean sweep but still taken)? */
function tookOut(c, direction, since) {
  const before = c.filter((x) => x.time < since).slice(-24);
  const after = c.filter((x) => x.time >= since);
  if (!before.length || !after.length) return false;
  return direction === 'bullish' ? Math.min(...after.map((x) => x.low)) < Math.min(...before.map((x) => x.low))
    : Math.max(...after.map((x) => x.high)) > Math.max(...before.map((x) => x.high));
}

/**
 * 4h bias from structure: the direction of the last 4h close beyond a 4h swing high (bullish) or swing low (bearish).
 * Information for Jev only (not a filter).
 */
export async function htfBias(market) {
  const c = await market.getCandles(14400, 120);
  if (!c?.length || c.length < 20) return null;
  let bias = null;
  for (let i = 4; i < c.length; i++) {
    const past = c.slice(0, i - 2);
    const sw = swingsOf(past);
    const lastHigh = sw.highs.at(-1), lastLow = sw.lows.at(-1);
    if (lastHigh && c[i].close > lastHigh) bias = 'bullish';
    else if (lastLow && c[i].close < lastLow) bias = 'bearish';
  }
  return bias;
}
function swingsOf(c, n = 2) {
  const highs = [], lows = [];
  for (let i = n; i < c.length - n; i++) {
    let hi = true, lo = true;
    for (let k = 1; k <= n; k++) {
      if (c[i - k].high >= c[i].high || c[i + k].high > c[i].high) hi = false;
      if (c[i - k].low <= c[i].low || c[i + k].low < c[i].low) lo = false;
    }
    if (hi) highs.push(c[i].high);
    if (lo) lows.push(c[i].low);
  }
  return { highs, lows };
}

/** London open 07:00-10:00 UTC and New York open / morning 12:30-16:00 UTC. */
export function inSession(t) {
  const d = new Date(t);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (m >= 420 && m < 600) || (m >= 750 && m < 960);
}

/** Caches candles for one scan so each timeframe is fetched once. */
function cachedMarket(market) {
  const cache = new Map();
  return { getCandles: (g, n) => { if (!cache.has(g)) cache.set(g, market.getCandles(g, n)); return cache.get(g); } };
}

/** Active (not closed-through) FVGs on the given zone timeframes (default: all of 5m-4h). */
export async function loadHtfZones(market, tfs = Object.keys(ZONE_TFS)) {
  const out = [];
  for (const tf of tfs) {
    const s = ZONE_TFS[tf];
    out.push(...activeFvgs(await market.getCandles(s, 300), s, { label: tf }));
  }
  return out;
}

/** Evaluate one entry timeframe: confirmed IFVG + tap of an allowed zone, and what is forming right now. */
async function evaluate(market, g, category, zones, settings, now, liquidity, opts = {}) {
  const candles = await market.getCandles(g, 200);
  const r = { candles, note: null, setup: null };
  const lookback = settings.ifvgMaxAge ?? 7;
  r.forming = { bullish: formingIfvg(candles, g, 'bullish', now, { lookback, minGapPct: minGapFor(g) }), bearish: formingIfvg(candles, g, 'bearish', now, { lookback, minGapPct: minGapFor(g) }) };
  const closed = closedCandles(candles, g, now);
  const formation = settings.ifvgMaxAge ?? 7; // gap formed -> inverted within 3-7 candles
  const s = latestSetup(closed, { maxAge: 2, maxGapAge: formation, minGapPct: minGapFor(g), displacement: settings.requireDisplacement === true });
  const tag = `${category} ${tfLabel(g)}`;
  if (!s) { r.note = `${tag}: no fresh IFVG`; return r; }
  let htf = null;
  let sweep = null;
  const allowed = ZONES_FOR_ENTRY[g];
  const since = closed.at(-1).time - TAP_WINDOW_MINUTES[category] * 60000;
  if (settings.requireHtfTap !== false) {
    // first touch of an unmitigated same-direction FVG
    htf = findHtfTap(closed.filter((c) => c.time >= since), zones.filter((z) => allowed.includes(z.tf)), s.direction);
  }
  // or a raid of intermediate-term liquidity: ITL before a long, ITH before a short
  const sweepTf = SWEEP_TF[category];
  sweep = findSweep(closedCandles(await market.getCandles(sweepTf, 200), sweepTf, now), s.direction, since);
  if (sweep) sweep = { ...sweep, tf: tfLabel(sweepTf) };
  // SMT: the correlated market (BTC <-> ETH) did NOT take the same liquidity
  let smt = null;
  if (sweep && opts.pairMarket) {
    const pair = closedCandles(await opts.pairMarket.getCandles(sweepTf, 200), sweepTf, now);
    smt = pair.length > 20 ? !findSweep(pair, s.direction, since) && !tookOut(pair, s.direction, since) : null;
  }
  const quality = gradeSetup(s, liquidity, Boolean(htf || sweep));
  if (sweep) quality.qualityReasons.unshift(`swept ${sweep.tf} ${sweep.type} ${Number(sweep.price.toPrecision(6))}${smt ? ' with SMT' : ''}`);
  const atr = atr14(closed);
  const gapAtr = atr ? Number(((s.top - s.bottom) / atr).toFixed(2)) : null;
  if (settings.minGapAtr > 0 && gapAtr !== null && gapAtr < settings.minGapAtr) {
    r.note = `${tag}: ${s.direction} IFVG gap ${gapAtr}x ATR, below ${settings.minGapAtr}x`;
    return r;
  }
  if (settings.requireSweep && !sweep) { r.note = `${tag}: ${s.direction} IFVG, no ${s.direction === 'bullish' ? 'ITL' : 'ITH'} sweep before it`; return r; }
  if (settings.smt === 'require' && sweep && smt === false) { r.note = `${tag}: ${s.direction} IFVG after a sweep, but no SMT (pair swept too)`; return r; }
  // recent swing high (short) / low (long) around the setup: the swing stop level
  const from = Math.max(0, (s.formedIndex ?? closed.length - 8) - 5);
  const win = closed.slice(from);
  const swingStop = s.direction === 'bearish' ? Math.max(...win.map((c) => c.high)) : Math.min(...win.map((c) => c.low));
  // A+ (perfect IFVG + displacement + toward liquidity) is tradeable without either.
  if (settings.requireHtfTap !== false && !htf && !sweep && quality.grade !== 'A+') {
    r.note = `${tag}: ${s.direction} IFVG, no unmitigated ${allowed.join('/')} FVG tap and no ${s.direction === 'bullish' ? 'ITL' : 'ITH'} sweep`;
    return r;
  }
  r.setup = { ...s, id: `${g}:${s.id}`, granularity: g, category, htf, sweep, smt, gapAtr, swingStop, ...quality };
  return r;
}

/**
 * Scan for a setup: swing first (15m > 5m > 3m, waiting for a higher timeframe that is still forming),
 * then a 1m scalp. Returns { setup, candles, granularity, zones, note, waiting }; setup is null when nothing
 * qualifies (note says why). candles / granularity are for indicators and charts.
 */
export async function scanSetups(rawMarket, settings, now = Date.now(), opts = {}) {
  const market = cachedMarket(rawMarket);
  const liquidity = opts.liquidity !== undefined ? opts.liquidity : await liquidityLevels(market, now).catch(() => null);
  const pairMarket = opts.pairMarket ? cachedMarket(opts.pairMarket) : null;
  const bias = await htfBias(market).catch(() => null);
  const res0 = await scanCore(market, settings, now, liquidity, { pairMarket, bias });
  if (res0.setup) res0.setup = { ...res0.setup, bias, withBias: bias ? bias === res0.setup.direction : null };
  return { ...res0, liquidity };
}

async function scanCore(market, settings, now, liquidity, opts = {}) {
  const needTap = settings.requireHtfTap !== false;
  const scalpOn = settings.scalpEnabled !== false;
  const swingOn = settings.swingEnabled !== false;
  // 3m/5m/15m zones are always loaded too: they are checked for gaps in the path to the target.
  const zoneTfs = [...new Set(['3m', '5m', '15m', ...(needTap ? [...(scalpOn ? ['30m'] : []), ...(swingOn ? ['30m', '1h', '2h', '4h'] : [])] : [])])];
  const zones = await loadHtfZones(market, zoneTfs);
  const notes = [];

  // Swing: highest entry timeframe first.
  const tfs = swingOn ? [...(ENTRY_TIMEFRAMES[String(settings.entryTimeframes ?? 'all')] || ENTRY_TIMEFRAMES.all)].sort((a, b) => b - a) : [];
  const res = {};
  for (const g of tfs) res[g] = await evaluate(market, g, 'swing', zones, settings, now, liquidity, opts);
  let waiting = null;
  for (const [i, g] of tfs.entries()) {
    const { setup, candles } = res[g];
    if (!setup) continue;
    const higher = tfs.slice(0, i).find((h) => res[h].forming[setup.direction]);
    if (higher) {
      waiting = { candles, granularity: g, note: `swing ${tfLabel(g)} ${setup.direction} IFVG ready, waiting for the ${tfLabel(higher)} IFVG forming now` };
      break;
    }
    return { setup, candles, granularity: g, zones, note: null, waiting: false };
  }
  if (waiting) return { setup: null, waiting: true, zones, ...waiting };
  notes.push(...tfs.map((g) => res[g].note).filter(Boolean));

  // Scalp: 3m > 2m > 1m IFVG after a 5m / 15m / 30m FVG tap; a lower timeframe waits while a higher one is forming.
  if (scalpOn) {
    const sres = {};
    for (const g of SCALP_TIMEFRAMES) sres[g] = await evaluate(market, g, 'scalp', zones, settings, now, liquidity, opts);
    for (const [i, g] of SCALP_TIMEFRAMES.entries()) {
      const { setup, candles } = sres[g];
      if (!setup) continue;
      const higher = SCALP_TIMEFRAMES.slice(0, i).find((h) => sres[h].forming[setup.direction]);
      if (higher) return { setup: null, waiting: true, zones, candles, granularity: g, note: `scalp ${tfLabel(g)} ${setup.direction} IFVG ready, waiting for the ${tfLabel(higher)} IFVG forming now` };
      return { setup, candles, granularity: g, zones, note: null, waiting: false };
    }
    notes.push(...SCALP_TIMEFRAMES.map((g) => sres[g].note).filter(Boolean));
  }

  const top = tfs[0] ?? 60;
  const candles = res[top]?.candles ?? (await market.getCandles(top, 200));
  return { setup: null, candles, granularity: top, zones, waiting: false, note: notes.join(' · ') };
}
