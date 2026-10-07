// Multi-timeframe IFVG setup scan.
//
//   1. Higher timeframe (HTF): active FVGs on 1h, 2h and 4h (2h / 4h are built from 1h candles).
//   2. Tap: price trades into an HTF FVG of the same direction
//        bullish setup -> bullish 1h/2h/4h FVG (demand), bearish setup -> bearish one (supply).
//   3. Entry: a fresh IFVG in that direction, inverted within the last `ifvgMaxAge` candles (3-7):
//        3m entries need a 1h FVG tap; 5m and 15m entries accept a 1h, 2h or 4h FVG tap.
import { aggregate, activeFvgs, closedCandles, findHtfTap, formingIfvg, latestSetup } from './ifvg.js';

export const ENTRY_TIMEFRAMES = { all: [180, 300, 900], both: [300, 900], 180: [180], 300: [300], 900: [900] };
/** Which HTF FVGs may trigger each entry timeframe. */
export const HTF_FOR_ENTRY = { 180: ['1h'], 300: ['1h', '2h', '4h'], 900: ['1h', '2h', '4h'] };
const TAP_WINDOW_MINUTES = 180; // the HTF tap must have happened in the last 3 hours
const tfLabel = (s) => (s >= 3600 ? `${s / 3600}h` : `${s / 60}m`);

/** Active (not closed-through) FVGs on 1h, 2h and 4h. */
export async function loadHtfZones(market) {
  const h1 = await market.getCandles(3600, 300);
  return [
    ...activeFvgs(h1, 3600, { label: '1h' }),
    ...activeFvgs(aggregate(h1, 7200), 7200, { label: '2h' }),
    ...activeFvgs(aggregate(h1, 14400), 14400, { label: '4h' }),
  ];
}

/**
 * Scan the entry timeframes and pick one, preferring the higher timeframe:
 *   - a confirmed 15m IFVG is taken first;
 *   - a confirmed 5m (or 3m) IFVG is taken only if no higher entry timeframe has an IFVG in the same
 *     direction still forming; otherwise the bot waits for that higher-timeframe entry.
 * IFVGs only count on closed candles. Returns { setup, candles, granularity, zones, note, waiting }:
 * setup is null when nothing qualifies (note says why); candles / granularity are for indicators and charts.
 */
export async function scanSetups(market, settings, now = Date.now()) {
  const tfs = [...(ENTRY_TIMEFRAMES[String(settings.entryTimeframes ?? 'all')] || ENTRY_TIMEFRAMES.all)].sort((a, b) => b - a);
  const needTap = settings.requireHtfTap !== false;
  const zones = needTap ? await loadHtfZones(market) : [];
  const res = {};
  for (const g of tfs) {
    const candles = await market.getCandles(g, 200);
    const r = { candles, note: null, setup: null };
    r.forming = { bullish: formingIfvg(candles, g, 'bullish', now), bearish: formingIfvg(candles, g, 'bearish', now) };
    const closed = closedCandles(candles, g, now);
    const s = latestSetup(closed, { maxAge: settings.ifvgMaxAge ?? 5 });
    if (!s) r.note = `${tfLabel(g)}: no fresh IFVG`;
    else if (needTap) {
      const since = closed.at(-1).time - TAP_WINDOW_MINUTES * 60000;
      const allowed = HTF_FOR_ENTRY[g] || ['1h', '2h', '4h'];
      const htf = findHtfTap(closed.filter((c) => c.time >= since), zones.filter((z) => allowed.includes(z.tf)), s.direction);
      if (htf) r.setup = { ...s, id: `${g}:${s.id}`, granularity: g, htf };
      else r.note = `${tfLabel(g)}: ${s.direction} IFVG, no ${s.direction} ${allowed.join('/')} FVG tap`;
    } else {
      r.setup = { ...s, id: `${g}:${s.id}`, granularity: g, htf: null };
    }
    res[g] = r;
  }

  for (const [i, g] of tfs.entries()) {
    const { setup, candles } = res[g];
    if (!setup) continue;
    const higher = tfs.slice(0, i).find((h) => res[h].forming[setup.direction]);
    if (higher) {
      return {
        setup: null, waiting: true, candles, granularity: g, zones,
        note: `${tfLabel(g)} ${setup.direction} IFVG ready, waiting for the ${tfLabel(higher)} IFVG forming now`,
      };
    }
    return { setup, candles, granularity: g, zones, note: null, waiting: false };
  }
  const top = tfs[0];
  return { setup: null, candles: res[top].candles, granularity: top, zones, waiting: false, note: tfs.map((g) => res[g].note).filter(Boolean).join(' · ') };
}
