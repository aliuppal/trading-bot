import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecision, decide, buildPrompt, ruleBasedDecision, resetFreeModelCache, scoreToPct, buildJevState } from '../src/ai.js';
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
  assert.deepEqual(d, { action: 'BUY', confidence: 0.8, sizePct: 5, leverage: 1, reasoning: 'x' });
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
    { id: 'music/gen', pricing: { prompt: '0', completion: '0' }, context_length: 9999999, architecture: { input_modalities: ['text'], output_modalities: ['text', 'audio'] } },
    { id: 'vendor/content-safety:free', pricing: { prompt: '0', completion: '0' }, context_length: 9999999 },
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

test('listFreeModels keeps only text chat models and puts openrouter/free last', async () => {
  resetFreeModelCache();
  const { listFreeModels } = await import('../src/ai.js');
  const data = [...MODELS.data, { id: 'openrouter/free', pricing: { prompt: '0', completion: '0' }, context_length: 99999999 }];
  const ids = await listFreeModels(async () => json({ data }));
  assert.deepEqual(ids, ['vendor/big:free', 'vendor/small:free', 'openrouter/free']);
  resetFreeModelCache();
});

// Shape copied from a live /api/alpha/decisions response.
const jevAnswer = (choice, probabilities, score) => json({
  model: 'typesafe/jev-1.13-20260917',
  answers: {
    action: { type: 'choice', choice, probabilities, confidence: 0.74 },
    size: { type: 'score', score, legend: {}, probabilities: {}, confidence: 0.2 },
  },
  usage: { input_tokens: 514, output_tokens: 54, cost: 0.000021588 },
});

test('scoreToPct interpolates between size levels', () => {
  assert.equal(scoreToPct(0), 0);
  assert.equal(scoreToPct(1.18), 5.9);
  assert.equal(scoreToPct(3.5), 37.5);
  assert.equal(scoreToPct(99), 100);
});

test('buildJevState flattens indicators and account', () => {
  const st = buildJevState(ctx);
  assert.equal(st.symbol, 'BTC/USD');
  assert.equal(typeof st.macd_histogram, 'number');
  assert.equal(st.recent_closes.length, 24);
  assert.equal(st.cash_usd, 100000);
});

test('decide uses Jev decisions endpoint', async () => {
  let call;
  const fetchImpl = async (url, opts) => {
    call = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
    return jevAnswer('BUY', { BUY: 0.81, HOLD: 0.15, SELL: 0.04 }, 2);
  };
  const d = await decide(ctx, { provider: 'jev', apiKey: 'sk-or-x', model: 'typesafe/jev-1.13' }, fetchImpl);
  assert.equal(call.url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(call.body.model, 'typesafe/jev-1.13');
  assert.equal(call.body.questions.action.type, 'choice');
  assert.equal(call.auth, 'Bearer sk-or-x');
  assert.equal(d.action, 'BUY');
  assert.equal(d.confidence, 0.81);
  assert.equal(d.sizePct, 10);
  assert.equal(d.source, 'jev:typesafe/jev-1.13-20260917');
  assert.match(d.reasoning, /BUY 81%/);
});

test('Jev failure falls back to free OpenRouter chat models', async () => {
  resetFreeModelCache();
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('/alpha/decisions')) return json({ error: { message: 'busy' } }, 503);
    if (url.endsWith('/models')) return json(MODELS);
    return chat({ action: 'HOLD', confidence: 0.5, size_pct: 0, reasoning: 'r' }, JSON.parse(opts.body).model);
  };
  const d = await decide(ctx, { provider: 'jev', apiKey: 'k', model: 'typesafe/jev-1.13' }, fetchImpl);
  assert.equal(d.source, 'openrouter:vendor/big:free');
  assert.match(d.error, /Jev HTTP 503/);
});

test('Jev bad key goes straight to rules', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return json({ error: { message: 'no auth' } }, 401); };
  const d = await decide(ctx, { provider: 'jev', apiKey: 'bad', model: 'typesafe/jev-1.13' }, fetchImpl);
  assert.equal(calls, 1);
  assert.equal(d.source, 'rules (Jev error)');
});

test('buildJevState carries the IFVG setup, 1:1 R:R and trades today', () => {
  const st = buildJevState({
    indicators: { price: 1, macd: null, bollinger: null },
    account: { cash: 1, btc: 0, avgEntry: 0, equity: 1 },
    recentCandles: [],
    granularity: 900,
    ifvg: { direction: 'bullish', top: 2, bottom: 1, ageCandles: 0 },
    tradesToday: 7,
  });
  assert.equal(st.setup, 'Bullish IFVG pattern detected');
  assert.equal(st.risk_reward, '1:1');
  assert.equal(st.trades_today, 7);
});

test('web research suggestions: sources kept, only known settings with valid values', async () => {
  const { researchSuggestions, cleanPatch } = await import('../src/ai.js');
  assert.deepEqual(cleanPatch({ minStopPct: 0.3, hack: 1, stopMode: 'nope', requireDisplacement: 'true' }), { minStopPct: 0.3, requireDisplacement: true });
  assert.equal(cleanPatch({ minStopPct: 50 }), null, 'out of range');
  let body;
  const fetchImpl = async (url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ model: 'openai/gpt-4o-mini', choices: [{ message: {
      content: '{"suggestions":[{"title":"Trade the London / NY opens","why":"Most IFVG traders filter by session.","change":{"sessionFilter":true},"source_url":"https://example.com/a"},{"title":"Idea","why":"x","change":{"unknown":1}}]}',
      annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com/b' } }],
    } }] }) };
  };
  const out = await researchSuggestions({ modelName: 'IFVG', rules: 'r', stats: 's', settings: { minStopPct: 0.15 }, apiKey: 'k', fetchImpl });
  assert.match(body.model, /:online$/, 'web search model');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].patch, { sessionFilter: true });
  assert.deepEqual(out[0].sources, ['https://example.com/a', 'https://example.com/b']);
  assert.equal(out[1].patch, null);
});
