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
  binance: {
    key: process.env.BINANCE_API_KEY || '',
    secret: process.env.BINANCE_API_SECRET || '',
    // Binance Demo Trading futures; the futures testnet (https://testnet.binancefuture.com) also works
    baseUrl: process.env.BINANCE_BASE_URL || 'https://demo-fapi.binance.com',
    symbol: process.env.BINANCE_SYMBOL || 'BTCUSDT',
    leverage: num(process.env.BINANCE_LEVERAGE, 1),
  },
  startingCash: num(process.env.STARTING_CASH, 100000),
  bot: {
    intervalMinutes: num(process.env.BOT_INTERVAL_MINUTES, 1),
    granularity: num(process.env.CANDLE_GRANULARITY, 900),
    minConfidence: num(process.env.MIN_CONFIDENCE, 0.6),
    maxPositionPct: num(process.env.MAX_POSITION_PCT, 50),
    maxTradePct: num(process.env.MAX_TRADE_PCT, 10),
    maxTradesPerDay: Math.min(10, num(process.env.MAX_TRADES_PER_DAY, 10)),
    // Per-category daily limits (both also count toward maxTradesPerDay)
    maxSwingPerDay: Math.min(10, num(process.env.MAX_SWING_PER_DAY, 5)),
    maxScalpPerDay: Math.min(10, num(process.env.MAX_SCALP_PER_DAY, 5)),
    // IFVG formation: gap formed -> inverted within N candles (3-7)
    ifvgMaxAge: Math.min(7, Math.max(3, num(process.env.IFVG_MAX_AGE, 7))),
    // Entry needs a tap of a same-direction 1h/2h/4h FVG first
    requireHtfTap: process.env.REQUIRE_HTF_TAP !== 'false',
    // all = 3m + 5m + 15m entries; or 180 / 300 / 900 for one timeframe
    entryTimeframes: 'all', // every entry model is always scanned
    // 1m scalp entries off 5m / 15m / 30m FVG taps
    scalpEnabled: true,
    // Entry IFVG must be broken by a displacement candle (big body vs. recent candles)
    requireDisplacement: process.env.REQUIRE_DISPLACEMENT === 'true',
    // Target: rr = fixed risk:reward, liquidity = nearest liquidity level 1R-5R away (falls back to rr)
    targetMode: process.env.TARGET_MODE || 'rr',
    // Position sizing: percent = Max per trade % of equity (x leverage); risk = lose riskPerTradeUsd at the stop
    sizingMode: process.env.SIZING_MODE || 'percent',
    riskPerTradeUsd: num(process.env.RISK_PER_TRADE_USD, 50),
    minStopPct: num(process.env.MIN_STOP_PCT, 0.15),
    // Target = riskReward x stop distance (1 = 1:1, 3 = 1:3)
    riskReward: num(process.env.RISK_REWARD, 1),
    // Move the stop to the entry once price reaches +N R (0 = off)
    breakevenAtR: num(process.env.BREAKEVEN_AT_R, 0),
    // Jev picks 1-10x leverage per trade (Binance only); never above this cap
    maxLeverage: Math.min(20, Math.max(1, num(process.env.MAX_LEVERAGE, 5))),
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
