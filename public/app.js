const $ = (id) => document.getElementById(id);
const usd = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '—'
  : `${v < 0 ? '-' : ''}$${Math.abs(Number(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

let candles = [];
let decisions = [];

function drawChart() {
  const canvas = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = 320;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!candles.length) return;

  const pad = { l: 8, r: 70, t: 10, b: 20 };
  const lo = Math.min(...candles.map((c) => c.low));
  const hi = Math.max(...candles.map((c) => c.high));
  const x = (i) => pad.l + (i / (candles.length - 1)) * (w - pad.l - pad.r);
  const y = (p) => pad.t + (1 - (p - lo) / (hi - lo || 1)) * (h - pad.t - pad.b);
  const css = getComputedStyle(document.documentElement);

  // grid + price labels
  ctx.strokeStyle = css.getPropertyValue('--border'); ctx.fillStyle = css.getPropertyValue('--muted');
  ctx.font = '11px system-ui'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const p = lo + ((hi - lo) * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y(p)); ctx.lineTo(w - pad.r, y(p)); ctx.stroke();
    ctx.fillText(Math.round(p).toLocaleString(), w - pad.r + 6, y(p) + 4);
  }

  // candles
  const cw = Math.max(1, ((w - pad.l - pad.r) / candles.length) * 0.6);
  candles.forEach((c, i) => {
    const up = c.close >= c.open;
    ctx.strokeStyle = ctx.fillStyle = up ? css.getPropertyValue('--green') : css.getPropertyValue('--red');
    ctx.beginPath(); ctx.moveTo(x(i), y(c.high)); ctx.lineTo(x(i), y(c.low)); ctx.stroke();
    const top = y(Math.max(c.open, c.close));
    ctx.fillRect(x(i) - cw / 2, top, cw, Math.max(1, y(Math.min(c.open, c.close)) - top));
  });

  // SMA20
  ctx.strokeStyle = css.getPropertyValue('--blue'); ctx.lineWidth = 1.5; ctx.beginPath();
  candles.forEach((c, i) => {
    if (i < 19) return;
    const avg = candles.slice(i - 19, i + 1).reduce((a, b) => a + b.close, 0) / 20;
    i === 19 ? ctx.moveTo(x(i), y(avg)) : ctx.lineTo(x(i), y(avg));
  });
  ctx.stroke();

  // executed AI trades as markers
  const t0 = candles[0].time, t1 = candles[candles.length - 1].time;
  decisions.filter((d) => d.executed && d.price).forEach((d) => {
    const t = new Date(d.time).getTime();
    if (t < t0) return;
    const i = Math.min(candles.length - 1, ((t - t0) / (t1 - t0 || 1)) * (candles.length - 1));
    const buy = d.action === 'BUY';
    ctx.fillStyle = buy ? css.getPropertyValue('--green') : css.getPropertyValue('--red');
    const px = x(i), py = y(d.price) + (buy ? 14 : -14);
    ctx.beginPath();
    ctx.moveTo(px, py + (buy ? -8 : 8)); ctx.lineTo(px - 6, py + (buy ? 2 : -2)); ctx.lineTo(px + 6, py + (buy ? 2 : -2));
    ctx.closePath(); ctx.fill();
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
  const ch = ind.change_24;
  $('change').innerHTML = ch === null ? '—' : `<span class="${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '+' : ''}${ch}%</span> last 24 candles`;
}

async function loadMarket() {
  try {
    const data = await api(`/api/market?granularity=${$('granularity').value}`);
    candles = data.candles;
    renderIndicators(data.indicators);
    drawChart();
  } catch (e) { toast(`Market data: ${e.message}`, true); }
}

async function loadAccount() {
  try {
    const a = await api('/api/account');
    $('equity').textContent = usd(a.equity);
    $('cash').textContent = usd(a.cash);
    $('btc').textContent = `${Number(a.btc).toFixed(6)} BTC`;
    $('avgEntry').textContent = a.avgEntry ? `avg entry ${usd(a.avgEntry)} · worth ${usd(a.btc * a.price)}` : 'no position';
    if (a.startingCash) {
      const pnl = a.equity - a.startingCash;
      const pct = (pnl / a.startingCash) * 100;
      $('pnl').innerHTML = `<span class="${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}${usd(pnl)} (${pct.toFixed(2)}%)</span>`;
    } else {
      $('pnl').textContent = a.accountEquity ? `total account ${usd(a.accountEquity)}` : '';
    }
    $('resetBtn').style.display = a.broker === 'local' ? '' : 'none';
  } catch (e) { toast(`Account: ${e.message}`, true); }
}

function renderDecision(d) {
  if (!d) return '';
  return `<div><span class="pill ${esc(d.action)}">${esc(d.action)}</span>
    ${d.confidence !== undefined ? ` confidence ${esc(d.confidence)}` : ''} · ${fmtTime(d.time)}</div>
    <p>${esc(d.reasoning || '')}</p>
    <div class="sub">${esc(d.note || '')}${d.executed ? ' ✓ executed' : ''}${d.aiError ? ` · AI error: ${esc(d.aiError)}` : ''}</div>`;
}

async function loadDecisions() {
  try {
    decisions = await api('/api/decisions');
    $('lastDecision').innerHTML = renderDecision(decisions[0]);
    $('decisions').querySelector('tbody').innerHTML = decisions.map((d) => `<tr>
      <td>${fmtTime(d.time)}</td><td>${usd(d.price)}</td>
      <td><span class="pill ${esc(d.action)}">${esc(d.action)}</span></td>
      <td>${d.confidence ?? '—'}</td>
      <td>${d.executed ? '✓ ' : ''}${esc(d.note || '')}</td>
      <td class="reason">${esc(d.reasoning || '')}</td>
      <td>${esc(d.source || '')}</td></tr>`).join('') || '<tr><td colspan="7" class="sub">No decisions yet. Click "Ask AI now".</td></tr>';
    drawChart();
  } catch (e) { toast(`Decisions: ${e.message}`, true); }
}

async function loadOrders() {
  try {
    const orders = await api('/api/orders');
    $('orders').querySelector('tbody').innerHTML = orders.map((o) => `<tr>
      <td>${fmtTime(o.time)}</td><td><span class="pill ${esc(o.side)}">${esc(o.side?.toUpperCase())}</span></td>
      <td>${o.qty ? Number(o.qty).toFixed(6) : '—'}</td><td>${usd(o.price)}</td><td>${usd(o.notional)}</td>
      <td>${o.pnl !== undefined ? `<span class="${o.pnl >= 0 ? 'up' : 'down'}">${usd(o.pnl)}</span>` : '—'}</td>
      <td>${esc(o.status)}</td><td>${esc(o.source)}</td></tr>`).join('') || '<tr><td colspan="8" class="sub">No orders yet.</td></tr>';
  } catch (e) { toast(`Orders: ${e.message}`, true); }
}

let settingsLoaded = false;
async function loadStatus() {
  try {
    const s = await api('/api/status');
    $('aiBadge').textContent = `AI: ${s.ai}`;
    $('brokerBadge').textContent = `Broker: ${s.broker}`;
    $('botDot').className = `dot${s.running ? ' on' : ''}`;
    $('botState').textContent = s.busy ? 'Thinking…' : s.running ? 'Running' : 'Stopped';
    $('botTimes').textContent = `Last run: ${fmtTime(s.lastRun)}${s.nextRun ? ` · Next: ${fmtTime(s.nextRun)}` : ''}`;
    if (!settingsLoaded) {
      const f = $('settingsForm');
      for (const [k, v] of Object.entries(s.settings)) if (f.elements[k]) f.elements[k].value = v;
      settingsLoaded = true;
    }
  } catch (e) { toast(`Status: ${e.message}`, true); }
}

const refreshAll = () => Promise.all([loadStatus(), loadAccount(), loadDecisions(), loadOrders()]);

async function withBtn(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
}

$('startBtn').onclick = (e) => withBtn(e.target, async () => { await api('/api/bot/start', { method: 'POST' }); toast('Bot started'); setTimeout(refreshAll, 1500); refreshAll(); });
$('stopBtn').onclick = (e) => withBtn(e.target, async () => { await api('/api/bot/stop', { method: 'POST' }); toast('Bot stopped'); refreshAll(); });
$('runBtn').onclick = (e) => withBtn(e.target, async () => {
  $('botState').textContent = 'Thinking…';
  const d = await api('/api/bot/run', { method: 'POST' });
  toast(`AI says ${d.action}${d.executed ? ' — order executed' : ''}`, d.action === 'ERROR');
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
  if (!confirm('Reset the local paper account to starting cash? Order history will be cleared.')) return;
  withBtn(e.target, async () => { await api('/api/reset', { method: 'POST' }); toast('Account reset'); refreshAll(); });
};
$('granularity').onchange = loadMarket;
window.addEventListener('resize', drawChart);

refreshAll();
loadMarket();
setInterval(refreshAll, 15000);
setInterval(loadMarket, 60000);
