import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecision, decide, buildPrompt, ruleBasedDecision, resetFreeModelCache } from '../src/ai.js';
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
  const d = await decide(ctx, { provider: 'gemini', apiKey: 'k', model: 'gemini-2.5-flash' }, fetchImpl);
  assert.equal(d.action, 'SELL');
  assert.equal(d.source, 'gemini:gemini-2.5-flash');
  assert.match(called.url, /gemini-2\.5-flash:generateContent$/);
  assert.equal(called.opts.headers['x-goog-api-key'], 'k');
  const body = JSON.parse(called.opts.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
});

test('decide falls back to rules on Gemini error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'quota' });
  const d = await decide(ctx, { provider: 'gemini', apiKey: 'k', model: 'm' }, fetchImpl);
  assert.equal(d.source, 'rules (Gemini error)');
  assert.match(d.error, /429/);
});

test('decide uses rules without key', async () => {
  const d = await decide(ctx, { provider: 'none', apiKey: '' });
  assert.match(d.source, /no AI key/);
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

const json = (d, status = 200) => ({ ok: status < 400, status, json: async () => d, text: async () => JSON.stringify(d) });
const MODELS = {
  data: [
    { id: 'paid/model', pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 999999 },
    { id: 'vendor/big:free', pricing: { prompt: '0', completion: '0' }, context_length: 128000 },
    { id: 'vendor/small:free', pricing: { prompt: '0', completion: '0' }, context_length: 32000 },
  ],
};
const chat = (obj, model) => json({ model, choices: [{ message: { content: '```json\n' + JSON.stringify(obj) + '\n```' } }] });

test('OpenRouter auto picks a free model and sends bearer key', async () => {
  resetFreeModelCache();
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.endsWith('/models')) return json(MODELS);
    const body = JSON.parse(opts.body);
    return chat({ action: 'BUY', confidence: 0.7, size_pct: 5, reasoning: 'r' }, body.model);
  };
  const d = await decide(ctx, { provider: 'openrouter', apiKey: 'sk-or-test', model: 'auto' }, fetchImpl);
  assert.equal(d.action, 'BUY');
  assert.equal(d.source, 'openrouter:vendor/big:free');
  const post = calls.find((c) => c.url.endsWith('/chat/completions'));
  assert.equal(post.opts.headers.Authorization, 'Bearer sk-or-test');
  assert.ok(!calls.some((c) => c.opts.body?.includes('paid/model')));
});

test('OpenRouter falls through to next free model on 429', async () => {
  resetFreeModelCache();
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/models')) return json(MODELS);
    const { model } = JSON.parse(opts.body);
    if (model === 'vendor/big:free') return json({ error: 'rate limited' }, 429);
    return chat({ action: 'HOLD', confidence: 0.5, size_pct: 0, reasoning: 'r' }, model);
  };
  const d = await decide(ctx, { provider: 'openrouter', apiKey: 'k', model: 'auto' }, fetchImpl);
  assert.equal(d.source, 'openrouter:vendor/small:free');
});

test('OpenRouter bad key stops retrying and falls back to rules', async () => {
  resetFreeModelCache();
  let posts = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/models')) return json(MODELS);
    posts++;
    return json({ error: 'no auth' }, 401);
  };
  const d = await decide(ctx, { provider: 'openrouter', apiKey: 'bad', model: 'auto' }, fetchImpl);
  assert.equal(posts, 1);
  assert.equal(d.source, 'rules (OpenRouter error)');
  assert.match(d.error, /401/);
});

test('OpenRouter uses a fixed model when configured', async () => {
  let listed = false;
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/models')) { listed = true; return json(MODELS); }
    return chat({ action: 'SELL', confidence: 0.9, size_pct: 100, reasoning: 'r' }, JSON.parse(opts.body).model);
  };
  const d = await decide(ctx, { provider: 'openrouter', apiKey: 'k', model: 'x/y:free' }, fetchImpl);
  assert.equal(d.source, 'openrouter:x/y:free');
  assert.equal(listed, false);
});
