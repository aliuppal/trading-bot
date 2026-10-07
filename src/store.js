// Tiny async key/value store for JSON documents.
// - FileKV: one JSON file per key in a directory (default, local runs).
// - RedisKV: Upstash Redis REST API (KV_REST_API_URL / UPSTASH_REDIS_REST_URL).
// - SupabaseKV: Supabase Postgres via its REST API. Lists and settings live in real tables
//   (trades, decisions, orders, settings — see supabase/schema.sql); anything else goes in the kv table.
import fs from 'node:fs/promises';
import path from 'node:path';

const clone = (v) => (v === undefined ? v : structuredClone(v));

/** Prepend `item` to the list stored at `key` (kept to `max` items). Uses kv.append when the store has it. */
export async function appendList(kv, key, item, max = 1000) {
  if (kv.append) return kv.append(key, item);
  const list = await kv.get(key, []);
  list.unshift(item);
  return kv.set(key, list.slice(0, max));
}

export class FileKV {
  constructor(dir) {
    this.dir = dir;
    this.name = 'file';
  }
  file(key) {
    return path.join(this.dir, `${key.replace(/[^a-z0-9_.-]/gi, '_')}.json`);
  }
  async get(key, fallback) {
    try {
      return JSON.parse(await fs.readFile(this.file(key), 'utf8'));
    } catch {
      return clone(fallback);
    }
  }
  async set(key, value) {
    await fs.mkdir(this.dir, { recursive: true });
    const f = this.file(key);
    const tmp = `${f}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value));
    await fs.rename(tmp, f);
  }
  async del(key) {
    await fs.rm(this.file(key), { force: true });
  }
}

export class RedisKV {
  constructor({ url, token, prefix = 'tb:' }, fetchImpl = fetch) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.prefix = prefix;
    this.fetch = fetchImpl;
    this.name = 'redis';
  }
  async cmd(args) {
    const res = await this.fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(`Redis ${args[0]}: ${data.error || `HTTP ${res.status}`}`);
    return data.result;
  }
  async get(key, fallback) {
    const raw = await this.cmd(['GET', this.prefix + key]);
    return raw == null ? clone(fallback) : JSON.parse(raw);
  }
  async set(key, value) {
    await this.cmd(['SET', this.prefix + key, JSON.stringify(value)]);
  }
  async del(key) {
    await this.cmd(['DEL', this.prefix + key]);
  }
}

const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const iso = (t) => (t ? new Date(t).toISOString() : null);

/** List keys stored as one row per item: table, sort order, how many rows to read, and item -> row. */
const LISTS = {
  trades: {
    order: 'entry_time.desc',
    limit: 200,
    row: (t) => ({
      id: t.id, side: t.side || 'long', status: t.status, entry_time: iso(t.entryTime), entry_price: num(t.entryPrice),
      qty: num(t.qty), notional: num(t.notional), stop: num(t.stop), target: num(t.target),
      exit_time: iso(t.exitTime), exit_price: num(t.exitPrice), exit_reason: t.exitReason ?? null,
      r: num(t.r), pnl: num(t.pnl), confidence: num(t.confidence), source: t.source ?? null, data: t,
    }),
  },
  decisions: {
    order: 'time.desc',
    limit: 200,
    row: (d) => ({
      id: d.id || `D${Date.parse(d.time)}`, time: iso(d.time), action: d.action ?? null, confidence: num(d.confidence),
      price: num(d.price), executed: Boolean(d.executed), note: d.note ?? null, reasoning: d.reasoning ?? null,
      source: d.source ?? null, trade_id: d.tradeId ?? null, data: d,
    }),
  },
  orders: {
    order: 'time.desc',
    limit: 200,
    row: (o) => ({
      id: o.id, time: iso(o.time), side: o.side, qty: num(o.qty), price: num(o.price), notional: num(o.notional),
      fee: num(o.fee), pnl: num(o.pnl), status: o.status ?? null, source: o.source ?? null, reason: o.reason ?? null, data: o,
    }),
  },
};

const settingsRow = (s) => ({
  id: 'bot',
  running: Boolean(s.running),
  last_run: iso(s.lastRun),
  interval_minutes: num(s.settings?.intervalMinutes),
  granularity: num(s.settings?.granularity),
  min_confidence: num(s.settings?.minConfidence),
  max_position_pct: num(s.settings?.maxPositionPct),
  max_trade_pct: num(s.settings?.maxTradePct),
  max_trades_per_day: num(s.settings?.maxTradesPerDay),
  data: s,
  updated_at: new Date().toISOString(),
});

/**
 * Supabase (Postgres) via its REST API.
 *   trades     one row per trade; entry_image / exit_image hold the chart snapshots as base64 data URIs
 *   decisions  one row per AI decision
 *   orders     one row per order
 *   settings   the bot's settings and state (row id 'bot')
 *   kv         everything else (the paper account)
 * Needs the project URL and a server-side key (sb_secret_… or service_role). RLS is on with no policies,
 * so the public anon/publishable key cannot read or write these tables.
 */
export class SupabaseKV {
  constructor({ url, key }, fetchImpl = fetch) {
    this.base = `${url.replace(/\/$/, '')}/rest/v1`;
    this.headers = { apikey: key, 'Content-Type': 'application/json' };
    if (key.startsWith('eyJ')) this.headers.Authorization = `Bearer ${key}`; // legacy JWT keys
    this.fetch = fetchImpl;
    this.name = 'supabase';
  }

  async req(method, table, query, body, prefer) {
    const res = await this.fetch(`${this.base}/${table}?${query}`, {
      method,
      headers: { ...this.headers, ...(prefer && { Prefer: prefer }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      const hint = /does not exist|PGRST205/.test(text) ? ' (run supabase/schema.sql in the Supabase SQL editor)' : '';
      throw new Error(`Supabase ${method} ${table} HTTP ${res.status}: ${text.slice(0, 200)}${hint}`);
    }
    return method === 'GET' ? res.json() : null;
  }

  upsert(table, rows) {
    return this.req('POST', table, 'on_conflict=id', rows, 'resolution=merge-duplicates,return=minimal');
  }

  async get(key, fallback) {
    const list = LISTS[key];
    if (list) {
      const rows = await this.req('GET', key, `select=data&order=${list.order}&limit=${list.limit}`);
      return rows.length ? rows.map((r) => r.data) : clone(fallback);
    }
    if (key === 'bot') {
      const rows = await this.req('GET', 'settings', 'id=eq.bot&select=data');
      return rows.length ? rows[0].data : clone(fallback);
    }
    if (key.startsWith('shot_')) {
      const rows = await this.req('GET', 'trades', `id=eq.${encodeURIComponent(key.slice(5))}&select=entry_image,exit_image`);
      if (!rows.length) return clone(fallback);
      const { entry_image: entry, exit_image: exit } = rows[0];
      return { ...(entry && { entry }), ...(exit && { exit }) };
    }
    const rows = await this.req('GET', 'kv', `key=eq.${encodeURIComponent(key)}&select=value`);
    return rows.length ? rows[0].value : clone(fallback);
  }

  async set(key, value) {
    const list = LISTS[key];
    if (list) {
      if (!value.length) return this.req('DELETE', key, 'id=not.is.null'); // reset
      return this.upsert(key, value.map(list.row));
    }
    if (key === 'bot') return this.upsert('settings', [settingsRow(value)]);
    if (key.startsWith('shot_')) {
      return this.req('PATCH', 'trades', `id=eq.${encodeURIComponent(key.slice(5))}`,
        { entry_image: value.entry ?? null, exit_image: value.exit ?? null }, 'return=minimal');
    }
    return this.req('POST', 'kv', 'on_conflict=key', { key, value, updated_at: new Date().toISOString() },
      'resolution=merge-duplicates,return=minimal');
  }

  /** Insert one row into a list table (decisions, orders, trades). */
  async append(key, item) {
    const list = LISTS[key];
    if (!list) {
      const all = await this.get(key, []);
      all.unshift(item);
      return this.set(key, all);
    }
    return this.upsert(key, [list.row(item)]);
  }

  /** Atomic lock: inserting the lock row fails (409) while another holder has it. Stale locks expire. */
  async tryLock(name, ttlMs = 90000) {
    const key = `lock_${name}`;
    const insert = () => this.fetch(`${this.base}/kv`, {
      method: 'POST',
      headers: { ...this.headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ key, value: { until: Date.now() + ttlMs }, updated_at: new Date().toISOString() }),
    });
    let res = await insert();
    if (res.ok) return true;
    if (res.status !== 409) throw new Error(`Supabase lock HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const cur = await this.get(key, null);
    if (cur && cur.until > Date.now()) return false;
    await this.req('DELETE', 'kv', `key=eq.${encodeURIComponent(key)}`); // stale: take it over
    res = await insert();
    return res.ok;
  }

  async unlock(name) {
    await this.req('DELETE', 'kv', `key=eq.${encodeURIComponent(`lock_${name}`)}`);
  }

  async del(key) {
    if (LISTS[key]) return this.req('DELETE', key, 'id=not.is.null');
    if (key === 'bot') return this.req('DELETE', 'settings', 'id=eq.bot');
    if (key.startsWith('shot_')) return this.set(key, {});
    return this.req('DELETE', 'kv', `key=eq.${encodeURIComponent(key)}`);
  }
}

/** Supabase if configured, else Upstash Redis, else local JSON files. */
export function createKV({ dataDir, redis, supabase }) {
  if (supabase?.url && supabase?.key) return new SupabaseKV(supabase);
  if (redis?.url && redis?.token) return new RedisKV(redis);
  return new FileKV(dataDir);
}
