# ₿ BTC AI Paper Trader

A small web app that trades Bitcoin on a **paper (fake money) account**, using the
**free AI models on [OpenRouter](https://openrouter.ai)** (or Google Gemini's free tier) to decide
whether to BUY, SELL or HOLD.

## How it works

Every *N* minutes (or when you click **Ask AI now**) the bot:

1. Pulls BTC-USD candles from Coinbase's public API (Binance as fallback). No key needed.
2. Calculates RSI, SMA 20/50, EMA 12/26, MACD and Bollinger Bands.
3. Sends the indicators, the last 24 candles, your account balance and its recent
   decisions to the AI, which replies with JSON:
   `{ action, confidence, size_pct, reasoning }`.
4. Applies risk rules before trading:
   - skip if confidence is below **Min confidence** (default 0.6)
   - each buy is at most **Max per trade %** of equity (default 10%)
   - total BTC exposure never exceeds **Max position %** of equity (default 50%)
5. Places a market order on the paper account and logs the decision and its reasoning.

If no AI key is set (or the AI errors or hits its rate limit), a simple
rule-based strategy is used instead so the site keeps working. The **Source**
column shows which one made each decision.

## Quick start

```bash
npm install
cp .env.example .env      # then add your OPENROUTER_API_KEY
npm start                 # http://localhost:3000
```

1. Create an OpenRouter key at <https://openrouter.ai/keys> and set `OPENROUTER_API_KEY` in `.env`
   (or set `GEMINI_API_KEY` from <https://aistudio.google.com/apikey> instead).
2. Run `npm run check` to confirm market data, the AI key and (if `BROKER=alpaca`) your Alpaca keys all work.
3. Open <http://localhost:3000>, click **Ask AI now** to see a decision, or **Start bot** to run on a schedule.

## Paper accounts

| `BROKER` | What it is | Setup |
|---|---|---|
| `local` (default) | Built-in simulated account, $100k starting cash, 0.1% fee, saved to `data/account.json` | Nothing |
| `alpaca` | Alpaca's free paper-trading account (real order engine, fake money, supports BTC/USD) | Sign up at <https://alpaca.markets>, open the **Paper** dashboard, generate API keys, set `ALPACA_API_KEY` / `ALPACA_API_SECRET` |

The Alpaca broker refuses to start unless the base URL is a `paper` endpoint, so
it can't place live orders by accident.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | auto | `openrouter` or `gemini`; if empty, whichever key is set |
| `OPENROUTER_API_KEY` | (none) | Key from openrouter.ai |
| `OPENROUTER_MODEL` | `auto` | `auto` = use OpenRouter's current free models (falls back to the next one if rate-limited), or a specific model id |
| `GEMINI_API_KEY` | (none) | Free key from Google AI Studio |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Any Gemini model on your plan |
| `BROKER` | `local` | `local` or `alpaca` |
| `STARTING_CASH` | `100000` | Local account starting balance |
| `BOT_INTERVAL_MINUTES` | `15` | How often the bot asks the AI |
| `CANDLE_GRANULARITY` | `3600` | Candle size in seconds (300, 900, 3600, 21600, 86400) |
| `MIN_CONFIDENCE` | `0.6` | Ignore weaker AI calls |
| `MAX_POSITION_PCT` | `50` | Max % of equity held in BTC |
| `MAX_TRADE_PCT` | `10` | Max % of equity per buy |
| `AUTO_START` | `false` | Start the bot when the server boots |

Interval, candle size and risk limits can also be changed live from the dashboard.

Free OpenRouter models and the free Gemini tier both have per-minute and per-day
request limits; an interval of 5–15 minutes stays well inside them.

## Project layout

```
server.js              Express server + REST API
src/ai.js              Prompt, OpenRouter / Gemini calls, rule-based fallback
src/bot.js             Scheduler + risk rules (planTrade)
src/indicators.js      RSI / SMA / EMA / MACD / Bollinger
src/market.js          Coinbase / Binance public market data
src/brokers/local.js   Simulated paper account
src/brokers/alpaca.js  Alpaca paper-trading account
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
| POST | `/api/bot/start`, `/api/bot/stop`, `/api/bot/run` | Control the bot |
| POST | `/api/settings` | Update interval / risk limits |
| POST | `/api/order` | Manual trade `{ side: "buy", amount: <USD> }` or `{ side: "sell", amount: <BTC> }` |
| POST | `/api/reset` | Reset the local paper account |

> ⚠️ Educational project. Paper trading only. Not financial advice: AI trading
> decisions can be wrong, and paper results don't predict live results.
