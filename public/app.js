const $ = (id) => document.getElementById(id);
const usd = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—'
  : `${v < 0 ? '-' : ''}$${Math.abs(Number(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
// prices: decimals by size (BTC 2, XRP 4)
const pxDec = (v) => { const a = Math.abs(Number(v)); return a >= 100 ? 2 : a >= 1 ? 4 : 5; };
const px = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—'
  : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: pxDec(v), maximumFractionDigits: pxDec(v) })}`);
const pxPlain = (v) => { const d = pxDec(v) > 2 ? pxDec(v) : 0; return Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); };
/** 300 -> 5m, 3600 -> 1h */
const tfText = (g) => (g >= 3600 ? `${g / 3600}h` : `${g / 60}m`);
const symOf = (t) => t?.symbol || 'BTCUSDC';
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
let liquidity = [];
let trades = [];
let status = null;
let chartSymbol = 'BTCUSDC';
/** The open trade on the charted symbol (several symbols can have trades open). */
const chartOpen = () => (status?.openTrades || (status?.openTrade ? [status.openTrade] : [])).find((t) => symOf(t) === chartSymbol) || null;

/* ---------------- chart ---------------- */

const RR_CANDLES = 8; // width of the risk/reward block, in candles

// View window: `count` candle slots on screen, `offset` candles scrolled back from the latest (0 = live edge).
// yZoom / yPan stretch and move the price scale (1 / 0 = auto-fit), set by dragging the price axis or the chart.
const view = { count: null, offset: 0, yZoom: 1, yPan: 0 };
let pointer = null; // { x, y } in CSS px while the mouse is over the chart
let geom = null; // last layout, for mouse interaction

function drawChart() {
  const canvas = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = 320;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (candles.length < 2) return;

  const open = chartOpen();
  const pad = { l: 4, r: 72, t: 10, b: 22 };
  const t0 = candles[0].time;
  const idxAt = (t) => Math.max(0, Math.min(candles.length - 1, Math.floor((t - t0) / (granularity * 1000))));
  // The open trade's risk/reward block grows with the trade: from the entry to the latest candle (>= RR_CANDLES wide).
  const entryIdx = open ? idxAt(new Date(open.entryTime).getTime()) : null;
  const rrEnd = open ? Math.max(entryIdx + RR_CANDLES, candles.length + 1) : 0;
  const future = open ? Math.max(3, rrEnd + 2 - (candles.length - 1)) : 3; // empty slots right of the last candle
  const total = candles.length + future;

  // visible window
  view.count = Math.round(Math.min(total, Math.max(15, view.count ?? Math.min(total, 150))));
  view.offset = Math.min(Math.max(0, view.offset), Math.max(0, total - 10));
  const end = total - 1 - view.offset;
  const start = end - view.count + 1;
  const plotW = w - pad.l - pad.r;
  const step = plotW / view.count;
  const x = (i) => pad.l + step * (i - start + 0.5);
  const visible = candles.filter((_, i) => i >= start && i <= end);
  const extra = open && rrEnd >= start && entryIdx <= end ? [open.stop, open.target, open.initialStop ?? open.stop] : [];
  let lo = Math.min(...visible.map((c) => c.low), ...extra);
  let hi = Math.max(...visible.map((c) => c.high), ...extra);
  const padY = (hi - lo) * 0.05 || hi * 0.001;
  lo -= padY; hi += padY;
  if (view.yZoom !== 1 || view.yPan !== 0) { // manual price scale
    const mid = (lo + hi) / 2 + view.yPan * (hi - lo);
    const half = ((hi - lo) / 2) * view.yZoom;
    lo = mid - half; hi = mid + half;
  }
  const y = (p) => pad.t + (1 - (p - lo) / (hi - lo || 1)) * (h - pad.t - pad.b);
  const priceAt = (py) => lo + (1 - (py - pad.t) / (h - pad.t - pad.b)) * (hi - lo);
  geom = { pad, w, h, step, start, total, range: hi - lo };
  const mono = "11px 'JetBrains Mono', ui-monospace, monospace";
  const fmtT = (t) => new Date(t).toLocaleString([], granularity >= 86400 ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' });

  // grid, price axis, time axis
  ctx.strokeStyle = css('--border'); ctx.fillStyle = css('--dim'); ctx.font = mono; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const p = lo + ((hi - lo) * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y(p)); ctx.lineTo(w - pad.r, y(p)); ctx.stroke();
    ctx.fillText(pxPlain(p), w - pad.r + 8, y(p) + 4);
  }
  const every = Math.max(1, Math.ceil(view.count / 6));
  for (let i = Math.ceil(Math.max(0, start) / every) * every; i <= Math.min(Math.floor(end), candles.length - 1); i += every) {
    ctx.fillText(fmtT(candles[i].time), x(i) - 18, h - 6);
  }

  ctx.save();
  ctx.beginPath(); ctx.rect(pad.l, 0, plotW, h - pad.b); ctx.clip();

  // higher-timeframe FVG zones
  const labelled = [];
  htfZones.forEach((z) => {
    if (z.top < lo || z.bottom > hi) return;
    const bull = z.type === 'bullish';
    const x0 = Math.max(pad.l, z.readyAt > t0 ? x(idxAt(z.readyAt)) - step / 2 : pad.l);
    const top = y(Math.min(z.top, hi)), bot = y(Math.max(z.bottom, lo));
    ctx.fillStyle = bull ? 'rgba(16, 185, 129, .05)' : 'rgba(244, 63, 94, .05)';
    ctx.fillRect(x0, top, w - pad.r - x0, Math.max(1, bot - top));
    ctx.strokeStyle = bull ? 'rgba(52, 211, 153, .35)' : 'rgba(251, 113, 133, .35)';
    ctx.beginPath(); ctx.moveTo(x0, top); ctx.lineTo(w - pad.r, top); ctx.moveTo(x0, bot); ctx.lineTo(w - pad.r, bot); ctx.stroke();
    const ly = top + 11;
    const near = labelled.find((l) => Math.abs(l.y - ly) < 12 && Math.abs(l.x - x0) < 70);
    if (near) { near.text += ` · ${z.tf}`; return; }
    labelled.push({ x: x0 + 4, y: ly, text: `${z.tf} ${bull ? 'bull' : 'bear'} FVG`, color: bull ? 'rgba(52, 211, 153, .85)' : 'rgba(251, 113, 133, .85)' });
  });
  labelled.forEach((l) => { ctx.fillStyle = l.color; ctx.fillText(l.text, l.x, l.y); });

  // liquidity levels (PDH/PDL, today, previous week, equal highs/lows, HTF swings)
  ctx.font = "10px 'JetBrains Mono', ui-monospace, monospace";
  liquidity.forEach((l) => {
    if (l.price < lo || l.price > hi) return;
    ctx.strokeStyle = 'rgba(251, 191, 36, .55)'; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y(l.price)); ctx.lineTo(w - pad.r, y(l.price)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(251, 191, 36, .9)';
    ctx.fillText(l.type, w - pad.r - ctx.measureText(l.type).width - 4, y(l.price) - 3);
  });
  ctx.font = mono;

  // entry-timeframe IFVG zones
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

  // candles (visible only)
  const cw = Math.max(1, step * 0.6);
  const first = Math.max(0, Math.floor(start)), last = Math.min(Math.ceil(end), candles.length - 1);
  for (let i = first; i <= last; i++) {
    const c = candles[i];
    ctx.strokeStyle = ctx.fillStyle = c.close >= c.open ? css('--green') : css('--red');
    ctx.beginPath(); ctx.moveTo(x(i), y(c.high)); ctx.lineTo(x(i), y(c.low)); ctx.stroke();
    const top = y(Math.max(c.open, c.close));
    ctx.fillRect(x(i) - cw / 2, top, cw, Math.max(1, y(Math.min(c.open, c.close)) - top));
  }

  // SMA20
  ctx.strokeStyle = css('--blue'); ctx.lineWidth = 1.5; ctx.beginPath();
  let started = false;
  for (let i = Math.max(19, first - 1); i <= Math.min(last + 1, candles.length - 1); i++) {
    const avg = candles.slice(i - 19, i + 1).reduce((a, b) => a + b.close, 0) / 20;
    if (started) ctx.lineTo(x(i), y(avg)); else { ctx.moveTo(x(i), y(avg)); started = true; }
  }
  ctx.stroke();

  // open trade: risk/reward block
  if (open) {
    const x0 = x(entryIdx) - step / 2;
    const x1 = x(rrEnd) + step / 2;
    const yIn = y(open.entryPrice);
    const sl = open.initialStop ?? open.stop; // risk box keeps the original stop distance
    ctx.fillStyle = 'rgba(16, 185, 129, .18)';
    ctx.fillRect(x0, Math.min(yIn, y(open.target)), x1 - x0, Math.abs(y(open.target) - yIn));
    ctx.fillStyle = 'rgba(244, 63, 94, .18)';
    ctx.fillRect(x0, Math.min(yIn, y(sl)), x1 - x0, Math.abs(y(sl) - yIn));
    [[open.target, css('--green'), 'TP'], [open.entryPrice, css('--text-2'), 'IN'], [open.stop, css('--red'), open.breakeven ? 'BE' : 'SL']].forEach(([p, col, name]) => {
      ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.setLineDash(name === 'IN' ? [4, 3] : []);
      ctx.beginPath(); ctx.moveTo(x0, y(p)); ctx.lineTo(x1, y(p)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.fillText(name, x1 + 4, y(p) + 4);
    });
  }

  // trade markers in their own colors (not candle red / green): long = cyan, short = orange
  const LONG_C = "#22D3EE", SHORT_C = "#FB923C";
  ctx.font = "bold 10px 'JetBrains Mono', ui-monospace, monospace";
  trades.forEach((t) => {
    const col = t.side === "short" ? SHORT_C : LONG_C;
    const et = new Date(t.entryTime).getTime();
    if (et >= t0) {
      const px = x(idxAt(et));
      ctx.fillStyle = col; ctx.strokeStyle = "#090D14"; ctx.lineWidth = 1;
      ctx.beginPath();
      if (t.side === "short") { // orange down-arrow above the entry
        const py = y(t.entryPrice) - 10;
        ctx.moveTo(px, py + 8); ctx.lineTo(px - 6, py - 3); ctx.lineTo(px + 6, py - 3);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillText("S", px - 3, py - 6);
      } else { // cyan up-arrow below the entry
        const py = y(t.entryPrice) + 10;
        ctx.moveTo(px, py - 8); ctx.lineTo(px - 6, py + 3); ctx.lineTo(px + 6, py + 3);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillText("L", px - 3, py + 14);
      }
    }
    if (t.exitTime && new Date(t.exitTime).getTime() >= t0) {
      const ex = x(idxAt(new Date(t.exitTime).getTime())), ey = y(t.exitPrice);
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(ex, ey, 5, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ex - 3, ey - 3); ctx.lineTo(ex + 3, ey + 3); ctx.moveTo(ex + 3, ey - 3); ctx.lineTo(ex - 3, ey + 3); ctx.lineWidth = 1.5; ctx.stroke();
      if (t.r !== undefined) { ctx.fillStyle = col; ctx.fillText(`${t.r > 0 ? "+" : ""}${t.r}R`, ex + 8, ey + 4); }
    }
  });
  ctx.font = mono;
  ctx.restore();

  // crosshair with price and time labels
  if (pointer && pointer.x >= pad.l && pointer.x <= w - pad.r && pointer.y >= pad.t && pointer.y <= h - pad.b) {
    const i = Math.round(start + (pointer.x - pad.l) / step - 0.5);
    const cx = x(i);
    ctx.strokeStyle = 'rgba(148, 163, 184, .45)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, pad.t); ctx.lineTo(cx, h - pad.b); ctx.moveTo(pad.l, pointer.y); ctx.lineTo(w - pad.r, pointer.y); ctx.stroke();
    ctx.setLineDash([]);
    const tag = (text, tx, ty, wd) => {
      ctx.fillStyle = css('--l3'); ctx.fillRect(tx, ty - 11, wd, 16);
      ctx.strokeStyle = 'rgba(6, 182, 212, .5)'; ctx.strokeRect(tx, ty - 11, wd, 16);
      ctx.fillStyle = css('--text'); ctx.fillText(text, tx + 4, ty + 1);
    };
    tag(pxPlain(priceAt(pointer.y)), w - pad.r + 2, pointer.y, pad.r - 4);
    const c = candles[i];
    if (c) {
      tag(fmtT(c.time), Math.min(w - pad.r - 64, Math.max(pad.l, cx - 32)), h - 7, 64);
      $('chartOhlc').textContent = `O ${pxPlain(c.open)}  H ${pxPlain(c.high)}  L ${pxPlain(c.low)}  C ${pxPlain(c.close)}`;
    }
  } else {
    $('chartOhlc').textContent = view.offset > 0 ? 'scrolled back · double-click or ⟲ for live' : '';
  }
}

/* ---- chart interaction: wheel zoom, drag to pan, pinch, buttons, double-click reset ---- */

function zoomChart(factor, anchorX) {
  if (!geom) return;
  const { pad, w, step, start, total } = geom;
  const ax = anchorX ?? (w - pad.r); // zoom around the cursor (or the right edge)
  const slot = start + (ax - pad.l) / step; // the slot under the anchor stays put
  const count = Math.min(total, Math.max(15, view.count * factor));
  const newStart = slot - ((ax - pad.l) / (w - pad.l - pad.r)) * count;
  view.count = count;
  view.offset = Math.max(0, total - 1 - (newStart + count - 1));
  drawChart();
}

function panChart(dxPixels) {
  if (!geom) return;
  view.offset = Math.max(0, view.offset + dxPixels / geom.step);
  drawChart();
}

function resetChart() {
  view.count = null;
  view.offset = 0;
  view.yZoom = 1;
  view.yPan = 0;
  drawChart();
}

(() => {
  const canvas = $('chart');
  let drag = null;
  let pinch = null;
  const rel = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomChart(e.deltaY > 0 ? 1.15 : 1 / 1.15, rel(e).x); }, { passive: false });
  // Where a drag started: the price axis (stretch price), the time axis (stretch time) or the chart (move).
  const zone = (p) => (!geom ? 'plot' : p.x > geom.w - geom.pad.r ? 'price' : p.y > geom.h - geom.pad.b ? 'time' : 'plot');
  let mode = null, last = null;
  canvas.addEventListener('mousedown', (e) => { last = rel(e); mode = zone(last); drag = last.x; canvas.classList.add('grabbing'); });
  window.addEventListener('mouseup', () => { drag = null; mode = null; canvas.classList.remove('grabbing'); });
  canvas.addEventListener('mousemove', (e) => {
    const p = rel(e);
    if (mode && last && geom) {
      const dx = p.x - last.x, dy = p.y - last.y;
      if (mode === 'price') view.yZoom = Math.min(20, Math.max(0.05, view.yZoom * Math.exp(dy * 0.006))); // drag down = compress
      else if (mode === 'time') { zoomChart(Math.exp(dx * 0.006)); last = p; return; } // drag right = fewer candles
      else {
        view.offset = Math.max(0, view.offset + dx / geom.step);
        view.yPan += dy / (geom.h - geom.pad.t - geom.pad.b); // drag up/down moves price
      }
      last = p;
    }
    canvas.style.cursor = mode ? 'grabbing' : ({ price: 'ns-resize', time: 'ew-resize', plot: 'crosshair' })[zone(p)];
    pointer = p;
    drawChart();
  });
  canvas.addEventListener('mouseleave', () => { pointer = null; drawChart(); });
  canvas.addEventListener('dblclick', resetChart);
  // touch: one finger pans, two fingers pinch-zoom
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) drag = rel(e.touches[0]).x;
    if (e.touches.length === 2) pinch = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
  }, { passive: true });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length === 2 && pinch) {
      const d = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
      const mid = (rel(e.touches[0]).x + rel(e.touches[1]).x) / 2;
      if (d > 0) zoomChart(pinch / d, mid);
      pinch = d;
    } else if (e.touches.length === 1 && drag !== null) {
      const px = rel(e.touches[0]).x;
      panChart(px - drag);
      drag = px;
    }
  }, { passive: false });
  canvas.addEventListener('touchend', () => { drag = null; pinch = null; });
  $('zoomIn').onclick = () => zoomChart(1 / 1.3);
  $('zoomOut').onclick = () => zoomChart(1.3);
  $('zoomReset').onclick = resetChart;
})();

function renderIndicators(ind) {
  const items = [
    ['RSI 14', ind.rsi_14],
    ['SMA 20', px(ind.sma_20)],
    ['SMA 50', px(ind.sma_50)],
    ['MACD hist', ind.macd?.histogram],
    ['BB upper', px(ind.bollinger?.upper)],
    ['BB lower', px(ind.bollinger?.lower)],
  ];
  $('indicators').innerHTML = items.map(([k, v]) => `<div><span>${k}</span>${esc(v ?? '—')}</div>`).join('');
  $('price').textContent = px(ind.price);
  $('stripPrice').textContent = `${chartSymbol} ${px(ind.price)}`;
  const ch = ind.change_24;
  $('change').innerHTML = ch === null ? '—' : `<span class="num ${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '+' : ''}${ch}%</span> last 24 candles`;
}

async function loadMarket() {
  const state = $('chartState');
  if (!candles.length) { state.className = 'chart-state'; state.textContent = 'Loading candles…'; }
  try {
    const data = await api(`/api/market?granularity=${granularity}&symbol=${encodeURIComponent(chartSymbol)}`);
    const lastBefore = candles.at(-1)?.time;
    if (view.offset > 0 && lastBefore) view.offset += data.candles.filter((c) => c.time > lastBefore).length;
    candles = data.candles;
    ifvgs = data.ifvgs || [];
    htfZones = data.htfZones || [];
    liquidity = data.liquidity || [];
    renderIndicators(data.indicators);
    $('chartUpdated').textContent = `updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
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
  const price = (symOf(t) === chartSymbol ? candles.at(-1)?.close : t.lastPrice) ?? t.entryPrice;
  const short = t.side === 'short';
  const pos = Math.min(100, Math.max(0, ((price - t.stop) / (t.target - t.stop)) * 100));
  const upnl = (short ? t.entryPrice - price : price - t.entryPrice) * t.qty;
  return `<div class="ot-head"><span><span class="pill OPEN">OPEN ${short ? 'SHORT' : 'LONG'}</span> <b>${esc(symOf(t))}</b> ${t.ifvg?.grade === 'A+' ? '<span class="pill APLUS">A+</span> ' : ''}<span class="pill ${t.category === 'scalp' ? 'SCALP' : 'SWING'}">${t.category === 'scalp' ? 'SCALP' : 'SWING'}${t.granularity ? ` · ${tfText(t.granularity)}` : ''}</span> <span class="pill">1:${t.rr ?? 1}</span>${(t.leverage ?? 1) > 1 ? ` <span class="pill">${t.leverage}x</span>` : ''}${t.breakeven ? ' <span class="pill BE">BE</span>' : ''} ${fmtTime(t.entryTime)}</span>
      <span class="num ${upnl >= 0 ? 'up' : 'down'}">${signedUsd(upnl)}</span></div>
    <div class="ot-levels">
      <div><span>${t.breakeven ? 'Stop · BE' : 'Stop'}</span><em class="${t.breakeven ? '' : 'down'}">${px(t.stop)}</em></div>
      <div><span>Entry</span>${px(t.entryPrice)}</div>
      <div><span>Target</span><em class="up">${px(t.target)}</em></div>
    </div>
    <div class="ot-bar" title="Price between stop and target"><b style="left:${pos}%"></b></div>
    <div class="ot-risk">Risking <b>${usd((t.riskUsd ?? (t.qty && (t.initialStop ?? t.stop) ? Math.abs(t.entryPrice - (t.initialStop ?? t.stop)) * t.qty : null)))}</b> to make <b>${usd(Math.abs(t.target - t.entryPrice) * t.qty)}</b>${(t.leverage ?? 1) > 1 ? ` · ${t.leverage}x` : ''}</div>
    ${t.nextReviewAt ? `<div class="ot-risk">Next Jev review <b>${new Date(t.nextReviewAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b></div>` : ''}
    ${t.setupReason ? `<div class="ot-reason">${esc(t.setupReason)}</div>` : ''}`;
}

let settingsLoaded = false;
async function loadStatus() {
  try {
    const s = await api('/api/status');
    status = s;
    $('aiBadge').textContent = `AI: ${s.ai}`;
    renderModel(s);
    $('brokerBadge').textContent = `Broker: ${s.broker}`;
    $('ruleLev').textContent = s.broker === 'binance' ? `Jev decides, max ${s.settings.maxLeverage ?? 5}x` : '1x (simulator)';
    $('ruleInv').textContent = `counted from the FIRST FVG of the series (its middle candle = 0) to the candle that closes through the last one: within ${s.settings.ifvgMaxAge ?? 7} candles, close ≥20% through it, entry ≤2 candles after${s.settings.requireDisplacement ? ', displacement candle' : ''}`;
    const lq = s.liquidity;
    $('ruleLiq').textContent = lq ? `draw ${lq.draw ?? 'unclear'}${lq.lrlr ? ` · LRLR ${lq.lrlr.side}` : ''}${lq.above?.[0] ? ` · ↑ ${lq.above[0].type} ${pxPlain(lq.above[0].price)}` : ''}${lq.below?.[0] ? ` · ↓ ${lq.below[0].type} ${pxPlain(lq.below[0].price)}` : ''}` : 'scanning…';
    $('ruleTarget').textContent = s.settings.targetMode === 'liquidity' ? 'liquidity: nearest swing low (short) / swing high (long), LRLR, equal highs-lows 0.75R-5R, else fixed R:R' : `fixed 1 : ${s.settings.riskReward ?? 1}`;
    $('ruleRR').textContent = `1 : ${s.settings.riskReward ?? 1}`;
    $('ruleBE').textContent = s.settings.breakevenAtR ? `stop to entry at +${s.settings.breakevenAtR}R` : 'off';
    $('ruleAi').textContent = `${s.ai.startsWith('jev') ? 'Jev' : s.ai.split(':')[0]}, auto-execute`;
    $('botDot').className = `dot${s.running ? ' on' : ''}`;
    $('botState').textContent = s.busy ? 'Thinking…' : s.running ? 'Running' : 'Stopped';
    $('startBtn').textContent = s.running ? 'Auto-trading on' : 'Start bot';
    const scan = s.symbols ? '' : s.lastScan?.note ? ` · ${s.lastScan.note}` : '';
    $('botTimes').textContent = `Last scan ${fmtTime(s.lastRun)}${s.nextRun ? ` · next ${fmtTime(s.nextRun)}` : ''}${scan}`;

    const maxSw = s.settings.maxSwingPerDay ?? 5, maxSc = s.settings.maxScalpPerDay ?? 5;
    const max = maxSw + maxSc; // total = swing + scalp limits
    $('tradesToday').textContent = `${s.tradesToday} / ${max}`;
    $('stripTrades').textContent = `${s.tradesToday}/${max}`;
    // one bar per trade type
    const bar = (used, limit, cls) => `<div class="meter-row"><span class="pill ${cls}">${cls}</span><div class="meter-track ${cls.toLowerCase()}${used >= limit && limit ? ' full' : ''}" style="grid-template-columns:repeat(${Math.max(1, limit)},1fr)">${Array.from({ length: Math.max(1, limit) }, (_, i) => `<i class="${i < used ? 'used' : ''}"></i>`).join('')}</div><b>${used} / ${limit}</b></div>`;
    const off = (cls) => `<div class="meter-row off"><span class="pill ${cls}">${cls}</span><span class="src">disabled</span><b></b></div>`;
    $('meterTrack').innerHTML = (s.settings.swingEnabled === false ? off('SWING') : bar(s.swingToday ?? 0, maxSw, 'SWING'))
      + (s.settings.scalpEnabled === false ? off('SCALP') : bar(s.scalpToday ?? 0, maxSc, 'SCALP'));
    const ss = s.scanStats;
    $('scanStats').innerHTML = ss ? scanFunnel(ss, s.model) : 'Scans today: counting starts with the next scan';
    $('scanStats').title = ss ? `no setup ${ss.noIfvg || 0} · no FVG tap / sweep ${ss.noTap || 0} · waiting ${ss.waiting || 0} · in trade ${ss.inTrade || 0} · limit ${ss.limit || 0} · already asked ${ss.seen || 0}` : '';
    // only symbols with an open trade (what the bot is managing right now)
    const openSyms = new Set((s.openTrades || (s.openTrade ? [s.openTrade] : [])).map(symOf));
    $('meterSplit').innerHTML = (s.symbols || []).filter((x) => openSyms.has(x.symbol)).map((x) => `<div class="sym-scan"><b>${esc(x.symbol)}</b> ${esc(x.lastScan || 'open trade')}</div>`).join('');
    const opens = s.openTrades || (s.openTrade ? [s.openTrade] : []);
    $('openTrade').innerHTML = opens.map(renderOpenTrade).join('<hr class="ot-sep">');
    // chart symbol choices (symbols with an open trade marked)
    const syms = (s.symbols || [{ symbol: s.symbol || 'BTCUSDC' }]).map((x) => x.symbol);
    const sel = $('chartSymbol');
    const html = syms.map((x) => `<option value="${esc(x)}"${x === chartSymbol ? ' selected' : ''}>${esc(x)}${opens.some((t) => symOf(t) === x) ? ' ●' : ''}</option>`).join('');
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }

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

/**
 * What a decision did to the trade: SHORT / LONG (opened), CLOSE SHORT / CLOSE LONG (closed), HOLD, ...
 * Closing a short is a BUY order and closing a long a SELL order, so the raw action alone reads backwards.
 */
function decisionLabel(d) {
  if (d.label) return d.label;
  const note = d.note || '';
  const closed = d.executed && (d.source === 'bracket' || /closed (short|long)|Closed (short|long)/.test(note));
  if (closed) return d.action === 'BUY' ? 'CLOSE SHORT' : 'CLOSE LONG';
  if (d.executed && /^(BUY|SELL)$/.test(d.action)) return d.action === 'SELL' ? 'SHORT' : 'LONG';
  return d.action;
}
const labelClass = (l) => (l.startsWith('CLOSE') ? 'OPEN' : l === 'LONG' ? 'BUY' : l === 'SHORT' ? 'SELL' : l);

/** Jev's latest reasoning for the charted symbol (the newest decision Jev answered, else the newest scan). */
async function renderJevReason() {
  const sym = chartSymbol;
  const d = await api(`/api/jev/last?symbol=${encodeURIComponent(sym)}`).catch(() => null);
  if (sym !== chartSymbol) return; // symbol changed meanwhile
  const box = $('jevReason');
  if (!d) { box.className = 'decision'; box.innerHTML = `<div class="decision-head"><span>Jev · ${esc(chartSymbol)}</span></div><div class="sub">No Jev decision for ${esc(chartSymbol)} yet</div>`; return; }
  const lbl = decisionLabel(d);
  box.className = `decision ${esc(d.action || '')}`;
  box.innerHTML = `<div class="decision-head"><span>Jev · <b>${esc(chartSymbol)}</b> <span class="pill ${esc(labelClass(lbl))}">${esc(lbl)}</span>${d.confidence !== undefined ? ` ${confBadge(d.confidence)}` : ''}</span>
    <span class="num">${fmtTime(d.time)}</span></div>
    ${d.reasoning ? jevOddsHtml(d.reasoning) : ''}
    <div class="sub">${esc(d.note || '')}${d.executed ? ' <span class="ok">✓ executed</span>' : ''}</div>
    ${nextReviewHtml()}`;
}

/** Next Jev review of the open trade on the charted symbol (local time). */
function nextReviewHtml() {
  const t = chartOpen();
  if (!t?.nextReviewAt) return '';
  const at = new Date(t.nextReviewAt);
  const mins = Math.max(0, Math.round((at - Date.now()) / 60000));
  return `<div class="sub next-review">Next Jev review <b>${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b> (${mins ? `in ${mins} min` : 'due now'})</div>`;
}

async function loadDecisions() {
  try {
    const decisions = await api('/api/decisions');
    renderJevReason();
    $('decisions').querySelector('tbody').innerHTML = decisions.map((d) => `<tr>
      <td class="t">${fmtTime(d.time)}</td><td class="r">${d.symbol ? `<span class="src">${esc(d.symbol)}</span> ` : ''}${px(d.price)}</td>
      <td><span class="pill ${esc(labelClass(decisionLabel(d)))}">${esc(decisionLabel(d))}</span></td>
      <td class="r">${d.confidence !== undefined && d.confidence !== null ? confBadge(d.confidence) : '—'}</td>
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
    // Link orders to trades: the entry order of the open trade is ACTIVE; a closing order shows its trade's P&L.
    const opens = status?.openTrades || (status?.openTrade ? [status.openTrade] : []);
    const entryOf = new Map(trades.filter((t) => t.orderId).map((t) => [String(t.orderId), t]));
    const exitOf = new Map(trades.filter((t) => t.exitOrderId).map((t) => [String(t.exitOrderId), t]));
    // older trades: match the closing order by time (within 90 s of the exit) and side
    for (const t of trades) {
      if (t.exitOrderId || !t.exitTime) continue;
      const want = t.side === 'short' ? 'cover' : 'sell';
      const o = orders.find((x) => x.side === want && Math.abs(new Date(x.time) - new Date(t.exitTime)) < 90000 && !exitOf.has(String(x.id)));
      if (o) exitOf.set(String(o.id), t);
    }
    const price = candles.at(-1)?.close;
    $('orders').querySelector('tbody').innerHTML = orders.map((o) => {
      const id = String(o.id);
      const open = opens.find((t) => String(t.orderId) === id && (!o.symbol || symOf(t) === o.symbol));
      const active = Boolean(open);
      const closed = exitOf.get(id);
      const opened = entryOf.get(id);
      let pnl = o.pnl;
      let note = o.reason ? ` · ${esc(o.reason)}` : '';
      if (active && price && symOf(open) === chartSymbol) {
        pnl = (open.side === 'short' ? open.entryPrice - price : price - open.entryPrice) * open.qty;
        const t = open;
        note = ` · open ${esc(open.side)} · risking ${usd((t.riskUsd ?? (t.qty && (t.initialStop ?? t.stop) ? Math.abs(t.entryPrice - (t.initialStop ?? t.stop)) * t.qty : null)))} · SL ${px(open.stop)} · TP ${px(open.target)}`;
      } else if (closed) {
        pnl = closed.pnl;
        const t = closed;
        note = ` · closed ${esc(closed.side)} (${esc(closed.exitReason)}, ${closed.r > 0 ? '+' : ''}${closed.r}R, risked ${usd((t.riskUsd ?? (t.qty && (t.initialStop ?? t.stop) ? Math.abs(t.entryPrice - (t.initialStop ?? t.stop)) * t.qty : null)))})`;
      } else if (opened && opened.status !== 'open') {
        note = ` · opened ${esc(opened.side)} → ${esc(String(opened.status).toUpperCase())}`;
      }
      return `<tr class="${active ? 'active-order' : ''}">
      <td class="t">${fmtTime(o.time)}</td><td>${o.symbol ? `<span class="src">${esc(o.symbol)}</span> ` : ''}<span class="pill ${esc(o.side)}">${esc(o.side?.toUpperCase())}</span>${active ? ' <span class="pill OPEN">ACTIVE</span>' : ''}</td>
      <td class="r">${o.qty ? Number(o.qty).toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'}</td><td class="r">${px(o.price)}</td><td class="r">${usd(o.notional)}</td>
      <td class="r">${pnl !== undefined && pnl !== null ? `<span class="${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}">${signedUsd(pnl)}</span>${active ? ' <span class="src">live</span>' : ''}` : '—'}</td>
      <td>${esc(o.status)}${note}</td><td class="src">${esc(o.source)}</td></tr>`;
    }).join('')
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

const RESULT = { open: 'OPEN', win: 'WIN', loss: 'LOSS', breakeven: 'BE' };
async function loadTrades() {
  try {
    trades = await api('/api/trades');
    const closed = trades.filter((t) => t.status !== 'open');
    const wins = closed.filter((t) => t.status === 'win').length;
    $('tradeCount').textContent = trades.length ? ` ${trades.length}${closed.length ? ` · ${Math.round((wins / closed.length) * 100)}% win` : ''}` : '';
    const body = $('trades').querySelector('tbody');
    if (!trades.length) {
      body.innerHTML = '<tr><td colspan="15" class="empty"><b>No trades yet</b>When an IFVG forms and Jev agrees (BUY on bullish, SELL on bearish), the bot opens a 1:1 trade and saves a chart snapshot here.</td></tr>';
      drawChart();
      renderPnl();
      return;
    }
    body.innerHTML = trades.map((t, i) => `<tr>
      <td><div class="thumbs">
        <figure><figcaption>Entry</figcaption><button type="button" class="thumb" data-trade="${i}" data-phase="entry" aria-label="Entry chart for trade at ${esc(fmtTime(t.entryTime))}"><span class="no-shot">…</span></button></figure>
        <figure><figcaption>${t.status === 'open' ? 'Exit' : `Exit · ${esc(RESULT[t.status] || t.status)}`}</figcaption><button type="button" class="thumb" data-trade="${i}" data-phase="exit" aria-label="Exit chart for trade at ${esc(fmtTime(t.entryTime))}"><span class="no-shot">${t.status === 'open' ? 'open' : '…'}</span></button></figure>
      </div></td>
      <td class="t">${fmtTime(t.entryTime)}</td>
      <td><b>${esc(symOf(t))}</b></td>
      <td>${t.ifvg?.grade === 'A+' ? '<span class="pill APLUS">A+</span> ' : ''}<span class="pill ${t.category === 'scalp' ? 'SCALP' : 'SWING'}">${t.category === 'scalp' ? 'SCALP' : 'SWING'}${t.granularity ? ` · ${tfText(t.granularity)}` : ''}</span>${(t.leverage ?? 1) > 1 ? ` <span class="src">${t.leverage}x</span>` : ''}</td>
      <td><span class="pill ${t.side === 'short' ? 'SELL' : 'BUY'}">${t.side === 'short' ? 'SHORT' : 'LONG'}</span></td>
      <td><span class="pill ${RESULT[t.status] || ''}">${RESULT[t.status] || esc(String(t.status).toUpperCase())}</span></td>
      <td class="r">${px(t.entryPrice)}</td><td class="r down">${px(t.stop)}</td><td class="r up">${px(t.target)}</td>
      <td class="r">${(t.riskUsd ?? (t.qty && (t.initialStop ?? t.stop) ? Math.abs(t.entryPrice - (t.initialStop ?? t.stop)) * t.qty : null)) ? usd((t.riskUsd ?? (t.qty && (t.initialStop ?? t.stop) ? Math.abs(t.entryPrice - (t.initialStop ?? t.stop)) * t.qty : null))) : '—'}</td>
      <td class="r">${t.exitPrice ? px(t.exitPrice) : '—'}</td>
      <td class="r">${t.r != null ? `${t.r > 0 ? '+' : ''}${t.r}R` : '—'}</td>
      <td class="r">${t.pnl !== undefined ? `<span class="${t.pnl >= 0 ? 'up' : 'down'}">${signedUsd(t.pnl)}</span>${t.fees != null ? `<div class="src" title="Binance realized profit before fees, and the entry + exit trading fees">gross ${signedUsd(t.grossPnl)} · fees ${usd(t.fees)}</div>` : ''}` : '—'}</td>
      <td class="src">${esc(t.source || '')}</td>
      <td class="reason">${esc(t.setupReason || '')}</td></tr>`).join('');
    // thumbnails for the most recent trades
    trades.slice(0, 25).forEach(async (t, i) => {
      const shots = await getShots(t);
      const entryBtn = body.querySelector(`[data-trade="${i}"][data-phase="entry"]`);
      const exitBtn = body.querySelector(`[data-trade="${i}"][data-phase="exit"]`);
      if (entryBtn) entryBtn.innerHTML = shotHtml(shots.entry, 'Entry chart') || '<span class="no-shot">no chart</span>';
      if (exitBtn) exitBtn.innerHTML = shotHtml(shots.exit, 'Exit chart') || `<span class="no-shot">${t.status === 'open' ? 'open' : 'no chart'}</span>`;
    });
    drawChart();
    renderPnl();
  } catch (e) {
    $('trades').querySelector('tbody').innerHTML = `<tr><td colspan="15" class="empty"><b>Couldn't load trades</b>${esc(e.message)}</td></tr>`;
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
    if (t.status === 'win' || (t.status !== 'breakeven' && t.pnl > 0)) g.wins++;
    else if (t.status === 'loss' || t.pnl < 0) g.losses++;
    else g.be = (g.be || 0) + 1; // breakeven: neither a win nor a loss
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
      <td class="r">${g.wins} / ${g.losses}${g.be ? ` / ${g.be} BE` : ''}</td>
      <td class="r">${g.wins + g.losses ? Math.round((g.wins / (g.wins + g.losses)) * 100) : 0}%</td>
      <td class="r">${g.r >= 0 ? '+' : ''}${g.r.toFixed(1)}R</td>
      <td><div class="pnl-cell"><div class="bar"><i class="${g.total >= 0 ? 'pos' : 'neg'}" style="width:${(Math.abs(g.total) / max) * 50}%"></i></div>${pnlSpan(g.total)}</div></td>
    </tr>`).join('')
    || '<tr><td colspan="8" class="empty"><b>No closed trades yet</b>P&amp;L appears here once a trade hits its target or stop.</td></tr>';
  renderEquity();
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

async function openShot(t, phase = 'exit') {
  $('shotTitle').textContent = `Trade · ${fmtTime(t.entryTime)} · ${RESULT[t.status] || t.status}`;
  $('shotBody').innerHTML = '<p class="sub">Loading chart…</p>';
  $('shotMeta').innerHTML = [
    ['Symbol', symOf(t)], ['Entry', px(t.entryPrice)], ['Stop', px(t.stop)], ['Target', px(t.target)],
    ['Type', t.category === 'scalp' ? 'Scalp' : 'Swing'], ['Side', t.side === 'short' ? 'Short' : 'Long'], ['Risk', (t.riskUsd ?? (t.qty && (t.initialStop ?? t.stop) ? Math.abs(t.entryPrice - (t.initialStop ?? t.stop)) * t.qty : null)) ? usd((t.riskUsd ?? (t.qty && (t.initialStop ?? t.stop) ? Math.abs(t.entryPrice - (t.initialStop ?? t.stop)) * t.qty : null))) : '—'], ['Exit', t.exitPrice ? usd(t.exitPrice) : '—'], ['Qty', `${Number(t.qty).toFixed(6)} BTC`],
    ['P&L', t.pnl !== undefined ? signedUsd(t.pnl) : '—'], ['Confidence', t.confidence ?? '—'],
    ['IFVG zone', t.ifvg ? `${px(t.ifvg.bottom)} – ${px(t.ifvg.top)}` : '—'],
  ].map(([k, v]) => `<div><span>${k}</span>${esc(v)}</div>`).join('');
  $('shotNote').textContent = [t.setupReason, t.reasoning].filter(Boolean).join(' — ');
  $('shotModal').hidden = false;
  $('shotClose').focus();
  const shots = await getShots(t);
  // Entry / Exit tabs; opens on the snapshot that was clicked (exit falls back to entry while the trade is open).
  const views = { entry: ['At entry', shots.entry], exit: [t.status === 'open' ? 'Exit (trade still open)' : `At exit · ${RESULT[t.status] || t.status}`, shots.exit] };
  const show = (p) => {
    const [cap, img] = views[p];
    $('shotBody').innerHTML = `<div class="segmented shot-tabs" role="tablist">${['entry', 'exit'].map((k) => `<button type="button" role="tab" data-shot="${k}" class="${k === p ? 'active' : ''}" aria-selected="${k === p}">${k === 'entry' ? 'Entry' : 'Exit'}</button>`).join('')}</div>`
      + (img ? `<figure><figcaption>${cap}</figcaption>${shotHtml(img, cap)}</figure>` : `<p class="sub">${p === 'exit' && t.status === 'open' ? 'The exit chart is saved when the trade closes.' : 'No chart was saved for this snapshot.'}</p>`);
    $('shotBody').querySelectorAll('[data-shot]').forEach((b) => { b.onclick = () => show(b.dataset.shot); });
  };
  show(phase === 'exit' && !shots.exit && t.status === 'open' ? 'entry' : phase);
}

/* ---------------- controls ---------------- */

const refreshAll = () => Promise.all([loadStatus(), loadAccount(), loadDecisions(), loadTrades(), loadSuggestions()]).then(loadOrders);

/* ---------------- strategy model, pop-ups, suggestions ---------------- */

const modelName = (m) => status?.models?.[m] || m;
function renderModel(s) {
  const sel = $('modelSelect');
  const html = Object.entries(s.models || { ifvg: 'IFVG' }).map(([k, v]) => `<option value="${esc(k)}"${k === s.model ? ' selected' : ''}>${esc(v)}</option>`).join('');
  if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
  sel.value = s.model || 'ifvg';
  $('modelHint').textContent = s.model === 'jev' ? 'Jev decides and manages trades by itself: no pattern filter.'
    : (s.model || 'ifvg') === 'ifvg' ? 'IFVG setups, Jev confirms each entry and manages the trade.'
    : `${modelName(s.model)} setups, Jev confirms each entry and manages the trade.`;
}
const openModal = (id) => { $(id).hidden = false; $(id).querySelector('[data-close]')?.focus(); };
document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { $(b.dataset.close).hidden = true; }; });
['strategyModal', 'configModal'].forEach((id) => { $(id).onclick = (e) => { if (e.target === $(id)) $(id).hidden = true; }; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ['strategyModal', 'configModal'].forEach((id) => { $(id).hidden = true; }); });
$('viewStrategyBtn').onclick = () => {
  const m = status?.model || 'ifvg';
  $('strategyTitle').textContent = `Strategy · ${modelName(m)}`;
  $('modelRulesText').textContent = status?.modelRules?.[m] || '';
  $('ifvgRules').hidden = m !== 'ifvg';
  openModal('strategyModal');
};
// Configure strategy: General / Risk / Entry / Swing / Scalp tabs (all fields are still saved together)
$('cfgTabs').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  document.querySelectorAll('#cfgTabs button').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', String(x === b)); });
  document.querySelectorAll('.cfg-group').forEach((g) => { g.hidden = g.dataset.group !== b.dataset.g; });
};
$('configStrategyBtn').onclick = () => { $('configTitle').textContent = `Configure strategy · ${modelName(status?.model || 'ifvg')}`; openModal('configModal'); };
$('modelSelect').onchange = (e) => {
  const m = e.target.value;
  if (!confirm(`Switch the bot to ${modelName(m)}? Open trades keep their stop and target; new entries use ${modelName(m)}.`)) { e.target.value = status?.model || 'ifvg'; return; }
  withBtn(e.target, async () => {
    await api('/api/settings', { method: 'POST', body: { model: m } });
    settingsLoaded = false; // the form shows this model's own settings
    $('jevOverview').innerHTML = ''; // old model's answers
    toast(`Model: ${modelName(m)}`);
    await Promise.all([refreshAll(), loadMarket()]);
    renderJevReason();
    if (!$('jevModal').hidden) loadJev();
  });
};

const patchText = (p) => (!p ? '—' : Object.entries(p).map(([k, v]) => `${k} → ${v}`).join(', '));
async function loadSuggestions() {
  try {
    const list = await api('/api/suggestions');
    const pending = list.filter((x) => x.status === 'pending').length;
    $('suggestCount').textContent = pending ? ` ${pending}` : '';
    $('suggestions').querySelector('tbody').innerHTML = list.map((x) => `<tr>
      <td class="t">${esc(x.day)}</td><td><span class="pill">${esc(modelName(x.model))}</span></td>
      <td><b>${esc(x.title)}</b>${x.origin ? `<div class="src">${esc(x.origin)}</div>` : ''}</td><td class="reason">${esc(x.detail)}${(x.sources || []).map((u, i) => ` <a href="${esc(u)}" target="_blank" rel="noopener noreferrer" class="src-link">source ${i + 1}</a>`).join('')}</td><td class="src">${esc(patchText(x.patch))}</td>
      <td>${x.status === 'pending' ? `<button type="button" class="btn btn-primary btn-sm" data-approve="${esc(x.id)}">Enable now</button> <button type="button" class="btn btn-ghost btn-sm" data-ignore="${esc(x.id)}">Ignore</button>` : `<span class="pill ${x.status === 'approved' ? 'WIN' : ''}">${esc(x.status.toUpperCase())}</span>`}</td></tr>`).join('')
      || '<tr><td colspan="6" class="empty"><b>No suggestions yet</b>They appear after the first UTC day closes, or click "Analyze today so far".</td></tr>';
  } catch (e) {
    $('suggestions').querySelector('tbody').innerHTML = `<tr><td colspan="6" class="empty"><b>Couldn't load suggestions</b>${esc(e.message)}</td></tr>`;
  }
}
$('suggestions').onclick = (e) => {
  const b = e.target.closest('[data-approve],[data-ignore]');
  if (!b) return;
  const approve = Boolean(b.dataset.approve);
  withBtn(b, async () => {
    await api(`/api/suggestions/${encodeURIComponent(b.dataset.approve || b.dataset.ignore)}/${approve ? 'approve' : 'ignore'}`, { method: 'POST' });
    toast(approve ? 'Enabled for this model' : 'Ignored (kept in history)');
    settingsLoaded = false;
    await refreshAll();
  });
};
$('suggestNowBtn').onclick = (e) => withBtn(e.target, async () => {
  await api('/api/suggestions/generate', { method: 'POST', body: { day: new Date().toISOString().slice(0, 10) } });
  await loadSuggestions();
});

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
  view.count = null;
  view.offset = 0;
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
  refreshAll(); // fresh values whenever a tab is opened
};

$('trades').onclick = (e) => {
  const b = e.target.closest('[data-trade]');
  if (b) openShot(trades[Number(b.dataset.trade)], b.dataset.phase || 'exit');
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

// JEV overview: odds for every symbol (read-only, nothing is traded)
const pct = (v) => (v === undefined || v === null ? '—' : `${Math.round(v * 100)}%`);
function renderJevOverview(rows) {
  const best = (r) => (r.odds ? Object.entries(r.odds).sort((x, y) => y[1] - x[1])[0][0] : null);
  return `<div class="table-wrap"><table class="jev-table"><thead><tr><th>Symbol</th><th class="r">Price</th><th>Jev says</th><th>Buy</th><th>Sell</th><th>Hold</th><th class="r">Model conf.</th><th>Bot</th><th>Setup</th></tr></thead><tbody>`
  + rows.map((r) => {
    if (r.error) return `<tr><td><b>${esc(r.symbol)}</b></td><td colspan="8" class="src">${esc(r.error)}</td></tr>`;
    const top = best(r);
    const bar = (k, cls) => `<td><span class="odds ${cls}${top === k ? ' top' : ''}"><i style="width:${Math.round((r.odds?.[k] ?? 0) * 100)}%"></i><em>${pct(r.odds?.[k])}</em></span></td>`;
    return `<tr class="jev-sym" data-symbol="${esc(r.symbol)}" tabindex="0" title="Show ${esc(r.symbol)} on the chart"><td class="jev-symcell"><b>${esc(r.symbol)}</b>${r.open ? ` <span class="pill OPEN">${esc(r.open.toUpperCase())}</span>` : ''}</td>
      <td class="r">${px(r.price)}</td>
      <td><span class="pill ${esc(r.action || '')}">${esc(r.action || '—')}</span></td>
      ${bar('BUY', 'buy')}${bar('SELL', 'sell')}${bar('HOLD', 'hold')}
      <td class="r">${r.modelConfidence !== null && r.modelConfidence !== undefined ? confBadge(r.modelConfidence) : '—'}</td>
      <td class="jev-bot">${esc(r.botAction || '')}</td>
      <td class="jev-setup">${esc(r.setup || r.note || 'no setup')}</td></tr>`;
  }).join('') + '</tbody></table></div>';
}
let jevLoading = false;
async function loadJev() {
  if (jevLoading) return;
  jevLoading = true;
  $('jevRefresh').disabled = true;
  $('jevWhen').textContent = `· asking Jev about ${status?.symbols?.length || 1} symbols…`;
  if (!$('jevOverview').innerHTML) $('jevOverview').innerHTML = '<div class="jev-loading">Asking Jev…</div>';
  try {
    $('jevOverview').innerHTML = renderJevOverview(await api('/api/jev/overview'));
    $('jevWhen').textContent = `· ${fmtTime(Date.now())}`;
  } catch (err) {
    $('jevWhen').textContent = '';
    $('jevOverview').innerHTML = `<div class="jev-loading down">${esc(err.message)}</div>`;
  } finally { jevLoading = false; $('jevRefresh').disabled = false; }
}
const closeJev = () => { $('jevModal').hidden = true; $('jevBtn').focus(); };
$('jevBtn').onclick = () => { $('jevModal').hidden = false; $('jevClose').focus(); loadJev(); };
$('jevRefresh').onclick = loadJev;
$('jevClose').onclick = closeJev;
$('jevModal').onclick = (e) => { if (e.target === $('jevModal')) closeJev(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('jevModal').hidden) closeJev(); });
const showSymbol = (e) => {
  const tr = e.target.closest('.jev-sym');
  if (!tr) return;
  $('chartSymbol').value = tr.dataset.symbol;
  $('chartSymbol').onchange({ target: $('chartSymbol') });
  closeJev();
};
$('jevOverview').onclick = showSymbol;
$('jevOverview').onkeydown = (e) => { if (e.key === 'Enter') showSymbol(e); };
$('settingsForm').onsubmit = (e) => {
  e.preventDefault();
  withBtn(e.submitter, async () => {
    await api('/api/settings', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    toast('Settings saved'); $('configModal').hidden = true; loadStatus();
  });
};
$('buyBtn').onclick = (e) => withBtn(e.target, async () => {
  const amt = Number($('buyAmount').value);
  if (!(amt > 0)) throw new Error('Enter the USD amount to buy');
  if (!confirm(`Place a manual BUY of $${amt.toLocaleString()} at market now? This is outside the bot's strategy.`)) return;
  await api('/api/order', { method: 'POST', body: { side: 'buy', amount: $('buyAmount').value } });
  toast('Buy order placed'); $('buyAmount').value = ''; refreshAll();
});
$('sellBtn').onclick = (e) => withBtn(e.target, async () => {
  const qty = Number($('sellAmount').value);
  if (!(qty > 0)) throw new Error('Enter the quantity to sell');
  if (!confirm(`Place a manual SELL of ${qty} at market now? This is outside the bot's strategy.`)) return;
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

// Live refresh: every 3 s ask whether trades / orders / decisions changed; reload right away if they did.
let lastSig = null;
async function checkChanges() {
  if (document.hidden) return;
  try {
    const { sig } = await api('/api/changes');
    if (lastSig !== null && sig !== lastSig) { await refreshAll(); loadMarket(); }
    lastSig = sig;
  } catch { /* next tick */ }
}
setInterval(checkChanges, 3000);
checkChanges();
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshAll(); loadMarket(); } });
setInterval(loadMarket, 15000);
$('chartSymbol').onchange = (e) => { chartSymbol = e.target.value; renderJevReason(); candles = []; view.offset = 0; view.yZoom = 1; view.yPan = 0; loadMarket(); loadStatus(); }; // keep the chart live (new candles, open trade)


/* ---------------- chat assistant (lower right) ---------------- */
let chat = [];
try { chat = JSON.parse(localStorage.getItem('cqp-chat') || '[]'); } catch { chat = []; }
const saveChat = () => { try { localStorage.setItem('cqp-chat', JSON.stringify(chat.slice(-30))); } catch { /* private mode */ } };
function renderChat() {
  $('chatLog').innerHTML = chat.length
    ? chat.map((m) => `<div class="chat-msg ${m.role}">${esc(m.content).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')}</div>`).join('')
    : '<div class="chat-empty">Hi! Ask me anything about your bot: why a trade was or wasn\'t taken, today\'s results, your settings or a strategy model.</div>';
  $('chatChips').hidden = chat.length > 0;
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
}
function toggleChat(open) {
  $('chatPanel').hidden = !open;
  $('chatFab').setAttribute('aria-expanded', String(open));
  if (open) { renderChat(); $('chatInput').focus(); }
}
async function sendChat(text) {
  const q = text.trim();
  if (!q) return;
  chat.push({ role: 'user', content: q });
  $('chatInput').value = '';
  renderChat();
  $('chatLog').insertAdjacentHTML('beforeend', '<div class="chat-msg assistant typing">Thinking…</div>');
  $('chatSend').disabled = true;
  try {
    const r = await api('/api/chat', { method: 'POST', body: { messages: chat } });
    chat.push({ role: 'assistant', content: r.reply });
  } catch (e) {
    chat.push({ role: 'assistant', content: `Sorry, I couldn't answer: ${e.message}` });
  } finally {
    $('chatSend').disabled = false;
    saveChat();
    renderChat();
  }
}
$('chatFab').onclick = () => toggleChat($('chatPanel').hidden);
$('chatClose').onclick = () => toggleChat(false);
$('chatClear').onclick = () => { chat = []; saveChat(); renderChat(); };
$('chatChips').onclick = (e) => { const b = e.target.closest('button'); if (b) sendChat(b.textContent); };
$('chatForm').onsubmit = (e) => { e.preventDefault(); sendChat($('chatInput').value); };
$('chatInput').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat($('chatInput').value); } };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('chatPanel').hidden) toggleChat(false); });


/* ---------------- scan funnel, confidence badges, equity curve ---------------- */

/** Today's scans as a funnel: scans -> setups found -> sent to Jev -> taken (details in the tooltip). */
function scanFunnel(ss, model) {
  const scans = ss.scans || 0;
  const setups = (ss.askedJev || 0) + (ss.seen || 0) + (ss.limit || 0) + (ss.waiting || 0);
  const stages = model === 'jev'
    ? [['Scans', scans], ['Asked Jev', ss.askedJev || 0], ['Taken', ss.taken || 0]]
    : [['Scans', scans], ['Setups', Math.max(setups, ss.askedJev || 0)], ['Sent to Jev', ss.askedJev || 0], ['Taken', ss.taken || 0]];
  const w = (n) => (scans ? Math.max(4, Math.round((Math.log10(n + 1) / Math.log10(scans + 1)) * 100)) : 0);
  return '<div class="funnel">' + stages.map(([label, n], i) => `<div class="funnel-row"><span>${label}</span><div class="funnel-track"><i class="s${i}" style="width:${w(n)}%"></i></div><b>${n.toLocaleString()}</b></div>`).join('') + '</div>';
}

/** Jev confidence as a colour-coded badge: red < 0.5, amber 0.5-0.7, green >= 0.7 (the number is always shown). */
function confBadge(c) {
  const v = Number(c);
  if (!Number.isFinite(v)) return '—';
  const cls = v >= 0.7 ? 'hi' : v >= 0.5 ? 'mid' : 'lo';
  return `<span class="conf ${cls}" title="Jev confidence ${v.toFixed(2)}"><i style="width:${Math.round(Math.min(1, Math.max(0, v)) * 100)}%"></i><em>${v.toFixed(2)}</em></span>`;
}

let eqRange = 'all';
/** Step line of cumulative net P&L (closed trades, by exit time) with a zero line and hover read-out. */
function renderEquity() {
  const box = $('equityPlot');
  if (!box) return;
  const W = Math.max(320, box.clientWidth || 640), H = 220, P = { l: 64, r: 14, t: 12, b: 26 };
  const closed = trades.filter((t) => t.status !== 'open' && t.exitTime && Number.isFinite(Number(t.pnl)))
    .sort((a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime));
  const span = { day: 864e5, week: 7 * 864e5, month: 30 * 864e5 }[eqRange];
  const t0 = span ? Date.now() - span : 0;
  let cum = 0, base = 0;
  const pts = [];
  for (const t of closed) {
    cum += Number(t.pnl);
    if (Date.parse(t.exitTime) < t0) { base = cum; continue; }
    pts.push({ x: Date.parse(t.exitTime), y: cum, t });
  }
  if (!pts.length) { box.innerHTML = '<div class="equity-empty">No closed trades in this range</div>'; return; }
  const all = [{ x: span ? t0 : pts[0].x - 60000, y: base }, ...pts];
  const x0 = all[0].x, x1 = Math.max(all.at(-1).x, x0 + 60000);
  const lo = Math.min(0, ...all.map((p) => p.y)), hi = Math.max(0, ...all.map((p) => p.y));
  const pad = (hi - lo) * 0.08 || 1;
  const X = (x) => P.l + ((x - x0) / (x1 - x0)) * (W - P.l - P.r);
  const Y = (y) => P.t + (1 - (y - (lo - pad)) / (hi + pad - (lo - pad))) * (H - P.t - P.b);
  let d = `M${X(all[0].x).toFixed(1)} ${Y(all[0].y).toFixed(1)}`;
  for (const p of pts) d += ` H${X(p.x).toFixed(1)} V${Y(p.y).toFixed(1)}`;
  const grid = [0, 1, 2, 3].map((k) => lo - pad + ((hi + pad - (lo - pad)) * k) / 3);
  const last = pts.at(-1);
  const fmtD = (x) => new Date(x).toLocaleString([], span && span <= 864e5 ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
    ${grid.map((g) => `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(g).toFixed(1)}" y2="${Y(g).toFixed(1)}" class="eq-grid"/><text x="${P.l - 8}" y="${(Y(g) + 4).toFixed(1)}" class="eq-axis" text-anchor="end">${signedUsd(Math.round(g))}</text>`).join('')}
    <line x1="${P.l}" x2="${W - P.r}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" class="eq-zero"/>
    <text x="${P.l}" y="${H - 6}" class="eq-axis">${fmtD(x0)}</text><text x="${W - P.r}" y="${H - 6}" class="eq-axis" text-anchor="end">${fmtD(x1)}</text>
    <path d="${d}" class="eq-line"/>
    <circle cx="${X(last.x).toFixed(1)}" cy="${Y(last.y).toFixed(1)}" r="4" class="eq-dot ${last.y >= 0 ? 'up' : 'down'}"/>
    <line class="eq-cross" id="eqCross" y1="${P.t}" y2="${H - P.b}" x1="0" x2="0" visibility="hidden"/>
    <rect x="${P.l}" y="${P.t}" width="${W - P.l - P.r}" height="${H - P.t - P.b}" fill="transparent" id="eqHit"/>
  </svg><div class="eq-tip" id="eqTip" hidden></div>`;
  const hit = $('eqHit'), tip = $('eqTip'), cross = $('eqCross');
  hit.onmousemove = (e) => {
    const r = hit.getBoundingClientRect();
    const mx = x0 + ((e.clientX - r.left) / r.width) * (x1 - x0);
    const p = pts.reduce((a, b) => (Math.abs(b.x - mx) < Math.abs(a.x - mx) ? b : a));
    cross.setAttribute('x1', X(p.x)); cross.setAttribute('x2', X(p.x)); cross.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.innerHTML = `<b class="${p.y >= 0 ? 'up' : 'down'}">${signedUsd(p.y)}</b><span>${fmtTime(p.x)}</span><span>${esc(symOf(p.t))} ${esc(p.t.side)} ${signedUsd(p.t.pnl)}</span>`;
    tip.style.left = `${Math.min(X(p.x) + 10, W - 170)}px`;
  };
  hit.onmouseleave = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
}
$('eqRange').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  eqRange = b.dataset.r;
  document.querySelectorAll('#eqRange button').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', String(x === b)); });
  renderEquity();
};
window.addEventListener('resize', () => renderEquity());

/**
 * Jev's answer as a picture: one 100% bar split BUY / SELL / HOLD (or HOLD / CLOSE on a review), each share
 * labelled, plus chips for model confidence, size and leverage. Falls back to the text when it can't be read.
 */
function jevOddsHtml(reasoning) {
  const text = String(reasoning);
  const odds = [...text.matchAll(/\b(BUY|SELL|HOLD|CLOSE) (\d+)%/g)].map((m) => ({ k: m[1], v: Number(m[2]) }));
  if (odds.length < 2) return `<p>${esc(text)}</p>`;
  const conf = /model confidence ([\d.]+)/.exec(text)?.[1];
  const size = /suggested size (\d+)%/.exec(text)?.[1];
  const lev = /leverage (\d+)x/.exec(text)?.[1];
  const top = odds.reduce((a, b) => (b.v > a.v ? b : a));
  const total = odds.reduce((a, o) => a + o.v, 0) || 1;
  const seg = odds.map((o) => `<i class="odd-${o.k.toLowerCase()}${o === top ? ' top' : ''}" style="flex:${Math.max(o.v, 0.0001) / total}" title="${o.k} ${o.v}%"></i>`).join('');
  const legend = odds.map((o) => `<span class="odd-key${o === top ? ' top' : ''}"><i class="odd-${o.k.toLowerCase()}"></i>${o.k} <b>${o.v}%</b></span>`).join('');
  const chips = [
    conf !== undefined ? `<span class="chip">Model conf ${confBadge(Number(conf))}</span>` : '',
    size !== undefined ? `<span class="chip">Size <b>${size}%</b></span>` : '',
    lev !== undefined ? `<span class="chip">Leverage <b>${lev}x</b></span>` : '',
  ].join('');
  return `<div class="odds-viz" title="${esc(text)}"><div class="odds-bar" role="img" aria-label="${esc(odds.map((o) => `${o.k} ${o.v}%`).join(', '))}">${seg}</div>
    <div class="odds-legend">${legend}</div>${chips ? `<div class="odds-chips">${chips}</div>` : ''}</div>`;
}
