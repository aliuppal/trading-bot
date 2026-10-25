// Strategy v2 phase 3 report: each switch alone vs the current rules, all symbols together, tuning vs held-out period.
//
//   node scripts/v2report.js --dir=<folder with <run>__<SYMBOL>.json from backtest --json> --split=2026-09-24 [--out=report.md]
//
// Runs simulated by the backtester: baseline and every switch that can change which trades happen.
// Derived from the baseline trades (no simulation needed):
//   riskByGrade                          same trades; A trades count half (A+ full)
//   ceCheck / singularCheck / openBias   only cap A+ at A: same trades, scored with risk by grade
//   corrCap / dailyStopR                 portfolio rules across symbols: applied to the merged baseline trades in time order
//                                        (approximation: a skipped trade does not free its symbol for a later setup)
import fs from 'node:fs';
import path from 'node:path';
import { applyV2Rules, corrCapHit } from '../src/grade.js';

const opt = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const DIR = opt.dir;
const SPLIT = opt.split || '2026-09-24';

const runs = {};
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json') && x.includes('__'))) {
  const [run] = f.replace(/\.json$/, '').split('__');
  (runs[run] ||= []).push(...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
}
const symbolsOf = (run) => new Set((runs[run] || []).map((t) => t.symbol)).size;

const byExit = (a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime);
const weightOf = (t) => (t.grade === 'A+' ? 1 : 0.5);

/** trades, win %, R per trade, max drawdown in R, longest losing streak (weighted: A trades at half risk). */
function metrics(list, weighted = false) {
  const ts = [...list].sort(byExit);
  const rr = (t) => (t.r || 0) * (weighted ? weightOf(t) : 1);
  const w = ts.filter((t) => t.status === 'win').length, l = ts.filter((t) => t.status === 'loss').length;
  let cum = 0, peak = 0, dd = 0, streak = 0, worst = 0;
  for (const t of ts) {
    cum += rr(t); peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum);
    streak = rr(t) < 0 ? streak + 1 : 0; worst = Math.max(worst, streak);
  }
  const total = ts.reduce((n, t) => n + rr(t), 0);
  return { n: ts.length, win: w + l ? Math.round((w / (w + l)) * 100) : 0, rpt: ts.length ? total / ts.length : 0, total, dd, streak: worst };
}
const split = (list) => [list.filter((t) => t.entryTime < SPLIT), list.filter((t) => t.entryTime >= SPLIT)];

// ---- derived switches ----
const base = runs.baseline || [];
const derived = {};
derived.riskByGrade = { trades: base, weighted: true, note: 'same trades as the baseline, A trades at half risk' };
for (const k of ['ceCheck', 'singularCheck', 'openBias']) {
  derived[k] = {
    trades: base.map((t) => ({ ...t, grade: applyV2Rules({ direction: t.side === 'short' ? 'bearish' : 'bullish', grade: t.grade, v2: t.v2 || {} }, { [k]: true }, { opens: t.v2?.opens, price: t.entryPrice }).grade })),
    weighted: true, note: 'only caps A+ at A: same trades, scored with risk by grade (baseline also with risk by grade)',
  };
}
{
  const kept = [];
  for (const t of [...base].sort((a, b) => Date.parse(a.entryTime) - Date.parse(b.entryTime))) {
    const open = kept.filter((k) => Date.parse(k.entryTime) <= Date.parse(t.entryTime) && Date.parse(k.exitTime) > Date.parse(t.entryTime)).map((k) => ({ ...k, status: 'open' }));
    if (!corrCapHit(open, t.symbol, t.side)) kept.push(t);
  }
  derived.corrCap = { trades: kept, note: 'merged baseline, a trade is dropped when 2 same-direction trades are already open in its cluster' };
}
{
  const kept = [];
  for (const t of [...base].sort((a, b) => Date.parse(a.entryTime) - Date.parse(b.entryTime))) {
    const day = t.entryTime.slice(0, 10);
    const lost = kept.filter((k) => k.exitTime.slice(0, 10) === day && k.exitTime < t.entryTime).reduce((n, k) => n + (k.r || 0), 0);
    if (lost > -3) kept.push(t);
  }
  derived.dailyStopR = { trades: kept, note: 'merged baseline, no entries for the rest of the UTC day once the day is at -3R' };
}

// ---- report ----
const f2 = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
const row = (label, m) => `| ${label} | ${m.n} | ${m.win}% | ${f2(m.rpt)} | ${f2(m.total)} | ${m.dd.toFixed(2)} | ${m.streak} |`;
const head = '| | Trades | Win | R / trade | Total R | Max DD (R) | Longest losing streak |\n|---|---|---|---|---|---|---|';
const out = [];
const verdict = (b, s) => (s.rpt > b.rpt && s.dd < b.dd ? 'PASS (R / trade and max DD both better)' : s.rpt > b.rpt ? 'mixed (R / trade better, DD not)' : s.dd < b.dd ? 'mixed (DD better, R / trade not)' : 'FAIL');
const summary = [];

function section(name, list, { weighted = false, note = '' } = {}) {
  const [bt, bh] = split(base).map((x) => metrics(x, weighted));
  const [st, sh] = split(list).map((x) => metrics(x, weighted));
  out.push(`### ${name}${note ? `\n_${note}_` : ''}\n`);
  out.push(`**Tuning (before ${SPLIT})**\n\n${head}\n${row('Current rules', bt)}\n${row(name, st)}\n`);
  out.push(`**Held-out 30 days (from ${SPLIT})**\n\n${head}\n${row('Current rules', bh)}\n${row(name, sh)}\n`);
  const syms = [...new Set(base.map((t) => t.symbol))].sort();
  out.push(`Held-out R / trade by symbol: ${syms.map((s) => `${s.replace(/USD[CT]$/, '')} ${f2(metrics(split(base.filter((t) => t.symbol === s))[1], weighted).rpt)} -> ${f2(metrics(split(list.filter((t) => t.symbol === s))[1], weighted).rpt)}`).join(' · ')}\n`);
  out.push(`Held-out verdict: **${verdict(bh, sh)}**\n`);
  summary.push({ name, bt, st, bh, sh, weighted, v: verdict(bh, sh) });
}

const ORDER = ['poolSweeps', 'gradeV2', 'riskByGrade', 'ceCheck', 'singularCheck', 'chopCheck', 'speedCheck', 'pdCheck', 'smtV2', 'openBias',
  'killzoneTest', 'corrCap', 'dailyStopR', 'lossCooldown', 'stopV2', 'minTargetR', 'limitEntry', 'invalidationExit'];
for (const k of ORDER) {
  if (derived[k]) section(k, derived[k].trades, derived[k]);
  else if (runs[k]) section(k, runs[k], { note: symbolsOf(k) < symbolsOf('baseline') ? `only ${symbolsOf(k)} of ${symbolsOf('baseline')} symbols finished` : '' });
  else out.push(`### ${k}\n_not run_\n`);
}

const sumHead = '| Switch | Tuning R/trade (now -> switch) | Held-out trades | Held-out R/trade (now -> switch) | Held-out max DD (now -> switch) | Verdict |\n|---|---|---|---|---|---|';
const sumRows = summary.map((s) => `| ${s.name}${s.weighted ? ' *' : ''} | ${f2(s.bt.rpt)} -> ${f2(s.st.rpt)} | ${s.bh.n} -> ${s.sh.n} | ${f2(s.bh.rpt)} -> ${f2(s.sh.rpt)} | ${s.bh.dd.toFixed(2)} -> ${s.sh.dd.toFixed(2)} | ${s.v} |`);
const doc = `# Strategy v2: each switch alone vs the current rules\n\nBaseline: ${base.length} trades on ${symbolsOf('baseline')} symbols. Split at ${SPLIT}. * = scored with A trades at half risk (both columns).\n\n${sumHead}\n${sumRows.join('\n')}\n\n${out.join('\n')}`;
if (opt.out) fs.writeFileSync(opt.out, doc);
console.log(doc);
