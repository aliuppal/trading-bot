# CryptoQuant Pro

A small web app that trades Bitcoin on a **paper (fake money) account**, using the
**Jev** (TypeSafe's decisions model on [OpenRouter](https://openrouter.ai)) to decide whether to
BUY, SELL or HOLD. Free OpenRouter chat models and Google Gemini's free tier are also supported.

## How it works

The bot trades the **Inverse Fair Value Gap (IFVG)** model with **Jev** making the call:

1. Pulls BTC-USD candles from Coinbase's public API (Binance as fallback). No key needed.
2. Finds fair value gaps (3-candle imbalances) and watches for an **inversion**: a bearish FVG that
   price closes back above is a **bullish IFVG** (support) = **long setup**; a bullish FVG that price closes
   back below is a **bearish IFVG** (resistance) = **short setup**.
3. When a fresh IFVG appears (either direction), it asks **Jev** (OpenRouter's decisions endpoint) whether to take it.
   Jev's state includes `setup`, `risk_reward: "1:1"`, `trades_today`, the IFVG zone and the usual indicators.
4. If Jev agrees (**BUY** on a bullish IFVG, **SELL** on a bearish one) with enough confidence, the trade is
   **executed automatically** with a **1:1 bracket**:
   stop just beyond the IFVG zone, target the same distance on the other side of the entry.
5. Every minute the open trade is checked: target hit = **+1R win**, stop hit = **-1R loss**
   (if one candle touches both, the stop is assumed first). An opposite IFVG + matching Jev call closes it early.
6. At most **10 trades per UTC day** (configurable lower, never above 10) and one open trade at a time.
7. Each trade gets a **chart snapshot** (SVG rendered on the server) at entry and at exit, shown in the
   **Trade history** tab. Click a thumbnail to see both charts with the IFVG zone, entry, stop and target.

### Multi-timeframe model

| Step | Rule |
|---|---|
| Zone | Active FVGs on **1h, 2h and 4h** (2h / 4h built from 1h candles) |
| Tap | Bullish setups need price to tap a **bullish** HTF FVG, bearish setups a **bearish** one (within the last 3 hours) |
| Entry | A fresh IFVG in the same direction on **15m, 5m or 3m**, confirmed on a closed candle, inverted within the last **3-7** candles (`IFVG_MAX_AGE`, default 5). 3m entries need a **1h** FVG tap |
| Priority | 15m first. A 5m (or 3m) IFVG waits if a 15m (or 5m) IFVG in the same direction is still forming; otherwise it is taken directly |
| Review | While a trade is open, Jev reviews it every **30 min** (3m / 5m entries) or **60 min** (15m entries) and may close it early (HOLD or CLOSE) |

The risk/reward box on the chart and in the snapshots grows with the trade until the stop or target is hit.

If no AI key is set (or the AI errors), a simple rule-based strategy answers instead so the site keeps working.
Shorts work on both the built-in simulated account and the Binance demo futures account (`BROKER=binance`).

The UI follows the **Obsidian Terminal** design system in [DESIGN.md](DESIGN.md).

## Quick start

```bash
npm install
cp .env.example .env      # then add your OPENROUTER_API_KEY
npm start                 # http://localhost:3000
```

1. Create an OpenRouter key at <https://openrouter.ai/keys> and set `OPENROUTER_API_KEY` in `.env`
   (or set `GEMINI_API_KEY` from <https://aistudio.google.com/apikey> instead).
3. Open <http://localhost:3000>, click **Ask AI now** to see a decision, or **Start bot** to run on a schedule.

## Paper accounts

| `BROKER` | What it is | Setup |
|---|---|---|
| `local` (default) | Built-in simulated account, $100k starting cash, 0.1% fee, saved to `data/account.json` | Nothing |
| `binance` | Binance USD-M futures **demo** account, BTCUSDT perpetual: real order engine, demo money, **longs and shorts** | binance.com → Demo Trading → API Management, set `BINANCE_API_KEY` / `BINANCE_API_SECRET` |

it can't place live orders by accident.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | auto | `jev`, `openrouter` (free chat models) or `gemini`; if empty, `jev` when an OpenRouter key is set |
| `OPENROUTER_API_KEY` | (none) | Key from openrouter.ai (used by `jev` and `openrouter`) |
| `JEV_MODEL` | `typesafe/jev-1.13` | Jev decisions model id |
| `OPENROUTER_MODEL` | `auto` | `auto` = use OpenRouter's current free models (falls back to the next one if rate-limited), or a specific model id |
| `GEMINI_API_KEY` | (none) | Free key from Google AI Studio |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Any Gemini model on your plan |
| `BROKER` | `local` | `local` or `binance` |
| `STARTING_CASH` | `100000` | Local account starting balance |
| `BOT_INTERVAL_MINUTES` | `5` | How often the bot scans for IFVG setups |
| `CANDLE_GRANULARITY` | `900` | Candle size in seconds (300, 900, 3600, 21600, 86400) |
| `MIN_CONFIDENCE` | `0.6` | Ignore weaker AI calls |
| `MAX_POSITION_PCT` | `50` | Max % of equity held in BTC |
| `MAX_TRADE_PCT` | `10` | Max % of equity per buy |
| `MAX_TRADES_PER_DAY` | `10` | New trades per UTC day (max 10) |
| `AUTO_START` | `true` | Bot trades automatically; `false` to start stopped |
| `SUPABASE_URL` / `SUPABASE_SECRET_KEY` | (none) | Supabase storage (recommended on Vercel) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | (none) | Upstash Redis storage (alternative) |
| `CRON_SECRET` | (none) | Protects `/api/cron` |

Interval, candle size and risk limits can also be changed live from the dashboard.

Free OpenRouter models and the free Gemini tier both have per-minute and per-day
request limits; an interval of 5–15 minutes stays well inside them.

## Deploying to Vercel

The Express app deploys to Vercel as-is (`server.js` exports the app; `public/` is served from the CDN).
Serverless functions don't keep files or timers, so:

1. **Storage (Supabase)**: in your Supabase project open **SQL Editor**, paste [supabase/schema.sql](supabase/schema.sql)
   and run it. Then set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (Project Settings -> API Keys -> secret key)
   on Vercel. The account, trades, snapshots and bot state live in the `kv` table (browse trades via the
   `trades` view). Upstash Redis (`KV_REST_API_URL` / `KV_REST_API_TOKEN`) also works. Without either, data
   lives in `/tmp` and is lost whenever the function cold-starts.
2. **Schedule**: set a `CRON_SECRET` env var on Vercel, then add the GitHub repo secrets `BOT_URL`
   (your `https://<app>.vercel.app`) and `CRON_SECRET`. The workflow `.github/workflows/bot-tick.yml`
   calls `/api/cron` every 5 minutes. An open dashboard also drives the bot while it's open.
3. Set `OPENROUTER_API_KEY` (and any settings from `.env.example`) in the Vercel project.

## Project layout

```
server.js              Express server + REST API
src/ifvg.js            FVG / IFVG detection and the 1:1 bracket
src/snapshot.js        SVG trade chart snapshots
src/store.js           File, Supabase or Upstash Redis key/value storage
supabase/schema.sql    Supabase table for storage
src/ai.js              Jev decisions call, OpenRouter / Gemini chat calls, rule-based fallback
src/bot.js             Scheduler + risk rules (planTrade)
src/indicators.js      RSI / SMA / EMA / MACD / Bollinger
src/market.js          Coinbase / Binance public market data
src/brokers/local.js   Simulated paper account
public/                Dashboard (plain HTML/CSS/JS, no build step)
test/                  node:test unit tests (npm test)
```

## API

| Method | Path | |
|---|---|---|
| GET | `/api/status` | Bot state and settings |
| GET | `/api/market?granularity=3600` | Candles + indicators |
| GET | `/api/account` | Cash, BTC, equity |
| GET | `/api/orders` | Order history |
| GET | `/api/decisions` | AI decision log |
| GET | `/api/trades` | IFVG trades (entry, stop, target, exit, R, P&L) |
| GET | `/api/trades/:id/shots` | Entry / exit chart snapshots (SVG) |
| GET/POST | `/api/cron` | Scheduler tick (`Authorization: Bearer $CRON_SECRET`) |
| POST | `/api/bot/start`, `/api/bot/stop`, `/api/bot/run` | Control the bot |
| POST | `/api/settings` | Update interval / risk limits |
| POST | `/api/order` | Manual trade `{ side: "buy", amount: <USD> }` or `{ side: "sell", amount: <BTC> }` |
| POST | `/api/reset` | Reset the local paper account |

> ⚠️ Educational project. Paper trading only. Not financial advice: AI trading
> decisions can be wrong, and paper results don't predict live results.
