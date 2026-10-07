-- Storage for the BTC AI paper trader. Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- One row per document: account, trades, decisions, bot state and trade chart snapshots (shot_<id>).
create table if not exists public.kv (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Row Level Security on with no policies: only the server-side secret / service_role key can read or write.
alter table public.kv enable row level security;

-- Handy views for browsing in the Table Editor.
create or replace view public.trades as
  select t->>'id' as id, t->>'side' as side, t->>'status' as status,
         (t->>'entryTime')::timestamptz as entry_time, (t->>'entryPrice')::numeric as entry_price,
         (t->>'stop')::numeric as stop, (t->>'target')::numeric as target,
         (t->>'exitPrice')::numeric as exit_price, (t->>'r')::numeric as r, (t->>'pnl')::numeric as pnl,
         t->>'source' as source
  from public.kv, jsonb_array_elements(value) as t
  where key = 'trades';
alter view public.trades set (security_invoker = true);
