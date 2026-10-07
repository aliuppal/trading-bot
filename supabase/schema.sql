-- Storage for the BTC AI paper trader. Safe to run more than once:
-- Supabase -> SQL Editor -> New query -> paste -> Run.
--
--   trades     one row per trade (entry_image / exit_image = chart snapshots as base64 data URIs)
--   decisions  one row per AI decision
--   orders     one row per order (simulated orders; Alpaca orders live in your Alpaca account)
--   settings   bot settings and state (row id 'bot')
--   kv         everything else (the paper account balances)
--
-- Row Level Security is on with no policies: only the server-side secret / service_role key can read or
-- write. The public anon / publishable key gets nothing.

create table if not exists public.kv (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

drop view if exists public.trades; -- an earlier version created a "trades" view

create table if not exists public.trades (
  id          text primary key,
  side        text not null default 'long',   -- long | short
  status      text not null,                  -- open | win | loss
  entry_time  timestamptz,
  entry_price numeric,
  qty         numeric,
  notional    numeric,
  stop        numeric,
  target      numeric,
  exit_time   timestamptz,
  exit_price  numeric,
  exit_reason text,                           -- target | stop | signal
  r           numeric,                        -- +1 = target hit, -1 = stop hit
  pnl         numeric,
  confidence  numeric,
  source      text,                           -- e.g. jev:typesafe/jev-1.13
  entry_image text,                           -- data:image/svg+xml;base64,...
  exit_image  text,                           -- data:image/svg+xml;base64,...
  data        jsonb not null,                 -- full trade record used by the app
  updated_at  timestamptz not null default now()
);
create index if not exists trades_entry_time_idx on public.trades (entry_time desc);

create table if not exists public.decisions (
  id         text primary key,
  time       timestamptz,
  action     text,                            -- BUY | SELL | HOLD | ERROR
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
create index if not exists decisions_time_idx on public.decisions (time desc);

create table if not exists public.orders (
  id         text primary key,
  time       timestamptz,
  side       text,                            -- buy | sell | short | cover
  qty        numeric,
  price      numeric,
  notional   numeric,
  fee        numeric,
  pnl        numeric,
  status     text,
  source     text,                            -- ai | manual
  reason     text,                            -- target | stop | signal
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists orders_time_idx on public.orders (time desc);

create table if not exists public.settings (
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

alter table public.kv        enable row level security;
alter table public.trades    enable row level security;
alter table public.decisions enable row level security;
alter table public.orders    enable row level security;
alter table public.settings  enable row level security;

-- ---------------------------------------------------------------------------------------------
-- One-time copy of data saved by the earlier kv-only version (does nothing if already copied).
-- ---------------------------------------------------------------------------------------------
insert into public.trades (id, side, status, entry_time, entry_price, qty, notional, stop, target,
                           exit_time, exit_price, exit_reason, r, pnl, confidence, source, data)
select t->>'id', coalesce(t->>'side', 'long'), t->>'status', (t->>'entryTime')::timestamptz,
       (t->>'entryPrice')::numeric, (t->>'qty')::numeric, (t->>'notional')::numeric,
       (t->>'stop')::numeric, (t->>'target')::numeric, (t->>'exitTime')::timestamptz,
       (t->>'exitPrice')::numeric, t->>'exitReason', (t->>'r')::numeric, (t->>'pnl')::numeric,
       (t->>'confidence')::numeric, t->>'source', t
from public.kv, jsonb_array_elements(kv.value) as t
where kv.key = 'trades' and jsonb_typeof(kv.value) = 'array'
on conflict (id) do nothing;

update public.trades tr
set entry_image = coalesce(tr.entry_image, kv.value->>'entry'),
    exit_image  = coalesce(tr.exit_image,  kv.value->>'exit')
from public.kv
where kv.key = 'shot_' || tr.id;

insert into public.decisions (id, time, action, confidence, price, executed, note, reasoning, source, trade_id, data)
select coalesce(d->>'id', 'D' || ord || '-' || coalesce(d->>'time', '')), (d->>'time')::timestamptz, d->>'action',
       (d->>'confidence')::numeric, (d->>'price')::numeric, coalesce((d->>'executed')::boolean, false),
       d->>'note', d->>'reasoning', d->>'source', d->>'tradeId', d
from public.kv, jsonb_array_elements(kv.value) with ordinality as x(d, ord)
where kv.key = 'decisions' and jsonb_typeof(kv.value) = 'array'
on conflict (id) do nothing;

insert into public.orders (id, time, side, qty, price, notional, fee, pnl, status, source, reason, data)
select o->>'id', (o->>'time')::timestamptz, o->>'side', (o->>'qty')::numeric, (o->>'price')::numeric,
       (o->>'notional')::numeric, (o->>'fee')::numeric, (o->>'pnl')::numeric, o->>'status', o->>'source',
       o->>'reason', o
from public.kv, jsonb_array_elements(kv.value->'orders') as o
where kv.key = 'account' and jsonb_typeof(kv.value->'orders') = 'array'
on conflict (id) do nothing;

insert into public.settings (id, running, last_run, interval_minutes, granularity, min_confidence,
                             max_position_pct, max_trade_pct, max_trades_per_day, data)
select 'bot', (value->>'running')::boolean, (value->>'lastRun')::timestamptz,
       (value->'settings'->>'intervalMinutes')::numeric, (value->'settings'->>'granularity')::numeric,
       (value->'settings'->>'minConfidence')::numeric, (value->'settings'->>'maxPositionPct')::numeric,
       (value->'settings'->>'maxTradePct')::numeric, (value->'settings'->>'maxTradesPerDay')::numeric, value
from public.kv where key = 'bot'
on conflict (id) do nothing;

-- Copied rows are no longer needed in kv (the account itself stays there; orders now live in public.orders).
delete from public.kv where key in ('trades', 'decisions', 'bot') or key like 'shot\_%';
update public.kv set value = value - 'orders' where key = 'account' and value ? 'orders';
