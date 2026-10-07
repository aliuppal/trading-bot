import { describeLevels } from './liquidity.js';

// Decision engine: asks Jev (TypeSafe's decisions model on OpenRouter), an OpenRouter chat model
// or Google Gemini for BUY / SELL / HOLD.
// Falls back to a simple rule-based strategy when no key is set or the API fails.

const ACTIONS = ['BUY', 'SELL', 'HOLD'];

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    action: { type: 'STRING', enum: ACTIONS },
    confidence: { type: 'NUMBER', description: '0 to 1' },
    size_pct: { type: 'NUMBER', description: 'Percent of total equity to trade, 0-100' },
    reasoning: { type: 'STRING' },
  },
  required: ['action', 'confidence', 'size_pct', 'reasoning'],
};

export function buildPrompt({
  indicators, account, recentCandles, granularity, recentDecisions = [], ifvg, tradesToday = 0, maxTradesPerDay = 10, openTrade, review, riskReward = 1, breakevenAtR = 0, liquidity,
}) {
  const candleLines = recentCandles
    .map((c) => `${new Date(c.time).toISOString()} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${Math.round(c.volume)}`)
    .join('\n');
  const history = recentDecisions
    .slice(0, 5)
    .map((d) => `${d.time} ${d.action} conf=${d.confidence} executed=${d.executed}`)
    .join('\n') || 'none';

  return `You are a disciplined Bitcoin (BTC/USD) swing trader managing a PAPER trading account.
Decide whether to BUY, SELL, or HOLD right now. Capital preservation matters more than activity:
prefer HOLD when signals are mixed. Never risk more than necessary.

Candle size: ${granularity / 60} minutes.

Strategy: Inverse Fair Value Gap (IFVG).
- Bullish IFVG (a bearish fair value gap price closed back above, now support) = LONG setup -> answer BUY.
- Bearish IFVG (a bullish fair value gap price closed back below, now resistance) = SHORT setup -> answer SELL.
Every trade has a stop just beyond the IFVG zone and a target ${riskReward}x that distance on the other side (risk:reward 1:${riskReward})${breakevenAtR ? `; the stop moves to breakeven at +${breakevenAtR}R` : ''}.
Max ${maxTradesPerDay} trades per day; ${tradesToday} taken today.
Setup: ${ifvg ? `${ifvg.direction} IFVG, zone ${ifvg.bottom}-${ifvg.top}, inverted ${ifvg.ageCandles} candle(s) ago` : 'none detected'}
Higher-timeframe confirmation: ${ifvg?.htf ? `price tapped a ${ifvg.htf.tf} ${ifvg.htf.type} FVG (${ifvg.htf.bottom}-${ifvg.htf.top})` : 'none'}
Entry timeframe: ${ifvg?.granularity ? `${ifvg.granularity / 60}m` : `${granularity / 60}m`}${ifvg?.category ? ` (${ifvg.category} trade)` : ''}
Liquidity above: ${liquidity ? describeLevels(liquidity.above, 4) : 'unknown'}
Liquidity below: ${liquidity ? describeLevels(liquidity.below, 4) : 'unknown'}
Draw on liquidity: ${liquidity?.draw ?? 'unclear'}${liquidity?.lrlr ? ` (low-resistance run ${liquidity.lrlr.side})` : ''}
(PDH/PDL previous day high/low, DH/DL today, PWH/PWL previous week, EQH/EQL equal highs/lows, HTFH/HTFL higher-timeframe swings)
Open trade: ${openTrade ? `${openTrade.side || 'long'} from ${openTrade.entryPrice}, SL ${openTrade.stop}, TP ${openTrade.target}` : 'none'}
${review ? `RISK REVIEW of the open ${review.side}: open ${review.minutesOpen} min, currently ${review.unrealizedR}R. Decide whether to keep it (HOLD) or close it now to protect capital (${review.side === 'long' ? 'SELL' : 'BUY'} = close).` : ''}

Technical indicators (latest):
${JSON.stringify(indicators, null, 2)}

Last ${recentCandles.length} candles (oldest first):
${candleLines}

Account:
- Cash (USD): ${account.cash.toFixed(2)}
- BTC held: ${account.btc.toFixed(8)}
- Avg entry price: ${account.avgEntry ? account.avgEntry.toFixed(2) : 'n/a'}
- Total equity (USD): ${account.equity.toFixed(2)}

Your recent decisions (newest first):
${history}

Respond with JSON only:
- action: "BUY", "SELL" or "HOLD"
- confidence: number 0..1
- size_pct: percent of total equity to buy (for BUY) or percent of the BTC position to sell (for SELL), 0..100
- leverage: futures leverage for this trade, 1..10 (1 for weak or volatile setups)
- reasoning: 1-3 short sentences`;
}

export function parseDecision(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON object in AI response');
    obj = JSON.parse(match[0]);
  }
  const action = String(obj.action || '').toUpperCase();
  if (!ACTIONS.includes(action)) throw new Error(`Invalid action: ${obj.action}`);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
  let confidence = clamp(obj.confidence, 0, 100);
  if (confidence > 1) confidence /= 100; // tolerate 0-100 scale
  return {
    action,
    confidence: Number(confidence.toFixed(2)),
    sizePct: clamp(obj.size_pct ?? obj.sizePct, 0, 100),
    leverage: Math.round(clamp(obj.leverage ?? 1, 1, 10)) || 1,
    reasoning: String(obj.reasoning || '').slice(0, 1000),
  };
}

export async function askGemini(prompt, { apiKey, model }, fetchImpl = fetch) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new Error(`Empty Gemini response (finishReason: ${data?.candidates?.[0]?.finishReason || 'unknown'})`);
  return parseDecision(text);
}

const OPENROUTER = 'https://openrouter.ai/api/v1';
let freeModelCache = { at: 0, ids: [] };

/** Current zero-cost OpenRouter models (cached for an hour). */
export async function listFreeModels(fetchImpl = fetch, now = Date.now()) {
  if (freeModelCache.ids.length && now - freeModelCache.at < 3600000) return freeModelCache.ids;
  const res = await fetchImpl(`${OPENROUTER}/models`);
  if (!res.ok) throw new Error(`OpenRouter models HTTP ${res.status}`);
  const { data = [] } = await res.json();
  const isFree = (m) => m.id.endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);
  // Chat models only: text in, text-only out (skips music/image generators), no classifiers or code-only models.
  const isChat = (m) => {
    const a = m.architecture || {};
    const out = a.output_modalities || [a.modality?.split('->')[1] || 'text'];
    const inp = a.input_modalities || ['text'];
    return out.length === 1 && out[0] === 'text' && inp.includes('text') && !/safety|guard|embed|code/i.test(m.id);
  };
  const ids = data
    .filter((m) => isFree(m) && isChat(m) && m.id !== 'openrouter/free')
    .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
    .map((m) => m.id);
  // OpenRouter's own free-model router goes last as a catch-all.
  if (data.some((m) => m.id === 'openrouter/free')) ids.push('openrouter/free');
  freeModelCache = { at: now, ids };
  return ids;
}

export function resetFreeModelCache() {
  freeModelCache = { at: 0, ids: [] };
}

async function openRouterChat(prompt, model, apiKey, fetchImpl) {
  const res = await fetchImpl(`${OPENROUTER}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/aliuppal/trading-bot',
      'X-Title': 'BTC AI Paper Trader',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You are a trading assistant. Reply with a single JSON object and nothing else.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    const err = new Error(`OpenRouter ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  if (data.error) throw new Error(`OpenRouter ${model}: ${data.error.message || JSON.stringify(data.error)}`);
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error(`Empty OpenRouter response from ${model}`);
  return { ...parseDecision(text), model: data.model || model };
}

/**
 * model: a specific OpenRouter model id, or "auto" to use the current free models
 * (tries up to 3 if one is rate-limited or unavailable).
 */
export async function askOpenRouter(prompt, { apiKey, model }, fetchImpl = fetch) {
  let candidates = [model];
  if (!model || model === 'auto') {
    const free = await listFreeModels(fetchImpl);
    candidates = [...free.filter((id) => id !== 'openrouter/free').slice(0, 3), ...free.filter((id) => id === 'openrouter/free')];
  }
  if (!candidates.length) throw new Error('No free OpenRouter models available right now');
  let lastErr;
  for (const m of candidates) {
    try {
      return await openRouterChat(prompt, m, apiKey, fetchImpl);
    } catch (err) {
      lastErr = err;
      if (err.status === 401 || err.status === 402) break; // bad key / no credits: other models won't help
    }
  }
  throw lastErr;
}

const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
const SIZE_LEVELS = [0, 5, 10, 25, 50, 100];
export const LEVERAGE_LEVELS = [1, 2, 3, 5, 10];

/** Map a fractional score index onto LEVERAGE_LEVELS (rounded to the nearest level). */
export function scoreToLeverage(score) {
  const i = Math.round(Math.min(LEVERAGE_LEVELS.length - 1, Math.max(0, Number(score) || 0)));
  return LEVERAGE_LEVELS[i];
}

/** Flat state object for Jev: indicators, account and recent closes. */
export function buildJevState({ indicators, account, recentCandles, granularity, ifvg, tradesToday = 0, maxTradesPerDay = 10, openTrade, review, riskReward = 1, breakevenAtR = 0, maxLeverage = 1, liquidity, targetMode = 'rr' }) {
  const { macd, bollinger, ...rest } = indicators;
  return {
    setup: ifvg ? `${ifvg.direction === 'bullish' ? 'Bullish' : 'Bearish'} IFVG pattern detected` : 'No IFVG pattern',
    risk_reward: `1:${riskReward}`,
    breakeven_at_r: breakevenAtR || null,
    max_leverage: maxLeverage,
    liquidity_above: liquidity ? describeLevels(liquidity.above, 4) : 'unknown',
    liquidity_below: liquidity ? describeLevels(liquidity.below, 4) : 'unknown',
    draw_on_liquidity: liquidity?.draw ?? null,
    lrlr: liquidity?.lrlr ? `${liquidity.lrlr.side}: ${liquidity.lrlr.prices.map((p) => Math.round(p)).join(', ')}` : 'none',
    target_mode: targetMode === 'liquidity' ? 'nearest liquidity level 1R-5R away' : `fixed 1:${riskReward}`,
    htf_fvg_tap: ifvg?.htf ? `${ifvg.htf.tf} ${ifvg.htf.type} FVG tapped (${ifvg.htf.bottom}-${ifvg.htf.top})` : 'none',
    entry_timeframe: ifvg?.granularity ? `${ifvg.granularity / 60}m` : null,
    trade_type: ifvg?.category ?? null, // scalp (1m entry) or swing
    ...(review && { review_minutes_open: review.minutesOpen, review_unrealized_r: review.unrealizedR }),
    trades_today: tradesToday,
    max_trades_per_day: maxTradesPerDay,
    ifvg_top: ifvg?.top ?? null,
    ifvg_bottom: ifvg?.bottom ?? null,
    ifvg_age_candles: ifvg?.ageCandles ?? null,
    trade_direction: ifvg ? (ifvg.direction === 'bullish' ? 'long' : 'short') : null,
    open_trade: openTrade ? `${openTrade.side || 'long'} from ${openTrade.entryPrice}, SL ${openTrade.stop}, TP ${openTrade.target}` : 'none',
    symbol: 'BTC/USD',
    candle_minutes: granularity / 60,
    ...rest,
    macd: macd?.macd ?? null,
    macd_signal: macd?.signal ?? null,
    macd_histogram: macd?.histogram ?? null,
    bb_upper: bollinger?.upper ?? null,
    bb_middle: bollinger?.middle ?? null,
    bb_lower: bollinger?.lower ?? null,
    recent_closes: recentCandles.map((c) => Number(c.close.toFixed(2))),
    cash_usd: Number(account.cash.toFixed(2)),
    btc_held: account.btc,
    btc_avg_entry: account.avgEntry || null,
    equity_usd: Number(account.equity.toFixed(2)),
  };
}

const JEV_QUESTIONS = {
  action: {
    type: 'choice',
    instructions: 'Decide the trade for a disciplined Bitcoin intraday trader using the Inverse Fair Value Gap (IFVG) model '
      + 'on a paper account. Bullish IFVG = long setup, bearish IFVG = short setup. Every trade uses a fixed bracket: '
      + 'stop just beyond the IFVG zone, target at the risk_reward multiple on the other side of entry. '
      + 'At most max_trades_per_day trades per day. Only take the setup when the IFVG and momentum agree; otherwise HOLD. '
      + 'Use the liquidity levels: favor trades toward the draw on liquidity (liquidity_above for longs, liquidity_below for shorts, '
      + 'especially a low-resistance run, lrlr) and avoid trades whose path runs straight into nearby opposing liquidity.',
    criteria: {
      BUY: 'A bullish IFVG is holding as support and price should reach the target above before the stop (go long, or close an open short)',
      SELL: 'A bearish IFVG is holding as resistance and price should reach the target below before the stop (go short, or close an open long)',
      HOLD: 'Signals are mixed or weak; do nothing',
    },
  },
  size: {
    type: 'score',
    instructions: 'If trading, what percent of equity (for BUY) or of the BTC position (for SELL) should be traded?',
    criteria: SIZE_LEVELS.map((v) => `${v}%`),
  },
  leverage: {
    type: 'score',
    instructions: 'If trading, how much futures leverage fits this setup? Use more only for clean, high-conviction '
      + 'setups in calm conditions; use 1x for weak, choppy or very volatile conditions.',
    criteria: LEVERAGE_LEVELS.map((v) => `${v}x`),
  },
};

/** Map a fractional score index (e.g. 1.18) onto SIZE_LEVELS by linear interpolation. */
export function scoreToPct(score) {
  const s = Math.min(SIZE_LEVELS.length - 1, Math.max(0, Number(score) || 0));
  const lo = Math.floor(s);
  const hi = Math.min(SIZE_LEVELS.length - 1, lo + 1);
  return Number((SIZE_LEVELS[lo] + (SIZE_LEVELS[hi] - SIZE_LEVELS[lo]) * (s - lo)).toFixed(1));
}

/** Questions for reviewing an open trade: keep it (HOLD) or close it now (CLOSE). */
export function reviewQuestions(side) {
  return {
    action: {
      type: 'choice',
      instructions: `Risk review of an open ${side} BTC trade (1:1 bracket, IFVG model). Keep it unless the setup has clearly `
        + 'failed or momentum has turned against it; closing early protects capital.',
      criteria: {
        HOLD: `The ${side} setup is still valid; let the stop / target decide`,
        CLOSE: `Momentum has turned against the ${side}; close it now to cut risk`,
      },
    },
  };
}

export async function askJev(context, { apiKey, model }, fetchImpl = fetch) {
  const review = context.review;
  const questions = review ? reviewQuestions(review.side) : JEV_QUESTIONS;
  const res = await fetchImpl(JEV_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/aliuppal/trading-bot',
      'X-Title': 'BTC AI Paper Trader',
    },
    body: JSON.stringify({ model, state: buildJevState(context), questions }),
  });
  if (!res.ok) {
    const err = new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  if (data.error) throw new Error(`Jev: ${data.error.message || JSON.stringify(data.error)}`);
  const a = data.answers?.action;
  const choice = String(a?.choice || '').toUpperCase();
  const choices = review ? ['HOLD', 'CLOSE'] : ACTIONS;
  if (!choices.includes(choice)) throw new Error(`Jev returned no valid action: ${JSON.stringify(data).slice(0, 200)}`);
  const probs = a.probabilities || {};
  const confidence = Number(probs[choice] ?? a.confidence ?? 0);
  // A review's CLOSE becomes the exit action for the open trade (SELL closes a long, BUY closes a short).
  const action = choice === 'CLOSE' ? (review.side === 'short' ? 'BUY' : 'SELL') : choice;
  const sizePct = action === 'HOLD' ? 0 : scoreToPct(data.answers?.size?.score);
  const leverage = review || action === 'HOLD' ? 1 : scoreToLeverage(data.answers?.leverage?.score);
  const odds = choices.map((k) => `${k} ${Math.round((probs[k] ?? 0) * 100)}%`).join(' · ');
  return {
    action,
    confidence: Number(confidence.toFixed(2)),
    sizePct,
    leverage,
    reasoning: `Jev: ${odds} (model confidence ${a.confidence ?? 'n/a'}); suggested size ${sizePct}%${review ? '' : `, leverage ${leverage}x`}.`,
    model: data.model || model,
    cost: data.usage?.cost,
  };
}

/** Rule-based fallback so the site still works without an API key. */
export function ruleBasedDecision(ind) {
  const { rsi_14: r, macd: m, sma_20, sma_50, price } = ind;
  let score = 0;
  const why = [];
  if (r !== null) {
    if (r < 30) { score += 2; why.push(`RSI ${r} oversold`); }
    else if (r > 70) { score -= 2; why.push(`RSI ${r} overbought`); }
  }
  if (m) {
    if (m.histogram > 0) { score += 1; why.push('MACD bullish'); } else { score -= 1; why.push('MACD bearish'); }
  }
  if (sma_20 && sma_50) {
    if (sma_20 > sma_50 && price > sma_20) { score += 1; why.push('uptrend (price > SMA20 > SMA50)'); }
    if (sma_20 < sma_50 && price < sma_20) { score -= 1; why.push('downtrend (price < SMA20 < SMA50)'); }
  }
  const action = score >= 2 ? 'BUY' : score <= -2 ? 'SELL' : 'HOLD';
  return {
    action,
    confidence: Number(Math.min(1, 0.5 + Math.abs(score) * 0.1).toFixed(2)),
    sizePct: action === 'HOLD' ? 0 : 10 + Math.abs(score) * 5,
    leverage: 1,
    reasoning: `Rule-based: ${why.join(', ') || 'no clear signal'}.`,
  };
}

const PROVIDER_LABEL = { jev: 'Jev', openrouter: 'OpenRouter', gemini: 'Gemini' };

/** ai: { provider: 'jev' | 'openrouter' | 'gemini' | 'none', apiKey, model } */
export async function decide(context, ai, fetchImpl = fetch) {
  if (!ai.apiKey || !PROVIDER_LABEL[ai.provider]) {
    return { ...ruleBasedDecision(context.indicators), source: 'rules (no AI key)' };
  }
  const errors = [];
  if (ai.provider === 'jev') {
    try {
      const { model, cost, ...d } = await askJev(context, ai, fetchImpl);
      return { ...d, source: `jev:${model}`, cost };
    } catch (err) {
      errors.push(err.message);
      if (err.status === 401 || err.status === 402) {
        return { ...ruleBasedDecision(context.indicators), source: 'rules (Jev error)', error: errors.join(' | ') };
      }
      // Same OpenRouter key: fall back to the free chat models before the rules.
      ai = { ...ai, provider: 'openrouter', model: 'auto' };
    }
  }
  try {
    const prompt = buildPrompt(context);
    if (ai.provider === 'openrouter') {
      const { model, ...d } = await askOpenRouter(prompt, ai, fetchImpl);
      return { ...d, source: `openrouter:${model}`, ...(errors.length && { error: errors.join(' | ') }) };
    }
    const d = await askGemini(prompt, ai, fetchImpl);
    return { ...d, source: `gemini:${ai.model}` };
  } catch (err) {
    errors.push(err.message);
    return { ...ruleBasedDecision(context.indicators), source: `rules (${PROVIDER_LABEL[ai.provider]} error)`, error: errors.join(' | ') };
  }
}
