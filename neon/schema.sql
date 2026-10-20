-- Storage for the trading bot on Neon (Postgres). Safe to run more than once:
-- node scripts/neon-setup.js   (or paste into the Neon SQL Editor -> Run)
--
--   trades     one row per trade (entry_image / exit_image = chart snapshots as base64 data URIs)
--   decisions  one row per AI / bot decision
--   orders     one row per order
--   settings   bot settings and state (row id 'bot')
--   kv         everything else (paper account, per-symbol bot state, suggestions, locks)

create table if not exists kv (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists trades (
  id          text primary key,
  side        text not null default 'long',
  status      text not null,
  entry_time  timestamptz,
  entry_price numeric,
  qty         numeric,
  notional    numeric,
  stop        numeric,
  target      numeric,
  exit_time   timestamptz,
  exit_price  numeric,
  exit_reason text,
  r           numeric,
  pnl         numeric,
  confidence  numeric,
  source      text,
  entry_image text,
  exit_image  text,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);
create index if not exists trades_entry_time_idx on trades (entry_time desc);
create index if not exists trades_updated_at_idx on trades (updated_at desc);

create table if not exists decisions (
  id         text primary key,
  time       timestamptz,
  action     text,
  confidence numeric,
  price      numeric,
  executed   boolean not null default false,
  note       text,
  reasoning  text,
  source     text,
  trade_id   text,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists decisions_time_idx on decisions (time desc);
create index if not exists decisions_updated_at_idx on decisions (updated_at desc);

create table if not exists orders (
  id         text primary key,
  time       timestamptz,
  side       text,
  qty        numeric,
  price      numeric,
  notional   numeric,
  fee        numeric,
  pnl        numeric,
  status     text,
  source     text,
  reason     text,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists orders_time_idx on orders (time desc);
create index if not exists orders_updated_at_idx on orders (updated_at desc);

create table if not exists settings (
  id                 text primary key,
  running            boolean,
  last_run           timestamptz,
  interval_minutes   numeric,
  granularity        numeric,
  min_confidence     numeric,
  max_position_pct   numeric,
  max_trade_pct      numeric,
  max_trades_per_day numeric,
  data               jsonb not null,
  updated_at         timestamptz not null default now()
);
