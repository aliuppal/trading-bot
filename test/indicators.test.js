import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, macd, summarize } from '../src/indicators.js';
import { makeCandles } from './helpers.js';

test('sma', () => {
  assert.equal(sma([1, 2, 3, 4, 5], 5), 3);
  assert.equal(sma([1, 2], 5), null);
});

test('ema of a constant series is the constant', () => {
  assert.ok(Math.abs(ema(new Array(30).fill(7), 10) - 7) < 1e-9);
});

test('rsi extremes', () => {
  const up = Array.from({ length: 30 }, (_, i) => i);
  assert.equal(rsi(up), 100);
  const down = Array.from({ length: 30 }, (_, i) => 30 - i);
  assert.ok(rsi(down) < 1);
});

test('macd positive in uptrend', () => {
  const up = Array.from({ length: 60 }, (_, i) => 100 + i * i * 0.1);
  assert.ok(macd(up).macd > 0);
});

test('summarize returns all fields', () => {
  const s = summarize(makeCandles());
  for (const k of ['price', 'rsi_14', 'sma_20', 'sma_50', 'macd', 'bollinger', 'change_24']) assert.ok(s[k] !== null && s[k] !== undefined, k);
});
