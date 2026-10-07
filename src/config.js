import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

function resolveAi() {
  const orKey = process.env.OPENROUTER_API_KEY || '';
  const gKey = process.env.GEMINI_API_KEY || '';
  const provider = (process.env.AI_PROVIDER || (orKey ? 'jev' : gKey ? 'gemini' : 'none')).toLowerCase();
  if (provider === 'jev') return { provider, apiKey: orKey, model: process.env.JEV_MODEL || 'typesafe/jev-1.13' };
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
    intervalMinutes: num(process.env.BOT_INTERVAL_MINUTES, 5),
    granularity: num(process.env.CANDLE_GRANULARITY, 900),
    minConfidence: num(process.env.MIN_CONFIDENCE, 0.6),
    maxPositionPct: num(process.env.MAX_POSITION_PCT, 50),
    maxTradePct: num(process.env.MAX_TRADE_PCT, 10),
    maxTradesPerDay: Math.min(10, num(process.env.MAX_TRADES_PER_DAY, 10)),
    autoStart: process.env.AUTO_START !== 'false',
  },
  // Vercel's filesystem is read-only apart from /tmp (and /tmp is not shared between instances: use Redis there).
  dataDir: process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/trading-bot' : 'data'),
  redis: {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '',
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '',
  },
  // Supabase storage (preferred). The Vercel <-> Supabase integration sets SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
  supabase: {
    url: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    key: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },
  cronSecret: process.env.CRON_SECRET || '',
  serverless: Boolean(process.env.VERCEL),
};
