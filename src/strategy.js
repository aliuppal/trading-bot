// Multi-timeframe IFVG setup scan, in two categories.
//
//   SWING  zone: active FVG on 30m / 1h / 2h / 4h      entry: IFVG on 15m > 5m > 3m
//            15m entries need a 1h / 2h / 4h tap; 5m entries a 30m / 1h / 2h / 4h tap; 3m entries a 30m / 1h tap.
//            A lower-timeframe IFVG waits while a higher entry timeframe has an IFVG forming in the same direction.
//   SCALP  zone: active FVG on 5m / 15m / 30m           entry: IFVG on 1m
//
// In both, bullish setups need a tap of a bullish FVG (demand) and bearish setups a bearish one (supply),
// and the entry IFVG must be confirmed on a closed candle, inverted within the last `ifvgMaxAge` candles (3-7).
import { activeFvgs, closedCandles, findHtfTap, formingIfvg, latestSetup } from './ifvg.js';

export const ENTRY_TIMEFRAMES = { all: [180, 300, 900], both: [300, 900], 180: [180], 300: [300], 900: [900] };
/** Which zone timeframes may trigger each entry timeframe. */
export const ZONES_FOR_ENTRY = {
  60: ['5m', '15m', '30m'], // scalp
  180: ['30m', '1h'],
  300: ['30m', '1h', '2h', '4h'],
  900: ['1h', '2h', '4h'],
};
const ZONE_TFS = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400 };
const TAP_WINDOW_MINUTES = { swing: 180, scalp: 60 }; // how recent the zone tap must be
export const tfLabel = (s) => (s >= 3600 ? `${s / 3600}h` : `${s / 60}m`);

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
async function evaluate(market, g, category, zones, settings, now) {
  const candles = await market.getCandles(g, 200);
  const r = { candles, note: null, setup: null };
  r.forming = { bullish: formingIfvg(candles, g, 'bullish', now), bearish: formingIfvg(candles, g, 'bearish', now) };
  const closed = closedCandles(candles, g, now);
  const s = latestSetup(closed, { maxAge: settings.ifvgMaxAge ?? 5 });
  const tag = `${category} ${tfLabel(g)}`;
  if (!s) { r.note = `${tag}: no fresh IFVG`; return r; }
  let htf = null;
  if (settings.requireHtfTap !== false) {
    const allowed = ZONES_FOR_ENTRY[g];
    const since = closed.at(-1).time - TAP_WINDOW_MINUTES[category] * 60000;
    htf = findHtfTap(closed.filter((c) => c.time >= since), zones.filter((z) => allowed.includes(z.tf)), s.direction);
    if (!htf) { r.note = `${tag}: ${s.direction} IFVG, no ${s.direction} ${allowed.join('/')} FVG tap`; return r; }
  }
  r.setup = { ...s, id: `${g}:${s.id}`, granularity: g, category, htf };
  return r;
}

/**
 * Scan for a setup: swing first (15m > 5m > 3m, waiting for a higher timeframe that is still forming),
 * then a 1m scalp. Returns { setup, candles, granularity, zones, note, waiting }; setup is null when nothing
 * qualifies (note says why). candles / granularity are for indicators and charts.
 */
export async function scanSetups(rawMarket, settings, now = Date.now()) {
  const market = cachedMarket(rawMarket);
  const needTap = settings.requireHtfTap !== false;
  const scalpOn = settings.scalpEnabled !== false;
  const zoneTfs = needTap ? [...new Set([...(scalpOn ? ['5m', '15m'] : []), '30m', '1h', '2h', '4h'])] : [];
  const zones = needTap ? await loadHtfZones(market, zoneTfs) : [];
  const notes = [];

  // Swing: highest entry timeframe first.
  const tfs = [...(ENTRY_TIMEFRAMES[String(settings.entryTimeframes ?? 'all')] || ENTRY_TIMEFRAMES.all)].sort((a, b) => b - a);
  const res = {};
  for (const g of tfs) res[g] = await evaluate(market, g, 'swing', zones, settings, now);
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

  // Scalp: 1m IFVG after a 5m / 15m / 30m FVG tap.
  if (scalpOn) {
    const r = await evaluate(market, 60, 'scalp', zones, settings, now);
    if (r.setup) return { setup: r.setup, candles: r.candles, granularity: 60, zones, note: null, waiting: false };
    if (r.note) notes.push(r.note);
  }

  const top = tfs[0];
  return { setup: null, candles: res[top].candles, granularity: top, zones, waiting: false, note: notes.join(' · ') };
}
