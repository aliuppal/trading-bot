// Server-side trade "screenshots": a self-contained SVG chart of the candles around a trade,
// with the IFVG zone and the entry / stop / target levels. Works without a browser, so it also
// runs on serverless hosts. Colours follow the Obsidian Terminal design system.

const C = {
  bg: '#0A0E17', grid: '#1A2333', axis: '#64748B', text: '#CBD5E1',
  up: '#10B981', down: '#F43F5E', cyan: '#06B6D4', entry: '#CBD5E1',
};
const W = 800, H = 400;
const PAD = { l: 12, r: 84, t: 40, b: 26 };
const MONO = "font-family=\"'JetBrains Mono',ui-monospace,Consolas,monospace\"";

const f1 = (v) => Number(v.toFixed(1));
const money = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const label = (s) => String(s).replace(/[<>&"]/g, '');

function candleIndexAt(candles, t) {
  let idx = 0;
  for (let i = 0; i < candles.length; i++) if (candles[i].time <= t) idx = i;
  return idx;
}

/**
 * candles: oldest-first. trade: { entryTime, entryPrice, stop, target, ifvg, exitTime?, exitPrice?, status, pnl? }.
 * phase: 'entry' | 'exit'.
 */
export function renderTradeSvg({ candles, trade, phase = 'entry', granularity = 3600 }) {
  if (!candles?.length) return '';
  const entryT = new Date(trade.entryTime).getTime();
  const exitT = trade.exitTime ? new Date(trade.exitTime).getTime() : null;
  const entryIdx = candleIndexAt(candles, entryT);
  const zoneIdx = trade.ifvg?.formedAt ? candleIndexAt(candles, trade.ifvg.formedAt) : entryIdx;
  const endIdx = phase === 'exit' && exitT ? candleIndexAt(candles, exitT) : candles.length - 1;
  let start = Math.max(0, Math.min(zoneIdx, entryIdx) - 12);
  if (endIdx - start > 90) start = Math.max(0, endIdx - 90);
  const view = candles.slice(start, endIdx + 1);
  const n = view.length;

  const levels = [trade.stop, trade.target, trade.entryPrice, trade.exitPrice, trade.ifvg?.top, trade.ifvg?.bottom].filter(Number.isFinite);
  let lo = Math.min(...view.map((c) => c.low), ...levels);
  let hi = Math.max(...view.map((c) => c.high), ...levels);
  const padY = (hi - lo) * 0.06 || hi * 0.001;
  lo -= padY; hi += padY;

  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
  const step = plotW / Math.max(n, 1);
  const x = (i) => PAD.l + step * (i + 0.5);
  const y = (p) => PAD.t + (1 - (p - lo) / (hi - lo)) * plotH;
  const cw = Math.max(1, step * 0.62);
  const parts = [];

  parts.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);
  for (let k = 0; k <= 4; k++) {
    const p = lo + ((hi - lo) * k) / 4;
    parts.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${f1(y(p))}" y2="${f1(y(p))}" stroke="${C.grid}"/>`);
    parts.push(`<text x="${W - PAD.r + 8}" y="${f1(y(p) + 4)}" fill="${C.axis}" font-size="10" ${MONO}>${Math.round(p).toLocaleString('en-US')}</text>`);
  }

  // IFVG zone
  if (trade.ifvg) {
    const zx = x(Math.max(0, zoneIdx - start)) - step / 2;
    const zy = y(trade.ifvg.top), zh = Math.max(1, y(trade.ifvg.bottom) - zy);
    parts.push(`<rect x="${f1(zx)}" y="${f1(zy)}" width="${f1(W - PAD.r - zx)}" height="${f1(zh)}" fill="${C.cyan}" fill-opacity=".12" stroke="${C.cyan}" stroke-opacity=".45" stroke-dasharray="3 3"/>`);
    parts.push(`<text x="${f1(zx + 4)}" y="${f1(zy - 4)}" fill="${C.cyan}" font-size="10" ${MONO}>IFVG</text>`);
  }

  // candles
  view.forEach((c, i) => {
    const col = c.close >= c.open ? C.up : C.down;
    const top = y(Math.max(c.open, c.close));
    const h = Math.max(1, y(Math.min(c.open, c.close)) - top);
    parts.push(`<line x1="${f1(x(i))}" x2="${f1(x(i))}" y1="${f1(y(c.high))}" y2="${f1(y(c.low))}" stroke="${col}"/>`);
    parts.push(`<rect x="${f1(x(i) - cw / 2)}" y="${f1(top)}" width="${f1(cw)}" height="${f1(h)}" fill="${col}"/>`);
  });

  // risk / reward boxes and levels, from the entry candle to the right edge
  const ex = x(entryIdx - start);
  const span = f1(W - PAD.r - ex);
  parts.push(`<rect x="${f1(ex)}" y="${f1(y(trade.target))}" width="${span}" height="${f1(y(trade.entryPrice) - y(trade.target))}" fill="${C.up}" fill-opacity=".07"/>`);
  parts.push(`<rect x="${f1(ex)}" y="${f1(y(trade.entryPrice))}" width="${span}" height="${f1(y(trade.stop) - y(trade.entryPrice))}" fill="${C.down}" fill-opacity=".07"/>`);
  const level = (p, col, name, dash = '') => {
    const ly = f1(y(p));
    parts.push(`<line x1="${f1(ex)}" x2="${W - PAD.r}" y1="${ly}" y2="${ly}" stroke="${col}" stroke-width="1.4"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
    parts.push(`<rect x="${W - PAD.r + 2}" y="${f1(ly - 8)}" width="${PAD.r - 4}" height="16" rx="2" fill="${col}" fill-opacity=".16" stroke="${col}" stroke-opacity=".5"/>`);
    parts.push(`<text x="${W - PAD.r + 6}" y="${f1(ly + 4)}" fill="${col}" font-size="10" ${MONO}>${name} ${Math.round(p).toLocaleString('en-US')}</text>`);
  };
  level(trade.target, C.up, 'TP');
  level(trade.entryPrice, C.entry, 'IN', '4 3');
  level(trade.stop, C.down, 'SL');

  // entry marker
  parts.push(`<path d="M${f1(ex)} ${f1(y(trade.entryPrice) + 4)} l-6 10 h12 z" fill="${C.up}"/>`);

  // exit marker
  if (phase === 'exit' && Number.isFinite(trade.exitPrice) && exitT) {
    const xx = x(Math.min(n - 1, candleIndexAt(candles, exitT) - start));
    const col = trade.pnl >= 0 ? C.up : C.down;
    parts.push(`<circle cx="${f1(xx)}" cy="${f1(y(trade.exitPrice))}" r="5" fill="${C.bg}" stroke="${col}" stroke-width="2"/>`);
  }

  // header + footer text
  const tf = granularity >= 86400 ? `${granularity / 86400}d` : granularity >= 3600 ? `${granularity / 3600}h` : `${granularity / 60}m`;
  const when = new Date(phase === 'exit' && exitT ? exitT : entryT).toISOString().replace('T', ' ').slice(0, 16);
  let right = 'ENTRY';
  if (phase === 'exit') {
    const res = trade.status === 'win' ? 'TARGET HIT' : trade.status === 'loss' ? 'STOPPED OUT' : 'CLOSED';
    right = `${res}  ${trade.pnl >= 0 ? '+' : '-'}$${money(Math.abs(trade.pnl || 0))}`;
  }
  const rightCol = phase === 'exit' ? (trade.pnl >= 0 ? C.up : C.down) : C.cyan;
  parts.push(`<text x="${PAD.l}" y="22" fill="${C.text}" font-size="12" font-weight="600" ${MONO}>BTC-USD · ${tf} · LONG · ${label(when)} UTC</text>`);
  parts.push(`<text x="${W - 12}" y="22" fill="${rightCol}" font-size="12" font-weight="600" text-anchor="end" ${MONO}>${label(right)}</text>`);
  parts.push(`<text x="${PAD.l}" y="${H - 8}" fill="${C.axis}" font-size="10" ${MONO}>R:R 1:1 · risk $${money(trade.entryPrice - trade.stop)}/BTC</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Trade chart (${label(phase)})">${parts.join('')}</svg>`;
}
