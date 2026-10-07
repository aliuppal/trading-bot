-- Adds a "category" column (scalp / swing) to public.trades, filled automatically from the saved trade data,
-- and per-category P&L views. Run once: Supabase -> SQL Editor -> New query -> paste -> Run.

alter table public.trades
  add column if not exists category text generated always as (coalesce(data->>'category', 'swing')) stored;

create or replace view public.pnl_by_category as
select category,
       count(*)                                                      as trades,
       count(*) filter (where pnl >= 0)                              as wins,
       count(*) filter (where pnl < 0)                               as losses,
       round(100.0 * count(*) filter (where pnl >= 0) / count(*), 1) as win_rate_pct,
       round(sum(pnl), 2)                                            as total_pnl,
       round(sum(r), 2)                                              as net_r
from public.trades
where exit_time is not null and pnl is not null
group by category;
alter view public.pnl_by_category set (security_invoker = true);
