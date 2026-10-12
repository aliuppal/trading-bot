/**
 * Learning from past trades: a model's track record over the last N days (overall, per symbol, side, style,
 * session and Jev confidence) and the effect of settings changes approved earlier. Used by the daily
 * suggestions (with the web research) and passed to Jev so each decision sees how similar trades went.
 */

const DAY = 86400000;
const symOf = (t) => t.symbol || 'BTCUSDC';
const modelOf = (t) => t.model || 'ifvg';
const styleOf = (t) => (t.category === 'scalp' ? 'scalp' : 'swing');
const sideOf = (t) => (t.side === 'short' ? 'short' : 'long');
const CONF_BANDS = ['below 0.60', '0.60-0.69', '0.70-0.79', '0.80+'];
const confBand = (t) => { const c = t.confidence ?? 0; return c >= 0.8 ? '0.80+' : c >= 0.7 ? '0.70-0.79' : c >= 0.6 ? '0.60-0.69' : 'below 0.60'; };

/** UTC session of an entry time: Asia 00-07, London 07-12, New York 12-17, late 17-24. */
export function sessionOf(time) {
  const h = new Date(time).getUTCHours();
  return h < 7 ? 'Asia' : h < 12 ? 'London' : h < 17 ? 'New York' : 'late';
}

/** { n, wins, losses, winRate (0-1 or null), r } for a list of closed trades. */
export function stats(list) {
  const wins = list.filter((t) => t.status === 'win').length;
  const losses = list.filter((t) => t.status === 'loss').length;
  return { n: list.length, wins, losses, winRate: wins + losses ? wins / (wins + losses) : null, r: Number(list.reduce((x, t) => x + (t.r || 0), 0).toFixed(2)) };
}

const signedR = (r) => `${r >= 0 ? '+' : ''}${Number(r).toFixed(2)}R`;
const line = (label, st) => `${label}: ${st.n} trades, ${st.wins} wins${st.winRate == null ? '' : ` (${Math.round(st.winRate * 100)}%)`}, ${signedR(st.r)}`;

function groups(list, keyOf) {
  const g = {};
  for (const t of list) (g[keyOf(t)] ||= []).push(t);
  return Object.entries(g).map(([key, a]) => ({ key, ...stats(a), last: Math.max(...a.map((t) => Date.parse(t.entryTime))) })).sort((a, b) => b.n - a.n);
}

/** Closed trades of one model within the last `days` days. */
export function closedTrades(trades, { model, now = Date.now(), days = 14 } = {}) {
  const from = now - days * DAY;
  return trades.filter((t) => t.status !== 'open' && t.exitTime && Date.parse(t.entryTime) >= from && (!model || modelOf(t) === model));
}

/**
 * Track record of a model: { days, n, overall, bySymbol, bySide, byStyle, bySession, byConfidence, text }.
 * With `symbol`, side / type / session are for that symbol only. `text` is a compact summary for Jev and
 * the research prompt (empty when there are no closed trades).
 */
export function trackRecord(trades, { model, symbol, now = Date.now(), days = 14 } = {}) {
  const all = closedTrades(trades, { model, now, days });
  const mine = symbol ? all.filter((t) => symOf(t) === symbol) : all;
  const rec = {
    days,
    now,
    n: all.length,
    overall: stats(all),
    bySymbol: groups(all, symOf),
    bySide: groups(mine, sideOf),
    byStyle: groups(mine, styleOf),
    bySession: groups(mine, (t) => sessionOf(t.entryTime)),
    byConfidence: groups(all, confBand),
    text: '',
  };
  if (!all.length) return rec;
  const parts = [line(`last ${days} days, all symbols`, rec.overall)];
  if (symbol) parts.push(line(`this symbol (${symbol})`, stats(mine)));
  const sub = (label, g) => { if (g.length) parts.push(`${label}: ${g.map((x) => line(x.key, x)).join('; ')}`); };
  if (!symbol) sub('by symbol', rec.bySymbol);
  sub(symbol ? 'this symbol by side' : 'by side', rec.bySide);
  sub(symbol ? 'this symbol by type' : 'by type', rec.byStyle);
  sub(symbol ? 'this symbol by session (UTC)' : 'by session (UTC)', rec.bySession);
  sub('by Jev confidence', rec.byConfidence);
  rec.text = parts.join(' | ');
  return rec;
}

/**
 * Effect of settings changes approved earlier: closed trades of that model in the `days` before vs after
 * each approval. Returns [{ title, patch, before, after, text }] for approvals with trades on both sides.
 */
export function approvedEffects(suggestions, trades, { model, now = Date.now(), days = 14 } = {}) {
  return suggestions
    .filter((x) => x.status === 'approved' && x.decidedAt && x.patch && (!model || x.model === model))
    .map((x) => {
      const at = Date.parse(x.decidedAt);
      const mt = trades.filter((t) => t.status !== 'open' && t.exitTime && modelOf(t) === x.model);
      const when = (t) => Date.parse(t.entryTime);
      const before = stats(mt.filter((t) => when(t) < at && when(t) >= at - days * DAY));
      const after = stats(mt.filter((t) => when(t) >= at && when(t) <= now));
      return { title: x.title, patch: x.patch, before, after, text: `"${x.title}" ${JSON.stringify(x.patch)}: ${line('before', before)} -> ${line('after', after)}` };
    })
    .filter((e) => e.before.n && e.after.n)
    .slice(0, 5);
}

/**
 * Suggestions from experience (the whole track record, not one day): each { title, detail, patch }.
 * Only groups with enough trades count, so one bad day does not flip a setting.
 */
export function experienceSuggestions(rec, settings, { minTrades = 5 } = {}) {
  const out = [];
  if (rec.n < minTrades) return out;
  const sum = (gs, k) => gs.reduce((a, g) => a + g[k], 0);
  // Jev confidence: trades at a higher confidence did clearly better -> raise the minimum
  const cur = settings.minConfidence ?? 0.6;
  for (const [i, floor] of [[1, 0.6], [2, 0.7], [3, 0.8]]) {
    if (floor <= cur) continue;
    const lo = rec.byConfidence.filter((g) => CONF_BANDS.indexOf(g.key) < i);
    const hi = rec.byConfidence.filter((g) => CONF_BANDS.indexOf(g.key) >= i);
    const loN = sum(lo, 'n'), hiN = sum(hi, 'n'), loR = sum(lo, 'r'), hiR = sum(hi, 'r');
    if (loN >= 3 && hiN >= 3 && loR < 0 && hiR > 0) {
      out.push({ title: `Only take trades at ${floor.toFixed(2)}+ confidence`, detail: `Last ${rec.days} days: below ${floor.toFixed(2)} confidence ${loN} trades, ${signedR(loR)}; at ${floor.toFixed(2)}+ ${hiN} trades, ${signedR(hiR)}.`, patch: { minConfidence: floor } });
      break;
    }
  }
  // swing vs scalp
  const sw = rec.byStyle.find((g) => g.key === 'swing');
  const sc = rec.byStyle.find((g) => g.key === 'scalp');
  if (sc && sw && sc.n >= minTrades && sc.r < 0 && sw.r > 0) out.push({ title: 'Fewer scalps (track record)', detail: `Last ${rec.days} days: ${line('scalps', sc)}; ${line('swings', sw)}.`, patch: { maxScalpPerDay: Math.max(0, Math.floor((settings.maxScalpPerDay ?? 5) / 2)) } });
  if (sc && sw && sw.n >= minTrades && sw.r < 0 && sc.r > 0) out.push({ title: 'Fewer swings (track record)', detail: `Last ${rec.days} days: ${line('swings', sw)}; ${line('scalps', sc)}.`, patch: { maxSwingPerDay: Math.max(0, Math.floor((settings.maxSwingPerDay ?? 5) / 2)) } });
  // sessions: Asia + late clearly worse than London + New York
  const good = rec.bySession.filter((g) => g.key === 'London' || g.key === 'New York');
  const bad = rec.bySession.filter((g) => g.key === 'Asia' || g.key === 'late');
  const gN = sum(good, 'n'), bN = sum(bad, 'n'), gR = sum(good, 'r'), bR = sum(bad, 'r');
  if (!settings.sessionFilter && gN >= 3 && bN >= minTrades && bR < 0 && gR / gN > bR / bN + 0.2) {
    out.push({ title: 'Trade the London and New York opens only', detail: `Last ${rec.days} days: Asia + late hours ${bN} trades, ${signedR(bR)}; London + New York ${gN} trades, ${signedR(gR)}. The Session Filter keeps entries to 07:00-10:00 and 12:30-16:00 UTC.`, patch: { sessionFilter: true } });
  }
  // symbols that keep losing and still trade (last 3 days; information only: no per-symbol setting, Jev sees this record)
  const wr = rec.overall.winRate;
  for (const g of rec.bySymbol) {
    if (g.n >= minTrades && g.last >= rec.now - 3 * DAY && g.r <= -3 && g.winRate != null && wr != null && g.winRate < wr - 0.1) {
      out.push({ title: `${g.key} keeps losing`, detail: `Last ${rec.days} days: ${line(g.key, g)} against ${Math.round(wr * 100)}% overall. Jev sees this record before each ${g.key} trade.`, patch: null });
    }
  }
  return out.slice(0, 4);
}
