// Verifies market data, AI and broker connections using the settings in .env.
// Usage: npm run check
import { config } from '../src/config.js';
import * as market from '../src/market.js';
import { askOpenRouter, askGemini, askJev } from '../src/ai.js';
import { summarize } from '../src/indicators.js';
import { BinanceFuturesBroker } from '../src/brokers/binance.js';

const mask = (s) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : '(not set)');
let failed = 0;

async function step(name, fn) {
  try {
    console.log(`✅ ${name}: ${await fn()}`);
  } catch (err) {
    failed++;
    console.log(`❌ ${name}: ${err.message}`);
  }
}

await step('Market data', async () => `BTC = $${(await market.getPrice()).toLocaleString()}`);

if (config.ai.provider === 'none') {
  console.log('⚠️  AI: no OPENROUTER_API_KEY or GEMINI_API_KEY set, the rule-based fallback will be used');
} else {
  await step(`AI (${config.ai.provider}, key ${mask(config.ai.apiKey)})`, async () => {
    if (config.ai.provider === 'jev') {
      const candles = await market.getCandles(config.bot.granularity, 200);
      const account = { cash: 100000, btc: 0, avgEntry: 0, equity: 100000 };
      const d = await askJev({ indicators: summarize(candles), account, recentCandles: candles.slice(-24), granularity: config.bot.granularity }, config.ai);
      return `model ${d.model} says ${d.action} (${d.reasoning.replace(/^Jev: /, '')}), cost $${d.cost ?? '?'}`;
    }
    const prompt = 'Connection test. Reply with JSON: {"action":"HOLD","confidence":1,"size_pct":0,"reasoning":"ok"}';
    const d = config.ai.provider === 'openrouter' ? await askOpenRouter(prompt, config.ai) : await askGemini(prompt, config.ai);
    return `model ${d.model || config.ai.model} replied ${d.action}`;
  });
}

if (config.broker === 'binance') {
  await step(`Binance demo futures (key ${mask(config.binance.key)})`, async () => {
    const b = new BinanceFuturesBroker({ ...config.binance, getPrice: market.getPrice });
    const a = await b.getAccount();
    return `${config.binance.symbol} · available $${a.cash.toFixed(2)} · equity $${a.equity.toFixed(2)}`;
  });
} else {
  console.log('ℹ️  Broker: local simulated paper account (set BROKER=binance to use the Binance demo account)');
}

if (failed) {
  console.log(`\n${failed} check(s) failed.`);
  console.log('OpenRouter 401: the key is wrong or revoked; create one at https://openrouter.ai/keys.');
  process.exit(1);
}
console.log('\nAll good. Run: npm start');
