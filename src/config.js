import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

function resolveAi() {
  const orKey = process.env.OPENROUTER_API_KEY || '';
  const gKey = process.env.GEMINI_API_KEY || '';
  const provider = (process.env.AI_PROVIDER || (orKey ? 'openrouter' : gKey ? 'gemini' : 'none')).toLowerCase();
  if (provider === 'openrouter') return { provider, apiKey: orKey, model: process.env.OPENROUTER_MODEL || 'auto' };
  if (provider === 'gemini') return { provider, apiKey: gKey, model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' };
  return { provider: 'none', apiKey: '', model: '' };
}

export const config = {
  port: num(process.env.PORT, 3000),
  ai: resolveAi(),
  broker: (process.env.BROKER || 'local').toLowerCase(),
  alpaca: {
    key: process.env.ALPACA_API_KEY || '',
    secret: process.env.ALPACA_API_SECRET || '',
    baseUrl: process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets',
  },
  startingCash: num(process.env.STARTING_CASH, 100000),
  bot: {
    intervalMinutes: num(process.env.BOT_INTERVAL_MINUTES, 15),
    granularity: num(process.env.CANDLE_GRANULARITY, 3600),
    minConfidence: num(process.env.MIN_CONFIDENCE, 0.6),
    maxPositionPct: num(process.env.MAX_POSITION_PCT, 50),
    maxTradePct: num(process.env.MAX_TRADE_PCT, 10),
    autoStart: process.env.AUTO_START === 'true',
  },
  dataDir: process.env.DATA_DIR || 'data',
};
