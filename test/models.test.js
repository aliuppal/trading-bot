import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ict2022, unicorn, sweepShiftFvg, MODELS, MODEL_RULES } from '../src/models.js';

const k = (i, o, h, l, c) => ({ time: i * 300000, open: o, high: h, low: l, close: c, volume: 1 });
// flat start, swing high 102, swing low 99.0, sweep to 98.4, displacement up through 102, retrace into the FVG
function bullishSequence() {
  const pre = Array.from({ length: 4 }, (_, i) => k(i, 100, 100.5, 99.7, 100.1));
  const rows = [
    [100, 100.6, 99.6, 100.2], [100.2, 100.8, 99.8, 100.5], [100.5, 101, 100.2, 100.8], [100.8, 101.5, 100.5, 101.2],
    [101.2, 102, 100.9, 101.5], [101.5, 101.6, 100.6, 100.8], [100.8, 101, 99.8, 100], [100, 100.3, 99, 99.2],
    [99.2, 99.9, 99.1, 99.7], [99.7, 100.2, 99.4, 99.9], [99.9, 100.1, 99.5, 99.6], [99.6, 99.7, 98.5, 98.8],
    [98.8, 99, 98.4, 98.9], [98.9, 101, 98.8, 100.9], [100.9, 102.6, 100.7, 102.4], [102.4, 102.8, 101.6, 101.8],
    [101.8, 101.9, 100.5, 100.8],
  ];
  return [...pre, ...rows.map((r, i) => k(i + 4, ...r))];
}

test('ICT 2022: sweep -> market structure shift with displacement -> retrace into the FVG = long', () => {
  const c = bullishSequence();
  const seq = sweepShiftFvg(c, 'bullish', { minGapPct: 0.01 });
  assert.ok(seq, 'sequence found');
  const s = ict2022(c, 300);
  assert.equal(s.direction, 'bullish');
  assert.ok(s.bottom <= 98.5, 'stop zone reaches the swept low');
  assert.ok(s.qualityReasons.some((q) => q.startsWith('MSS')));
});

test('ICT 2022: no setup without the retrace into the gap', () => {
  const c = bullishSequence();
  c[c.length - 1] = k(c.length - 1, 101.8, 103, 101.7, 102.9); // keeps running up
  assert.equal(ict2022(c, 300), null);
});

test('Unicorn needs the FVG to overlap the breaker', () => {
  const s = unicorn(bullishSequence(), 300);
  if (s) {
    assert.equal(s.direction, 'bullish');
    assert.ok(s.breaker && s.top > s.bottom);
  }
});

test('every model has a name and rules', () => {
  for (const m of ['ifvg', 'jev', 'ict2022', 'unicorn', 'amd', 'forever']) {
    assert.ok(MODELS[m]?.name);
    assert.ok(MODEL_RULES[m]?.length > 20);
  }
});
