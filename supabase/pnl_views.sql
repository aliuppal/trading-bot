-- P&L by day, week and month (UTC, by exit time), split into long and short.
-- Views are computed live from public.trades, so they are always up to date.
-- Run in Supabase: SQL Editor -> New query -> paste -> Run. Safe to run again.

create or replace view public.pnl_daily as
select date_trunc('day', exit_time at time zone 'UTC')::date                     as period,
       count(*)                                                                    as trades,
       count(*) filter (where pnl >= 0)                                            as wins,
       count(*) filter (where pnl < 0)                                             as losses,
       round(100.0 * count(*) filter (where pnl >= 0) / count(*), 1)               as win_rate_pct,
       count(*) filter (where side = 'long')                                       as long_trades,
       count(*) filter (where side = 'short')                                      as short_trades,
       round(coalesce(sum(pnl) filter (where side = 'long'), 0), 2)                as long_pnl,
       round(coalesce(sum(pnl) filter (where side = 'short'), 0), 2)               as short_pnl,
       round(sum(pnl), 2)                                                          as total_pnl,
       round(sum(r), 2)                                                            as net_r
from public.trades
where exit_time is not null and pnl is not null
group by 1;

create or replace view public.pnl_weekly as   -- weeks start Monday
select date_trunc('week', exit_time at time zone 'UTC')::date                    as period,
       count(*)                                                                    as trades,
       count(*) filter (where pnl >= 0)                                            as wins,
       count(*) filter (where pnl < 0)                                             as losses,
       round(100.0 * count(*) filter (where pnl >= 0) / count(*), 1)               as win_rate_pct,
       count(*) filter (where side = 'long')                                       as long_trades,
       count(*) filter (where side = 'short')                                      as short_trades,
       round(coalesce(sum(pnl) filter (where side = 'long'), 0), 2)                as long_pnl,
       round(coalesce(sum(pnl) filter (where side = 'short'), 0), 2)               as short_pnl,
       round(sum(pnl), 2)                                                          as total_pnl,
       round(sum(r), 2)                                                            as net_r
from public.trades
where exit_time is not null and pnl is not null
group by 1;

create or replace view public.pnl_monthly as
select date_trunc('month', exit_time at time zone 'UTC')::date                   as period,
       count(*)                                                                    as trades,
       count(*) filter (where pnl >= 0)                                            as wins,
       count(*) filter (where pnl < 0)                                             as losses,
       round(100.0 * count(*) filter (where pnl >= 0) / count(*), 1)               as win_rate_pct,
       count(*) filter (where side = 'long')                                       as long_trades,
       count(*) filter (where side = 'short')                                      as short_trades,
       round(coalesce(sum(pnl) filter (where side = 'long'), 0), 2)                as long_pnl,
       round(coalesce(sum(pnl) filter (where side = 'short'), 0), 2)               as short_pnl,
       round(sum(pnl), 2)                                                          as total_pnl,
       round(sum(r), 2)                                                            as net_r
from public.trades
where exit_time is not null and pnl is not null
group by 1;

-- Respect the trades table's Row Level Security (only the server-side secret key can read).
alter view public.pnl_daily   set (security_invoker = true);
alter view public.pnl_weekly  set (security_invoker = true);
alter view public.pnl_monthly set (security_invoker = true);
