import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecision, decide, buildPrompt, ruleBasedDecision } from '../src/ai.js';
import { summarize } from '../src/indicators.js';
import { makeCandles, geminiResponse } from './helpers.js';

const candles = makeCandles();
const ctx = {
  indicators: summarize(candles),
  account: { cash: 100000, btc: 0, avgEntry: 0, equity: 100000 },
  recentCandles: candles.slice(-24),
  granularity: 3600,
};

test('parseDecision handles fenced JSON and 0-100 confidence', () => {
  const d = parseDecision('```json\n{"action":"buy","confidence":80,"size_pct":5,"reasoning":"x"}\n```');
  assert.deepEqual(d, { action: 'BUY', confidence: 0.8, sizePct: 5, reasoning: 'x' });
});

test('parseDecision rejects bad action', () => {
  assert.throws(() => parseDecision({ action: 'MOON' }));
});

test('decide uses Gemini when key set', async () => {
  let called;
  const fetchImpl = async (url, opts) => {
    called = { url, opts };
    return geminiResponse({ action: 'SELL', confidence: 0.9, size_pct: 50, reasoning: 'overbought' })();
  };
  const d = await decide(ctx, { apiKey: 'k', model: 'gemini-2.5-flash' }, fetchImpl);
  assert.equal(d.action, 'SELL');
  assert.equal(d.source, 'gemini:gemini-2.5-flash');
  assert.match(called.url, /gemini-2\.5-flash:generateContent$/);
  assert.equal(called.opts.headers['x-goog-api-key'], 'k');
  const body = JSON.parse(called.opts.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
});

test('decide falls back to rules on Gemini error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'quota' });
  const d = await decide(ctx, { apiKey: 'k', model: 'm' }, fetchImpl);
  assert.equal(d.source, 'rules (Gemini error)');
  assert.match(d.error, /429/);
});

test('decide uses rules without key', async () => {
  const d = await decide(ctx, { apiKey: '', model: 'm' });
  assert.match(d.source, /no GEMINI_API_KEY/);
});

test('rule-based buys when oversold and bullish', () => {
  const d = ruleBasedDecision({ rsi_14: 25, macd: { histogram: 1 }, sma_20: null, sma_50: null, price: 1 });
  assert.equal(d.action, 'BUY');
});

test('prompt includes account and indicators', () => {
  const p = buildPrompt(ctx);
  assert.match(p, /Cash \(USD\): 100000\.00/);
  assert.match(p, /rsi_14/);
});
