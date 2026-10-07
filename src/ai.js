// Decision engine: asks Google Gemini (free tier) for BUY / SELL / HOLD.
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

export function buildPrompt({ indicators, account, recentCandles, granularity, recentDecisions = [] }) {
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
    reasoning: `Rule-based: ${why.join(', ') || 'no clear signal'}.`,
  };
}

export async function decide(context, geminiConfig, fetchImpl = fetch) {
  if (!geminiConfig.apiKey) {
    return { ...ruleBasedDecision(context.indicators), source: 'rules (no GEMINI_API_KEY)' };
  }
  try {
    const d = await askGemini(buildPrompt(context), geminiConfig, fetchImpl);
    return { ...d, source: `gemini:${geminiConfig.model}` };
  } catch (err) {
    return { ...ruleBasedDecision(context.indicators), source: 'rules (Gemini error)', error: err.message };
  }
}
