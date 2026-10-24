// IFVG Strategy v2 detectors (section 3 of the mentor-aligned spec). Pure functions on candles and setups.
// Phase 1: they only feed the setup log (grade v2, premium / discount, SMT, chop, singular, pool swept, killzone);
// nothing here changes which trades are taken.
//
//   killzoneOf        New York killzone of a time: Asia 20:00-00:00, London 02:00-05:00, NY AM 09:30-11:00, NY PM 13:30-16:00
//   sessionPools      session highs / lows (last 2 completed windows of each) + PDH/PDL + PWH/PWL, with the time each formed
//   findPoolSweep     a wick beyond a pool on the far side of the entry, body close back inside within 3 candles
//   ceRespected       no candle body closed beyond the HTF gap's CE (midpoint) since the first touch
//   singularFvg       one FVG in the inversion leg, or 2-3 that form one FVG on the next timeframe up
//   chopCount         candles closing inside the inverted FVG before the inversion close
//   inversionSpeed    entry candles from the sweep / tap to the inversion close
//   premiumDiscount   where the context price sits in the 4h dealing range (0% = range low, 100% = range high)
//   smtState          'for' | 'against' | 'none' against the reference symbol over the same window
//   gradeV2           A+ / A / B / C from the above (3.6)
import { findFvgs, minGapFor } from './ifvg.js';
import { swings } from './liquidity.js';

const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** New York calendar date (YYYY-MM-DD) and minute of the day, daylight saving included. */
export function nyTime(t) {
  const p = Object.fromEntries(NY.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

/** Killzones in New York minutes of the day, [start, end). */
export const KILLZONES = { Asia: [1200, 1440], London: [120, 300], 'NY AM': [570, 660], 'NY PM': [810, 960] };

/** Name of the killzone `t` falls in, or null. */
export function killzoneOf(t) {
  const { minute } = nyTime(t);
  return Object.keys(KILLZONES).find((k) => minute >= KILLZONES[k][0] && minute < KILLZONES[k][1]) || null;
}

/** The killzone test (3.7): A setups only in London, NY AM or NY PM. */
export const inTradingKillzone = (t) => ['London', 'NY AM', 'NY PM'].includes(killzoneOf(t));

const POOL_CODE = { Asia: 'ASIA', London: 'LON', 'NY AM': 'NYAM', 'NY PM': 'NYPM' };
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
function weekStart(t) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
}

/**
 * Liquidity pools a sweep can take (3.1). intraday: oldest-first candles of 30m or less (15m is enough for the 09:30
 * boundary); daily: daily candles (UTC days, like the existing PDH / PDL). A session window counts once it has ended
 * (a later candle exists). Returns [{ type, side: 'high'|'low', price, formedAt }] where formedAt is when the pool
 * became complete: only raids after it count.
 */
export function sessionPools(intraday, daily = [], now = Date.now(), { seconds = 900, keep = 2 } = {}) {
  const closed = (intraday || []).filter((c) => c.time + seconds * 1000 <= now);
  const groups = new Map();
  for (const c of closed) {
    const { date, minute } = nyTime(c.time);
    const name = Object.keys(KILLZONES).find((k) => minute >= KILLZONES[k][0] && minute < KILLZONES[k][1]);
    if (!name) continue;
    const key = `${name}|${date}`;
    const g = groups.get(key) || { name, high: -Infinity, low: Infinity, last: 0 };
    g.high = Math.max(g.high, c.high);
    g.low = Math.min(g.low, c.low);
    g.last = Math.max(g.last, c.time);
    groups.set(key, g);
  }
  const lastTime = closed.length ? closed.at(-1).time : 0;
  const out = [];
  for (const name of Object.keys(KILLZONES)) {
    // complete = the series has a candle after the window (the window is over)
    const done = [...groups.values()].filter((g) => g.name === name && g.last < lastTime).sort((a, b) => b.last - a.last).slice(0, keep);
    for (const g of done) {
      const formedAt = g.last + seconds * 1000;
      out.push({ type: `${POOL_CODE[name]}_H`, side: 'high', price: g.high, formedAt });
      out.push({ type: `${POOL_CODE[name]}_L`, side: 'low', price: g.low, formedAt });
    }
  }
  const today = dayKey(now);
  const days = (daily || []).filter((c) => dayKey(c.time) < today);
  const prev = days.at(-1);
  const todayStart = Date.parse(`${today}T00:00:00Z`);
  if (prev) out.push({ type: 'PDH', side: 'high', price: prev.high, formedAt: todayStart }, { type: 'PDL', side: 'low', price: prev.low, formedAt: todayStart });
  const wk = weekStart(now);
  const lastWeek = days.filter((c) => c.time < wk && c.time >= wk - 7 * 86400000);
  if (lastWeek.length) {
    out.push({ type: 'PWH', side: 'high', price: Math.max(...lastWeek.map((c) => c.high)), formedAt: wk });
    out.push({ type: 'PWL', side: 'low', price: Math.min(...lastWeek.map((c) => c.low)), formedAt: wk });
  }
  return out;
}

/**
 * Sweep of a pool (3.1) before an entry: the first candle after the pool formed that traded beyond it (a low pool for
 * a long, a high pool for a short, on the far side of the entry), at or after `since`, with a body close back inside
 * within 3 candles and no later close beyond it (that would be a break). Same rule as the ITH / ITL sweep.
 * Returns the latest { type, price, sweptAt } or null.
 */
export function findPoolSweep(candles, direction, since, pools, { entry = null } = {}) {
  if (!candles?.length || !pools?.length) return null;
  const bull = direction === 'bullish';
  let best = null;
  for (const p of pools) {
    if (p.side !== (bull ? 'low' : 'high')) continue;
    if (entry != null && (bull ? p.price >= entry : p.price <= entry)) continue;
    for (let j = 0; j < candles.length; j++) {
      const c = candles[j];
      if (c.time < p.formedAt) continue;
      if (!(bull ? c.low < p.price : c.high > p.price)) continue;
      if (c.time >= since) {
        let back = -1;
        for (let k = j; k < Math.min(candles.length, j + 4); k++) if (bull ? candles[k].close > p.price : candles[k].close < p.price) { back = k; break; }
        const broke = back >= 0 && candles.slice(back + 1).some((x) => (bull ? x.close < p.price : x.close > p.price));
        if (back >= 0 && !broke && (!best || c.time > best.sweptAt)) best = { type: p.type, price: p.price, sweptAt: c.time };
      }
      break; // the first raid of the pool decides
    }
  }
  return best;
}

/**
 * HTF delivery check for A+ (3.2): since the first touch, no closed candle of the gap's own timeframe has a body close
 * beyond its CE (below it for a bullish gap, above it for a bearish one). zone: { type, top, bottom, tappedAt }.
 * Returns { ok, ce } (ok is true when no candle has closed since the touch yet).
 */
export function ceRespected(candles, zone, seconds, now = Date.now()) {
  const ce = (zone.top + zone.bottom) / 2;
  const since = (candles || []).filter((c) => c.time + seconds * 1000 > zone.tappedAt && c.time + seconds * 1000 <= now);
  const ok = since.every((c) => (zone.type === 'bullish' ? c.close >= ce : c.close <= ce));
  return { ok, ce };
}

/** Next timeframe up for the singular check (3.3), in seconds. */
export const NEXT_TF = { 60: 120, 120: 180, 180: 300, 300: 900, 900: 1800 };

/**
 * Singular FVG (3.3): one FVG in the inversion leg, or 2-3 that form a single FVG on the next timeframe up.
 * setup: { direction, seriesFvgs, seriesStart, formedIndex } from latestSetup; entry: the entry-timeframe candles the
 * setup was found on; higher: candles of NEXT_TF[seconds]. Returns { singular, merged, count }.
 */
export function singularFvg(setup, entry, seconds, higher) {
  const count = setup.seriesFvgs || 1;
  if (count <= 1) return { singular: true, merged: false, count };
  const hs = NEXT_TF[seconds];
  if (count > 3 || !hs || !higher?.length || !entry?.length) return { singular: false, merged: false, count };
  // the leg runs from the first candle of the first FVG to the third candle of the last one
  const from = entry[Math.max(0, (setup.seriesStart ?? setup.formedIndex) - 1)]?.time;
  const to = (entry[Math.min(entry.length - 1, setup.formedIndex + 1)]?.time ?? from) + seconds * 1000;
  const type = setup.direction === 'bullish' ? 'bearish' : 'bullish'; // the gaps that got inverted
  const over = findFvgs(higher, { minGapPct: minGapFor(hs) })
    .filter((f) => f.type === type && f.formedAt < to && f.formedAt + hs * 1000 > from);
  return { singular: over.length === 1, merged: over.length === 1, count };
}

/** Chop (3.3): candles that close inside the inverted FVG between the gap and the inversion close. */
export function chopCount(candles, setup) {
  let n = 0;
  for (let j = setup.formedIndex + 2; j < setup.invertedIndex; j++) {
    const c = candles[j];
    if (c && c.close >= setup.bottom && c.close <= setup.top) n++;
  }
  return n;
}

/** Speed (3.3): entry candles from the one holding the sweep / tap to the inversion close; null when unknown. */
export function inversionSpeed(candles, setup, contextTime) {
  if (contextTime == null) return null;
  let idx = -1;
  for (let i = 0; i < candles.length; i++) if (candles[i].time <= contextTime) idx = i;
  if (idx < 0) return null;
  return Math.max(0, setup.invertedIndex - idx);
}

/**
 * Premium / discount (3.4). Dealing range = the latest 4h swing high above and the latest 4h swing low below the
 * context price (the swept pool or the tapped gap's CE). Returns { high, low, pct, entryPct } (0 = range low,
 * 100 = range high) or null when either side has no swing.
 */
export function premiumDiscount(h4, contextPrice, entry) {
  if (!h4?.length || !Number.isFinite(contextPrice)) return null;
  const sw = swings(h4, 2);
  const high = [...sw.highs].reverse().find((p) => p.price > contextPrice)?.price;
  const low = [...sw.lows].reverse().find((p) => p.price < contextPrice)?.price;
  if (high == null || low == null || high <= low) return null;
  const at = (p) => Number((((p - low) / (high - low)) * 100).toFixed(1));
  return { high, low, pct: at(contextPrice), entryPct: Number.isFinite(entry) ? at(entry) : null };
}

/**
 * Which side of the range a setup is on: right = context in discount (< 50%) for a long, premium (> 50%) for a short;
 * tooFar = entry beyond the 75% line for a long / under the 25% line for a short (a C either way).
 */
export function pdSide(direction, pd) {
  if (!pd) return { side: 'unknown', tooFar: false };
  const bull = direction === 'bullish';
  const right = bull ? pd.pct < 50 : pd.pct > 50;
  const tooFar = pd.entryPct != null && (bull ? pd.entryPct > 75 : pd.entryPct < 25);
  return { side: right ? 'right' : 'wrong', tooFar };
}

/** SMT reference (3.5): ETH for BTC, BTC for every alt, none for gold / silver. */
export function smtReference(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (/^(XAU|XAG)/.test(s)) return null;
  if (s.startsWith('BTC')) return 'ETHUSDT';
  return 'BTCUSDC';
}

/**
 * SMT state (3.5) over the same window: for a long, did the symbol make a lower low since `since` (vs. the 24 candles
 * before it) while the reference did not ('for'), or the reference made it and the symbol held ('against')?
 * Shorts mirror it with higher highs. Returns 'for' | 'against' | 'none', or null without reference candles.
 */
export function smtState(sym, ref, direction, since) {
  if (!sym?.length || !ref?.length) return null;
  const bull = direction === 'bullish';
  const took = (c) => {
    const before = c.filter((x) => x.time < since).slice(-24);
    const after = c.filter((x) => x.time >= since);
    if (!before.length || !after.length) return null;
    return bull ? Math.min(...after.map((x) => x.low)) < Math.min(...before.map((x) => x.low))
      : Math.max(...after.map((x) => x.high)) > Math.max(...before.map((x) => x.high));
  };
  const a = took(sym), b = took(ref);
  if (a == null || b == null) return null;
  return a && !b ? 'for' : b && !a ? 'against' : 'none';
}

/**
 * Grade v2 (3.6).
 *   C   no clear target >= 1R, or wrong side of the range (or too far into it), or SMT against      -> skip
 *   A+  sweep of a pool AND HTF delivery (CE respected); displacement; singular; chop 0-1; inversion within 5 candles
 *   A   sweep OR HTF delivery; displacement; chop <= 3; inversion within 10 candles
 *   B   passes the scan but misses an A item (chop 4+ included)                                    -> log only
 * An SMT in the trade's direction lifts an A that misses A+ only on singular / chop (2-3) to A+.
 * f: { sweep, delivery, ce, displacement, singular, chop, speed, pd: pdSide(), smt, targetR }.
 * Returns { grade, missing: [why it is not A+] } (smtLift: what the SMT made up for).
 */
export function gradeV2(f) {
  const c = [];
  if (!(f.targetR >= 1)) c.push('no clear target 1R+ away');
  if (!f.pd || f.pd.side === 'unknown') c.push('premium/discount unknown');
  else if (f.pd.side !== 'right') c.push('wrong side of the range');
  if (f.pd?.tooFar) c.push('entry too far into premium/discount');
  if (f.smt === 'against') c.push('SMT against');
  if (c.length) return { grade: 'C', missing: c };
  const a = [];
  if (!f.sweep && !f.delivery) a.push('no sweep or HTF delivery');
  if (!f.displacement) a.push('no displacement');
  if (!(f.chop <= 3)) a.push(`chop ${f.chop}`);
  if (!(f.speed != null && f.speed <= 10)) a.push(`inversion ${f.speed ?? '?'} candles after context`);
  if (a.length) return { grade: 'B', missing: a };
  const plus = [];
  if (!f.sweep) plus.push('no pool sweep');
  if (!f.delivery) plus.push('no HTF delivery');
  else if (f.ce === false) plus.push('body closed beyond the HTF gap CE');
  if (!(f.speed <= 5)) plus.push(`inversion ${f.speed} candles after context`);
  const soft = [];
  if (!f.singular) soft.push('not singular');
  if (f.chop > 1) soft.push(`choppy (${f.chop})`);
  if (!plus.length && !soft.length) return { grade: 'A+', missing: [] };
  if (!plus.length && f.smt === 'for') return { grade: 'A+', missing: [], smtLift: soft };
  return { grade: 'A', missing: [...plus, ...soft] };
}
