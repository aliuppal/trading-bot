-- Run the bot 24/7 from Supabase (more reliable than GitHub's scheduler).
-- Every minute Supabase calls /api/cron: open trades' stops/targets are checked each time, and the
-- IFVG scan + Jev call happen whenever the bot's interval (default 5 min) has passed.
-- Run in Supabase: SQL Editor -> New query -> paste -> replace <CRON_SECRET> -> Run.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace an older copy of this job if it exists.
select cron.unschedule(jobid) from cron.job where jobname = 'trading-bot-tick';

select cron.schedule(
  'trading-bot-tick',
  '* * * * *',
  $$
  select net.http_get(
    url     := 'https://trading-bot-beige-two.vercel.app/api/cron',
    headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>'),
    timeout_milliseconds := 60000
  );
  $$
);

-- Check it:   select * from cron.job_run_details order by start_time desc limit 10;
-- Responses:  select status_code, content, created from net._http_response order by created desc limit 10;
-- Stop it:    select cron.unschedule('trading-bot-tick');
