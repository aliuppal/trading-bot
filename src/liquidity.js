// Liquidity levels: where resting orders (stops) sit and price tends to be drawn to.
//
//   PDH / PDL   previous day high / low (UTC days)
//   DH / DL     today's high / low so far
//   PWH / PWL   previous week high / low (weeks start Monday, UTC)
//   EQH / EQL   equal highs / lows: 2+ swing points on 15m or 1h within 0.05% of each other, not yet taken
//   HTF H / L   recent 1h and 4h swing highs / lows not yet taken
//   LRLR        low-resistance liquidity run: 3+ stepped swing highs above price (each lower than the last)
//               or stepped swing lows below price (each higher than the last), none taken yet
//
// "Taken" (swept) means a later candle traded beyond the level.

/** Swing highs / lows: a candle whose high (low) is the extreme of `n` candles on each side. */
export function swings(candles, n = 2) {
  const highs = [], lows = [];
  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i];
    let hi = true, lo = true;
    for (let k = 1; k <= n; k++) {
      if (candles[i - k].high >= c.high || candles[i + k].high > c.high) hi = false;
      if (candles[i - k].low <= c.low || candles[i + k].low < c.low) lo = false;
    }
    if (hi) highs.push({ price: c.high, time: c.time, index: i });
    if (lo) lows.push({ price: c.low, time: c.time, index: i });
  }
  return { highs, lows };
}

/** Has any candle after `index` traded beyond the level (by more than tolPct %)? */
function swept(candles, index, price, side, tolPct = 0) {
  const lim = side === 'high' ? price * (1 + tolPct / 100) : price * (1 - tolPct / 100);
  for (let j = index + 1; j < candles.length; j++) {
    if (side === 'high' ? candles[j].high > lim : candles[j].low < lim) return true;
  }
  return false;
}

/** Clusters of 2+ untaken swing points within tolPct of each other. */
export function equalLevels(candles, points, side, tolPct = 0.05) {
  // an equal high a hair above the first one does not take it out
  const live = points.filter((p) => !swept(candles, p.index, p.price, side, tolPct));
  const out = [];
  const used = new Set();
  for (let i = 0; i < live.length; i++) {
    if (used.has(i)) continue;
    const group = [live[i]];
    for (let j = i + 1; j < live.length; j++) {
      if (!used.has(j) && (Math.abs(live[j].price - live[i].price) / live[i].price) * 100 <= tolPct) { group.push(live[j]); used.add(j); }
    }
    if (group.length >= 2) {
      const price = side === 'high' ? Math.max(...group.map((g) => g.price)) : Math.min(...group.map((g) => g.price));
      out.push({ price, touches: group.length });
    }
  }
  return out;
}

/** Stepped swing highs above price (descending) or lows below price (ascending), untaken: a low-resistance run. */
export function lrlr(candles, { highs, lows }, price, min = 3) {
  const run = (pts, side) => {
    const live = pts.filter((p) => !swept(candles, p.index, p.price, side)).slice(-8);
    let best = [];
    let cur = [];
    for (const p of live) {
      const ok = cur.length === 0 || (side === 'high' ? p.price < cur.at(-1).price : p.price > cur.at(-1).price);
      cur = ok ? [...cur, p] : [p];
      if (cur.length > best.length) best = cur;
    }
    const valid = best.length >= min && best.every((p) => (side === 'high' ? p.price > price : p.price < price));
    return valid ? best.map((p) => p.price) : null;
  };
  const above = run(highs, 'high');
  const below = run(lows, 'low');
  if (above) return { side: 'above', prices: above, target: Math.max(...above) };
  if (below) return { side: 'below', prices: below, target: Math.min(...below) };
  return null;
}

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
function weekKey(t) {
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7))).toISOString().slice(0, 10);
}

/**
 * All liquidity levels around the current price.
 * Returns { price, levels: [{ type, label, price, side: 'above'|'below', distPct }], above, below, lrlr, draw }
 * where above / below are the levels sorted nearest first, and draw is the side with the nearest major liquidity.
 */
export async function liquidityLevels(market, now = Date.now()) {
  const [daily, h1, m15, h4] = await Promise.all([
    market.getCandles(86400, 30), market.getCandles(3600, 300), market.getCandles(900, 200), market.getCandles(14400, 100),
  ]);
  const price = m15.at(-1)?.close ?? h1.at(-1)?.close;
  if (!price) return { price: null, levels: [], above: [], below: [], lrlr: null, draw: null };
  const levels = [];
  const add = (type, label, p) => { if (Number.isFinite(p)) levels.push({ type, label, price: Number(p.toFixed(2)) }); };

  const today = dayKey(now);
  const days = daily.filter((c) => dayKey(c.time) < today);
  const prev = days.at(-1);
  if (prev) { add('PDH', 'Previous day high', prev.high); add('PDL', 'Previous day low', prev.low); }
  const todays = h1.filter((c) => dayKey(c.time) === today);
  if (todays.length) {
    add('DH', "Today's high", Math.max(...todays.map((c) => c.high)));
    add('DL', "Today's low", Math.min(...todays.map((c) => c.low)));
  }
  const thisWeek = weekKey(now);
  const lastWeek = days.filter((c) => weekKey(c.time) < thisWeek);
  const lw = lastWeek.filter((c) => weekKey(c.time) === weekKey(lastWeek.at(-1)?.time ?? 0));
  if (lw.length) { add('PWH', 'Previous week high', Math.max(...lw.map((c) => c.high))); add('PWL', 'Previous week low', Math.min(...lw.map((c) => c.low))); }

  for (const [tf, c] of [['15m', m15], ['1h', h1]]) {
    const s = swings(c, 2);
    equalLevels(c, s.highs, 'high').forEach((e) => add('EQH', `Equal highs ${tf} (${e.touches}x)`, e.price));
    equalLevels(c, s.lows, 'low').forEach((e) => add('EQL', `Equal lows ${tf} (${e.touches}x)`, e.price));
  }
  for (const [tf, c] of [['1h', h1], ['4h', h4]]) {
    const s = swings(c, 3);
    s.highs.filter((p) => !swept(c, p.index, p.price, 'high')).slice(-3).forEach((p) => add('HTFH', `${tf} swing high`, p.price));
    s.lows.filter((p) => !swept(c, p.index, p.price, 'low')).slice(-3).forEach((p) => add('HTFL', `${tf} swing low`, p.price));
  }
  // LRLR only from the last 16 hours of 15m candles, and within 1.5% of price.
  const recent = m15.slice(-64);
  const sw = swings(recent, 2);
  const near = (p) => Math.abs(p.price - price) / price <= 0.015;
  const run = lrlr(recent, { highs: sw.highs.filter(near), lows: sw.lows.filter(near) }, price);

  // Merge levels within 0.02% of each other, keeping the most important name (e.g. "PDH+HTFH").
  const rank = ['PWH', 'PWL', 'PDH', 'PDL', 'EQH', 'EQL', 'DH', 'DL', 'HTFH', 'HTFL'];
  levels.sort((a, b) => rank.indexOf(a.type) - rank.indexOf(b.type));
  const merged = [];
  for (const l of levels) {
    const m = merged.find((x) => Math.abs(x.price - l.price) / l.price < 0.0002);
    if (!m) merged.push({ ...l });
    else if (!m.type.split('+').includes(l.type)) { m.type += `+${l.type}`; m.label += ` / ${l.label}`; }
  }
  levels.length = 0;
  levels.push(...merged);

  for (const l of levels) {
    l.side = l.price >= price ? 'above' : 'below';
    l.distPct = Number((((l.price - price) / price) * 100).toFixed(3));
  }
  const above = levels.filter((l) => l.side === 'above').sort((a, b) => a.price - b.price);
  const below = levels.filter((l) => l.side === 'below').sort((a, b) => b.price - a.price);
  // Draw on liquidity: an LRLR wins; otherwise the side whose nearest major level (PDH/PDL, PWH/PWL, EQH/EQL) is closer.
  const major = (arr) => arr.find((l) => ['PDH', 'PDL', 'PWH', 'PWL', 'EQH', 'EQL'].includes(l.type));
  let draw = run ? run.side : null;
  if (!draw) {
    const a = major(above), b = major(below);
    if (a && b) draw = Math.abs(a.distPct) <= Math.abs(b.distPct) ? 'above' : 'below';
    else draw = a ? 'above' : b ? 'below' : null;
  }
  return { price, levels, above, below, lrlr: run, draw };
}

/** Short text for Jev / reasons: nearest few levels on one side. */
export function describeLevels(list, n = 3) {
  return list.slice(0, n).map((l) => `${l.type} ${Math.round(l.price).toLocaleString('en-US')} (${l.distPct > 0 ? '+' : ''}${l.distPct}%)`).join(', ') || 'none';
}

/**
 * Liquidity-based target: the nearest liquidity in the trade direction (LRLR swing points, equal highs / lows,
 * PDH/PDL, today, previous week, HTF swings), placed frontPct % in front of the level so it fills as price
 * reaches it. Accepted between minR and maxR x risk. Returns { price, level, r } or null.
 */
export function liquidityTarget(liq, side, entry, risk, { minR = 0.75, maxR = 5, frontPct = 0.02 } = {}) {
  if (!liq || !risk) return null;
  const toward = side === 'long' ? 'above' : 'below';
  const cands = [...(side === 'long' ? liq.above : liq.below)];
  if (liq.lrlr?.side === toward) {
    for (const p of liq.lrlr.prices) cands.push({ type: 'LRLR', label: 'LRLR swing', price: p });
  }
  const ahead = cands
    .filter((l) => (side === 'long' ? l.price > entry : l.price < entry))
    .sort((x, y) => Math.abs(x.price - entry) - Math.abs(y.price - entry));
  for (const l of ahead) {
    const price = side === 'long' ? l.price * (1 - frontPct / 100) : l.price * (1 + frontPct / 100);
    const r = Math.abs(price - entry) / risk;
    if (r >= minR && r <= maxR) return { price: Number(price.toFixed(2)), level: l, r: Number(r.toFixed(2)) };
  }
  return null;
}
