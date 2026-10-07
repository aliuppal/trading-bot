const $ = (id) => document.getElementById(id);
const usd = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—'
  : `${v < 0 ? '-' : ''}$${Math.abs(Number(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const signedUsd = (v) => `${v >= 0 ? '+' : ''}${usd(v)}`;
const fmtTime = (t) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.className = ''), 4000);
}

let granularity = 3600;
let candles = [];
let ifvgs = [];
let htfZones = [];
let trades = [];
let status = null;

/* ---------------- chart ---------------- */

const RR_CANDLES = 8; // width of the risk/reward block, in candles

function drawChart() {
  const canvas = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = 320;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (candles.length < 2) return;

  const open = status?.openTrade;
  const pad = { l: 4, r: 72, t: 10, b: 20 };
  const extra = open ? [open.stop, open.target] : [];
  const lo = Math.min(...candles.map((c) => c.low), ...extra);
  const hi = Math.max(...candles.map((c) => c.high), ...extra);
  const t0 = candles[0].time;
  const idxAt = (t) => Math.max(0, Math.min(candles.length - 1, Math.floor((t - t0) / (granularity * 1000))));
  // Leave empty candle slots on the right so the open trade's risk/reward block is fully visible.
  const entryIdx = open ? idxAt(new Date(open.entryTime).getTime()) : null;
  // The block grows with the trade: from the entry to the latest candle (at least RR_CANDLES wide).
  const rrEnd = open ? Math.max(entryIdx + RR_CANDLES, candles.length + 1) : 0;
  const future = open ? Math.max(2, rrEnd + 2 - (candles.length - 1)) : 0;
  const step = (w - pad.l - pad.r) / (candles.length + future);
  const x = (i) => pad.l + step * (i + 0.5);
  const y = (p) => pad.t + (1 - (p - lo) / (hi - lo || 1)) * (h - pad.t - pad.b);
  const mono = "11px 'JetBrains Mono', ui-monospace, monospace";

  // grid + price labels
  ctx.strokeStyle = css('--border'); ctx.fillStyle = css('--dim'); ctx.font = mono; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const p = lo + ((hi - lo) * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y(p)); ctx.lineTo(w - pad.r, y(p)); ctx.stroke();
    ctx.fillText(Math.round(p).toLocaleString(), w - pad.r + 8, y(p) + 4);
  }

  // 1h / 2h / 4h FVG zones (full width, behind everything)
  htfZones.forEach((z) => {
    if (z.top < lo || z.bottom > hi) return;
    const bull = z.type === 'bullish';
    const x0 = z.readyAt > t0 ? x(idxAt(z.readyAt)) - step / 2 : pad.l;
    ctx.fillStyle = bull ? 'rgba(16, 185, 129, .07)' : 'rgba(244, 63, 94, .07)';
    ctx.fillRect(x0, y(z.top), w - pad.r - x0, Math.max(1, y(z.bottom) - y(z.top)));
    ctx.fillStyle = bull ? 'rgba(52, 211, 153, .75)' : 'rgba(251, 113, 133, .75)';
    ctx.fillText(`${z.tf} FVG`, x0 + 4, y(z.top) + 11);
  });

  // IFVG zones
  ifvgs.forEach((z) => {
    if (z.formedAt < t0) return;
    const bull = z.direction === 'bullish';
    const x0 = x(idxAt(z.formedAt)) - step / 2;
    const zh = Math.max(1, y(z.bottom) - y(z.top));
    ctx.fillStyle = bull ? 'rgba(6, 182, 212, .12)' : 'rgba(244, 63, 94, .08)';
    ctx.fillRect(x0, y(z.top), w - pad.r - x0, zh);
    ctx.strokeStyle = bull ? 'rgba(6, 182, 212, .5)' : 'rgba(244, 63, 94, .35)';
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(x0, y(z.top), w - pad.r - x0, zh);
    ctx.setLineDash([]);
  });

  // candles
  const cw = Math.max(1, step * 0.6);
  candles.forEach((c, i) => {
    ctx.strokeStyle = ctx.fillStyle = c.close >= c.open ? css('--green') : css('--red');
    ctx.beginPath(); ctx.moveTo(x(i), y(c.high)); ctx.lineTo(x(i), y(c.low)); ctx.stroke();
    const top = y(Math.max(c.open, c.close));
    ctx.fillRect(x(i) - cw / 2, top, cw, Math.max(1, y(Math.min(c.open, c.close)) - top));
  });

  // SMA20
  ctx.strokeStyle = css('--blue'); ctx.lineWidth = 1.5; ctx.beginPath();
  candles.forEach((c, i) => {
    if (i < 19) return;
    const avg = candles.slice(i - 19, i + 1).reduce((a, b) => a + b.close, 0) / 20;
    i === 19 ? ctx.moveTo(x(i), y(avg)) : ctx.lineTo(x(i), y(avg));
  });
  ctx.stroke();

  // open trade: risk/reward block from the entry to the latest candle (min RR_CANDLES wide)
  if (open) {
    const x0 = x(entryIdx) - step / 2;
    const x1 = x(rrEnd) + step / 2;
    const yIn = y(open.entryPrice);
    ctx.fillStyle = 'rgba(16, 185, 129, .18)'; // reward
    ctx.fillRect(x0, Math.min(yIn, y(open.target)), x1 - x0, Math.abs(y(open.target) - yIn));
    ctx.fillStyle = 'rgba(244, 63, 94, .18)'; // risk
    ctx.fillRect(x0, Math.min(yIn, y(open.stop)), x1 - x0, Math.abs(y(open.stop) - yIn));
    [[open.target, css('--green'), 'TP'], [open.entryPrice, css('--text-2'), 'IN'], [open.stop, css('--red'), 'SL']].forEach(([p, col, name]) => {
      ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.setLineDash(name === 'IN' ? [4, 3] : []);
      ctx.beginPath(); ctx.moveTo(x0, y(p)); ctx.lineTo(x1, y(p)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.fillText(name, x1 + 4, y(p) + 4);
    });
  }

  // trade markers: entries (triangles) and exits (rings)
  trades.forEach((t) => {
    const et = new Date(t.entryTime).getTime();
    if (et >= t0) {
      const px = x(idxAt(et));
      ctx.beginPath();
      if (t.side === 'short') { // red down-triangle above the entry
        const py = y(t.entryPrice) - 12;
        ctx.fillStyle = css('--red');
        ctx.moveTo(px, py + 7); ctx.lineTo(px - 5, py - 2); ctx.lineTo(px + 5, py - 2);
      } else { // green up-triangle below the entry
        const py = y(t.entryPrice) + 12;
        ctx.fillStyle = css('--green');
        ctx.moveTo(px, py - 7); ctx.lineTo(px - 5, py + 2); ctx.lineTo(px + 5, py + 2);
      }
      ctx.closePath(); ctx.fill();
    }
    if (t.exitTime && new Date(t.exitTime).getTime() >= t0) {
      ctx.strokeStyle = t.pnl >= 0 ? css('--green') : css('--red'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x(idxAt(new Date(t.exitTime).getTime())), y(t.exitPrice), 4, 0, Math.PI * 2); ctx.stroke();
    }
  });
}

function renderIndicators(ind) {
  const items = [
    ['RSI 14', ind.rsi_14],
    ['SMA 20', usd(ind.sma_20)],
    ['SMA 50', usd(ind.sma_50)],
    ['MACD hist', ind.macd?.histogram],
    ['BB upper', usd(ind.bollinger?.upper)],
    ['BB lower', usd(ind.bollinger?.lower)],
  ];
  $('indicators').innerHTML = items.map(([k, v]) => `<div><span>${k}</span>${esc(v ?? '—')}</div>`).join('');
  $('price').textContent = usd(ind.price);
  $('stripPrice').textContent = usd(ind.price);
  const ch = ind.change_24;
  $('change').innerHTML = ch === null ? '—' : `<span class="num ${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '+' : ''}${ch}%</span> last 24 candles`;
}

async function loadMarket() {
  const state = $('chartState');
  if (!candles.length) { state.className = 'chart-state'; state.textContent = 'Loading candles…'; }
  try {
    const data = await api(`/api/market?granularity=${granularity}`);
    candles = data.candles;
    ifvgs = data.ifvgs || [];
    htfZones = data.htfZones || [];
    renderIndicators(data.indicators);
    state.textContent = candles.length ? '' : 'No candle data returned for this timeframe.';
    drawChart();
  } catch (e) {
    state.className = 'chart-state error';
    state.textContent = `Couldn't load market data: ${e.message}. Retrying in a minute.`;
  }
}

/* ---------------- account / status ---------------- */

async function loadAccount() {
  try {
    const a = await api('/api/account');
    $('equity').textContent = usd(a.equity);
    $('cash').textContent = usd(a.cash);
    $('btc').textContent = a.shortBtc > 0 ? `-${Number(a.shortBtc).toFixed(6)}` : `${Number(a.btc).toFixed(6)}`;
    $('avgEntry').textContent = a.shortBtc > 0 ? `short from ${usd(a.shortEntry)}` : a.avgEntry ? `avg ${usd(a.avgEntry)} · worth ${usd(a.btc * a.price)}` : 'No open position';
    if (a.startingCash) {
      const pnl = a.equity - a.startingCash;
      const pct = (pnl / a.startingCash) * 100;
      const cls = pnl >= 0 ? 'up' : 'down';
      $('pnl').innerHTML = `<span class="num ${cls}">${signedUsd(pnl)} (${pct.toFixed(2)}%)</span>`;
      $('stripPnl').innerHTML = `<span class="${cls}">${signedUsd(pnl)}</span>`;
    } else {
      $('pnl').textContent = a.accountEquity ? `total account ${usd(a.accountEquity)}` : '';
    }
    $('resetBtn').style.display = a.broker === 'local' ? '' : 'none';
  } catch (e) { toast(`Account: ${e.message}`, true); }
}

function renderOpenTrade(t) {
  if (!t) return '';
  const price = candles.at(-1)?.close ?? t.entryPrice;
  const short = t.side === 'short';
  const pos = Math.min(100, Math.max(0, ((price - t.stop) / (t.target - t.stop)) * 100));
  const upnl = (short ? t.entryPrice - price : price - t.entryPrice) * t.qty;
  return `<div class="ot-head"><span><span class="pill OPEN">OPEN ${short ? 'SHORT' : 'LONG'}</span> ${fmtTime(t.entryTime)}</span>
      <span class="num ${upnl >= 0 ? 'up' : 'down'}">${signedUsd(upnl)}</span></div>
    <div class="ot-levels">
      <div><span>Stop</span><em class="down">${usd(t.stop)}</em></div>
      <div><span>Entry</span>${usd(t.entryPrice)}</div>
      <div><span>Target</span><em class="up">${usd(t.target)}</em></div>
    </div>
    <div class="ot-bar" title="Price between stop and target"><b style="left:${pos}%"></b></div>`;
}

let settingsLoaded = false;
async function loadStatus() {
  try {
    const s = await api('/api/status');
    status = s;
    $('aiBadge').textContent = `AI: ${s.ai}`;
    $('brokerBadge').textContent = `Broker: ${s.broker}`;
    $('ruleAi').textContent = `${s.ai.startsWith('jev') ? 'Jev' : s.ai.split(':')[0]}, auto-execute`;
    $('botDot').className = `dot${s.running ? ' on' : ''}`;
    $('botState').textContent = s.busy ? 'Thinking…' : s.running ? 'Running' : 'Stopped';
    $('startBtn').textContent = s.running ? 'Auto-trading on' : 'Start bot';
    const scan = s.lastScan?.note ? ` · ${s.lastScan.note}` : '';
    $('botTimes').textContent = `Last scan ${fmtTime(s.lastRun)}${s.nextRun ? ` · next ${fmtTime(s.nextRun)}` : ''}${scan}`;

    const max = s.settings.maxTradesPerDay ?? 10;
    $('tradesToday').textContent = `${s.tradesToday} / ${max}`;
    $('stripTrades').textContent = `${s.tradesToday}/${max}`;
    const track = $('meterTrack');
    track.className = `meter-track${s.tradesToday >= max ? ' full' : ''}`;
    track.style.gridTemplateColumns = `repeat(${Math.max(1, max)}, 1fr)`;
    track.innerHTML = Array.from({ length: Math.max(1, max) }, (_, i) => `<i class="${i < s.tradesToday ? 'used' : ''}"></i>`).join('');
    $('openTrade').innerHTML = renderOpenTrade(s.openTrade);

    if (!settingsLoaded) {
      const f = $('settingsForm');
      for (const [k, v] of Object.entries(s.settings)) if (f.elements[k]) f.elements[k].value = v;
      granularity = s.settings.granularity;
      setSegment(granularity);
      settingsLoaded = true;
      loadMarket();
    }
  } catch (e) { toast(`Status: ${e.message}`, true); }
}

/* ---------------- tables ---------------- */

function renderDecision(d) {
  if (!d) return '';
  return `<div class="decision-head"><span class="pill ${esc(d.action)}">${esc(d.action)}</span>
    <span class="num">${d.confidence !== undefined ? `conf ${esc(d.confidence)} · ` : ''}${fmtTime(d.time)}</span></div>
    ${d.reasoning ? `<p>${esc(d.reasoning)}</p>` : ''}
    <div class="sub">${esc(d.note || '')}${d.executed ? ' <span class="ok">✓ executed</span>' : ''}${d.aiError ? ` · AI error: ${esc(d.aiError)}` : ''}</div>`;
}

async function loadDecisions() {
  try {
    const decisions = await api('/api/decisions');
    const last = decisions[0];
    $('lastDecision').className = `decision ${esc(last?.action || '')}`;
    $('lastDecision').innerHTML = renderDecision(last);
    $('decisions').querySelector('tbody').innerHTML = decisions.map((d) => `<tr>
      <td class="t">${fmtTime(d.time)}</td><td class="r">${usd(d.price)}</td>
      <td><span class="pill ${esc(d.action)}">${esc(d.action)}</span></td>
      <td class="r">${d.confidence ?? '—'}</td>
      <td>${d.executed ? '<span class="ok">✓</span> ' : ''}${esc(d.note || '')}</td>
      <td class="reason">${esc(d.reasoning || '')}</td>
      <td class="src">${esc(d.source || '')}</td></tr>`).join('')
      || '<tr><td colspan="7" class="empty"><b>No AI decisions yet</b>The bot asks Jev when a fresh IFVG forms. Click "Ask AI now" to ask right away.</td></tr>';
  } catch (e) {
    $('decisions').querySelector('tbody').innerHTML = `<tr><td colspan="7" class="empty"><b>Couldn't load decisions</b>${esc(e.message)}</td></tr>`;
  }
}

async function loadOrders() {
  try {
    const orders = await api('/api/orders');
    $('orders').querySelector('tbody').innerHTML = orders.map((o) => `<tr>
      <td class="t">${fmtTime(o.time)}</td><td><span class="pill ${esc(o.side)}">${esc(o.side?.toUpperCase())}</span></td>
      <td class="r">${o.qty ? Number(o.qty).toFixed(6) : '—'}</td><td class="r">${usd(o.price)}</td><td class="r">${usd(o.notional)}</td>
      <td class="r">${o.pnl !== undefined ? `<span class="${o.pnl >= 0 ? 'up' : 'down'}">${signedUsd(o.pnl)}</span>` : '—'}</td>
      <td>${esc(o.status)}${o.reason ? ` · ${esc(o.reason)}` : ''}</td><td class="src">${esc(o.source)}</td></tr>`).join('')
      || '<tr><td colspan="8" class="empty"><b>No orders yet</b>Orders appear here when the bot or you trade.</td></tr>';
  } catch (e) {
    $('orders').querySelector('tbody').innerHTML = `<tr><td colspan="8" class="empty"><b>Couldn't load orders</b>${esc(e.message)}</td></tr>`;
  }
}

const shotCache = new Map(); // `${id}:${status}` -> Promise<{ entry, exit }>
function getShots(t) {
  const key = `${t.id}:${t.status}`;
  if (!shotCache.has(key)) shotCache.set(key, api(`/api/trades/${encodeURIComponent(t.id)}/shots`).catch(() => ({})));
  return shotCache.get(key);
}

// Snapshots are base64 data URIs (older ones may be raw SVG markup from our own server).
const shotHtml = (s, alt) => (!s ? '' : s.startsWith('data:image/') ? `<img src="${esc(s)}" alt="${esc(alt)}" loading="lazy">` : s);

const RESULT = { open: 'OPEN', win: 'WIN', loss: 'LOSS' };
async function loadTrades() {
  try {
    trades = await api('/api/trades');
    const closed = trades.filter((t) => t.status !== 'open');
    const wins = closed.filter((t) => t.status === 'win').length;
    $('tradeCount').textContent = trades.length ? ` ${trades.length}${closed.length ? ` · ${Math.round((wins / closed.length) * 100)}% win` : ''}` : '';
    const body = $('trades').querySelector('tbody');
    if (!trades.length) {
      body.innerHTML = '<tr><td colspan="11" class="empty"><b>No trades yet</b>When an IFVG forms and Jev agrees (BUY on bullish, SELL on bearish), the bot opens a 1:1 trade and saves a chart snapshot here.</td></tr>';
      drawChart();
      renderPnl();
      return;
    }
    body.innerHTML = trades.map((t, i) => `<tr>
      <td><button type="button" class="thumb" data-trade="${i}" aria-label="Open chart for trade at ${esc(fmtTime(t.entryTime))}"><span class="no-shot">…</span></button></td>
      <td class="t">${fmtTime(t.entryTime)}</td>
      <td><span class="pill ${t.side === 'short' ? 'SELL' : 'BUY'}">${t.side === 'short' ? 'SHORT' : 'LONG'}</span></td>
      <td><span class="pill ${RESULT[t.status] || ''}">${RESULT[t.status] || esc(String(t.status).toUpperCase())}</span></td>
      <td class="r">${usd(t.entryPrice)}</td><td class="r down">${usd(t.stop)}</td><td class="r up">${usd(t.target)}</td>
      <td class="r">${t.exitPrice ? usd(t.exitPrice) : '—'}</td>
      <td class="r">${t.r !== undefined ? `${t.r > 0 ? '+' : ''}${t.r}R` : '—'}</td>
      <td class="r">${t.pnl !== undefined ? `<span class="${t.pnl >= 0 ? 'up' : 'down'}">${signedUsd(t.pnl)}</span>` : '—'}</td>
      <td class="src">${esc(t.source || '')}</td></tr>`).join('');
    // thumbnails for the most recent trades
    trades.slice(0, 25).forEach(async (t, i) => {
      const shots = await getShots(t);
      const btn = body.querySelector(`[data-trade="${i}"]`);
      const svg = shots.exit || shots.entry;
      if (btn) btn.innerHTML = shotHtml(svg, 'Trade chart') || '<span class="no-shot">no chart</span>';
    });
    drawChart();
    renderPnl();
  } catch (e) {
    $('trades').querySelector('tbody').innerHTML = `<tr><td colspan="11" class="empty"><b>Couldn't load trades</b>${esc(e.message)}</td></tr>`;
  }
}

/* ---------------- P&L by day / week / month ---------------- */

let pnlPeriod = 'day';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** UTC period key for a timestamp: 2026-10-07 (day), Monday 2026-10-05 (week) or 2026-10 (month). */
function periodKey(t, p) {
  const d = new Date(t);
  if (p === 'month') return d.toISOString().slice(0, 7);
  if (p === 'week') {
    const back = (d.getUTCDay() + 6) % 7; // days since Monday
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

function periodLabel(key, p) {
  const [y, m, d] = key.split('-').map(Number);
  if (p === 'month') return `${MONTHS[m - 1]} ${y}`;
  if (p === 'week') return `Week of ${MONTHS[m - 1]} ${d}, ${y}`;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** Closed trades grouped by period, newest first, with long / short / total P&L. */
function pnlGroups(list, p) {
  const groups = new Map();
  for (const t of list) {
    if (!t.exitTime || t.pnl === undefined || t.pnl === null) continue;
    const k = periodKey(t.exitTime, p);
    const g = groups.get(k) || { key: k, trades: 0, wins: 0, losses: 0, long: 0, short: 0, total: 0, r: 0 };
    g.trades++;
    if (t.pnl >= 0) g.wins++; else g.losses++;
    g[t.side === 'short' ? 'short' : 'long'] += t.pnl;
    g.total += t.pnl;
    g.r += Number(t.r) || 0;
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
}

const pnlSpan = (v) => `<span class="${v >= 0 ? 'up' : 'down'}">${signedUsd(v)}</span>`;

function renderPnl() {
  const now = Date.now();
  const sum = (p) => pnlGroups(trades, p).find((g) => g.key === periodKey(now, p));
  const all = pnlGroups(trades, 'month').reduce((a, g) => ({
    total: a.total + g.total, trades: a.trades + g.trades, wins: a.wins + g.wins,
  }), { total: 0, trades: 0, wins: 0 });
  const tile = (label, g) => `<div><span>${label}</span><b class="${(g?.total ?? 0) >= 0 ? 'up' : 'down'}">${signedUsd(g?.total ?? 0)}</b>
    <small>${g ? `${g.trades} trade${g.trades === 1 ? '' : 's'} · L ${signedUsd(g.long ?? 0)} · S ${signedUsd(g.short ?? 0)}` : 'No closed trades'}</small></div>`;
  $('pnlSummary').innerHTML = tile('Today', sum('day')) + tile('This week', sum('week')) + tile('This month', sum('month'))
    + `<div><span>All time</span><b class="${all.total >= 0 ? 'up' : 'down'}">${signedUsd(all.total)}</b>
       <small>${all.trades ? `${all.trades} trades · ${Math.round((all.wins / all.trades) * 100)}% win` : 'No closed trades'}</small></div>`;

  const rows = pnlGroups(trades, pnlPeriod);
  const max = Math.max(1, ...rows.map((g) => Math.abs(g.total)));
  $('pnlTable').querySelector('tbody').innerHTML = rows.map((g) => `<tr>
      <td class="t">${periodLabel(g.key, pnlPeriod)}</td>
      <td class="r">${g.trades}</td>
      <td class="r">${pnlSpan(g.long)}</td>
      <td class="r">${pnlSpan(g.short)}</td>
      <td class="r">${g.wins} / ${g.losses}</td>
      <td class="r">${Math.round((g.wins / g.trades) * 100)}%</td>
      <td class="r">${g.r >= 0 ? '+' : ''}${g.r.toFixed(1)}R</td>
      <td><div class="pnl-cell"><div class="bar"><i class="${g.total >= 0 ? 'pos' : 'neg'}" style="width:${(Math.abs(g.total) / max) * 50}%"></i></div>${pnlSpan(g.total)}</div></td>
    </tr>`).join('')
    || '<tr><td colspan="8" class="empty"><b>No closed trades yet</b>P&amp;L appears here once a trade hits its target or stop.</td></tr>';
}

$('pnlPeriod').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  pnlPeriod = b.dataset.p;
  document.querySelectorAll('#pnlPeriod button').forEach((x) => {
    x.classList.toggle('active', x === b);
    x.setAttribute('aria-selected', String(x === b));
  });
  renderPnl();
};

async function openShot(t) {
  $('shotTitle').textContent = `Trade · ${fmtTime(t.entryTime)} · ${RESULT[t.status] || t.status}`;
  $('shotBody').innerHTML = '<p class="sub">Loading chart…</p>';
  $('shotMeta').innerHTML = [
    ['Entry', usd(t.entryPrice)], ['Stop', usd(t.stop)], ['Target', usd(t.target)],
    ['Side', t.side === 'short' ? 'Short' : 'Long'], ['Exit', t.exitPrice ? usd(t.exitPrice) : '—'], ['Qty', `${Number(t.qty).toFixed(6)} BTC`],
    ['P&L', t.pnl !== undefined ? signedUsd(t.pnl) : '—'], ['Confidence', t.confidence ?? '—'],
    ['IFVG zone', t.ifvg ? `${usd(t.ifvg.bottom)} – ${usd(t.ifvg.top)}` : '—'],
  ].map(([k, v]) => `<div><span>${k}</span>${esc(v)}</div>`).join('');
  $('shotNote').textContent = t.reasoning || '';
  $('shotModal').hidden = false;
  $('shotClose').focus();
  const shots = await getShots(t);
  const figs = [['At entry', shots.entry], ['At exit', shots.exit]].filter(([, s]) => s);
  $('shotBody').innerHTML = figs.map(([cap, svg]) => `<figure><figcaption>${cap}</figcaption>${shotHtml(svg, cap)}</figure>`).join('')
    || '<p class="sub">No chart was saved for this trade.</p>';
}

/* ---------------- controls ---------------- */

const refreshAll = () => Promise.all([loadStatus(), loadAccount(), loadDecisions(), loadOrders(), loadTrades()]);

async function withBtn(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
}

function setSegment(g) {
  document.querySelectorAll('#granularity button').forEach((b) => {
    const on = Number(b.dataset.g) === Number(g);
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
}

$('granularity').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  granularity = Number(b.dataset.g);
  setSegment(granularity);
  candles = [];
  loadMarket();
};

$('tabs').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  document.querySelectorAll('#tabs button').forEach((x) => {
    x.classList.toggle('active', x === b);
    x.setAttribute('aria-selected', String(x === b));
  });
  document.querySelectorAll('.tab-pane').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
};

$('trades').onclick = (e) => {
  const b = e.target.closest('[data-trade]');
  if (b) openShot(trades[Number(b.dataset.trade)]);
};
const closeShot = () => { $('shotModal').hidden = true; };
$('shotClose').onclick = closeShot;
$('shotModal').onclick = (e) => { if (e.target === $('shotModal')) closeShot(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('shotModal').hidden) closeShot(); });

$('startBtn').onclick = (e) => withBtn(e.target, async () => { await api('/api/bot/start', { method: 'POST' }); toast('Bot started: IFVG setups will be traded automatically'); refreshAll(); });
$('stopBtn').onclick = (e) => withBtn(e.target, async () => { await api('/api/bot/stop', { method: 'POST' }); toast('Bot stopped (open trades keep their stop and target)'); refreshAll(); });
$('runBtn').onclick = (e) => withBtn(e.target, async () => {
  $('botState').textContent = 'Thinking…';
  const d = await api('/api/bot/run', { method: 'POST' });
  toast(`AI says ${d.action}${d.executed ? ' — order executed' : d.note ? ` — ${d.note}` : ''}`, d.action === 'ERROR');
  await Promise.all([refreshAll(), loadMarket()]);
});
$('settingsForm').onsubmit = (e) => {
  e.preventDefault();
  withBtn(e.submitter, async () => {
    await api('/api/settings', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    toast('Settings saved'); loadStatus();
  });
};
$('buyBtn').onclick = (e) => withBtn(e.target, async () => {
  await api('/api/order', { method: 'POST', body: { side: 'buy', amount: $('buyAmount').value } });
  toast('Buy order placed'); $('buyAmount').value = ''; refreshAll();
});
$('sellBtn').onclick = (e) => withBtn(e.target, async () => {
  await api('/api/order', { method: 'POST', body: { side: 'sell', amount: $('sellAmount').value } });
  toast('Sell order placed'); $('sellAmount').value = ''; refreshAll();
});
$('resetBtn').onclick = (e) => {
  if (!confirm('Reset the local paper account to starting cash? Orders, trades and decisions will be cleared.')) return;
  withBtn(e.target, async () => { await api('/api/reset', { method: 'POST' }); shotCache.clear(); toast('Account reset'); refreshAll(); });
};
window.addEventListener('resize', drawChart);

refreshAll();
setInterval(refreshAll, 15000);
setInterval(loadMarket, 60000);
