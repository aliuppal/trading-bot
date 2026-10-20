import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HybridKV, NeonKV, RedisKV } from '../src/store.js';

/** In-memory Upstash REST stand-in: single commands at "/", arrays of commands at "/pipeline". Counts commands. */
function fakeRedis() {
  const db = new Map();
  const stats = { commands: 0, requests: 0 };
  const run = ([c, ...a]) => {
    stats.commands++;
    switch (c) {
      case 'GET': return db.has(a[0]) ? db.get(a[0]) : null;
      case 'SET': {
        if (a.includes('NX') && db.has(a[0])) return null;
        db.set(a[0], a[1]);
        return 'OK';
      }
      case 'MGET': return a.map((k) => (db.has(k) ? db.get(k) : null));
      case 'MSET': for (let i = 0; i < a.length; i += 2) db.set(a[i], a[i + 1]); return 'OK';
      case 'DEL': return db.delete(a[0]) ? 1 : 0;
      case 'HSET': { const h = db.get(a[0]) || {}; for (let i = 1; i < a.length; i += 2) h[a[i]] = String(a[i + 1]); db.set(a[0], h); return 1; }
      case 'HGETALL': return Object.entries(db.get(a[0]) || {}).flat();
      case 'LPUSH': { const l = db.get(a[0]) || []; l.unshift(...a.slice(1).reverse()); db.set(a[0], l); return l.length; }
      case 'RPUSH': { const l = db.get(a[0]) || []; l.push(...a.slice(1)); db.set(a[0], l); return l.length; }
      case 'LTRIM': { const l = db.get(a[0]) || []; db.set(a[0], l.slice(a[1], a[2] + 1)); return 'OK'; }
      case 'LRANGE': return (db.get(a[0]) || []).slice(a[1], a[2] + 1);
      default: throw new Error(`unsupported ${c}`);
    }
  };
  const fetchImpl = async (url, opts) => {
    stats.requests++;
    const body = JSON.parse(opts.body);
    const out = url.endsWith('/pipeline') ? body.map((cmd) => ({ result: run(cmd) })) : { result: run(body) };
    return { ok: true, status: 200, json: async () => out };
  };
  return { db, stats, fetchImpl };
}

/** Neon stand-in: records every query (each one would wake the database). */
function fakeNeon(rows = {}) {
  const calls = [];
  const sql = {
    query: async (text) => {
      calls.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
      if (/^select data from settings/.test(text)) return rows.bot ? [{ data: rows.bot }] : [];
      if (/^select data from trades/.test(text)) return (rows.trades || []).map((data) => ({ data }));
      if (/^select data from decisions/.test(text)) return (rows.decisions || []).map((data) => ({ data }));
      return [];
    },
  };
  return { calls, kv: new NeonKV({ url: 'postgres://x' }, sql) };
}

function make(neonRows) {
  const r = fakeRedis();
  const n = fakeNeon(neonRows);
  const kv = new HybridKV({ redis: new RedisKV({ url: 'https://r', token: 't' }, r.fetchImpl), neon: n.kv });
  return { kv, r, n };
}

test('HybridKV: seeds a key from Neon once, then Redis owns it', async () => {
  const { kv, n } = make({ bot: { running: true, settings: { model: 'ifvg_nojev' } } });
  await kv.beginRequest();
  assert.equal((await kv.get('bot', null)).settings.model, 'ifvg_nojev');
  assert.equal(n.calls.filter((c) => c.startsWith('select')).length, 1);
  await kv.beginRequest();
  await kv.get('bot', null);
  assert.equal(n.calls.filter((c) => c.startsWith('select')).length, 1, 'second read served by Redis / memory');
});

test('HybridKV: a bot cycle never touches Neon and costs a handful of Redis commands', async () => {
  const { kv, r, n } = make({ bot: { running: true } });
  // first request seeds the keys
  await kv.beginRequest();
  for (const k of ['bot', 'bot_ETHUSDT', 'bot_SOLUSDT', 'trades']) await kv.get(k, null);
  const neonBefore = n.calls.length;
  const before = r.stats.commands;
  // one cron cycle: versions, lock, prefetch, 3 state writes batched, unlock
  await kv.beginRequest();
  assert.equal(await kv.tryLock('cycle'), true);
  assert.equal(await kv.tryLock('cycle'), false, 'second holder is refused');
  kv.startBatch();
  await kv.prefetch(['bot', 'bot_ETHUSDT', 'bot_SOLUSDT', 'trades']);
  for (const k of ['bot', 'bot_ETHUSDT', 'bot_SOLUSDT']) await kv.set(k, { lastRun: 'now', k });
  await kv.flush();
  await kv.unlock('cycle');
  assert.equal(n.calls.length, neonBefore, 'Neon untouched by the cycle');
  assert.ok(r.stats.commands - before <= 7, `commands per cycle: ${r.stats.commands - before}`);
});

test('HybridKV: trades go to Neon only when a row materially changes; other instances see writes', async () => {
  const { kv, n, r } = make({});
  await kv.beginRequest();
  const t = { id: 'T1', side: 'short', status: 'open', entryTime: '2026-10-20T10:00:00Z', entryPrice: 100, qty: 1, stop: 101 };
  await kv.set('trades', [t]);
  const upserts = () => n.calls.filter((c) => c.startsWith('insert into trades')).length;
  assert.equal(upserts(), 1, 'opened -> archived');
  await kv.set('trades', [{ ...t, lastReviewAt: '2026-10-20T10:02:00Z', reviews: 1 }]);
  assert.equal(upserts(), 1, 'a review stamp alone does not wake Neon');
  await kv.set('trades', [{ ...t, stop: 100, breakeven: true }]);
  assert.equal(upserts(), 2, 'stop moved -> archived');
  // a second instance (own memory) reads the latest list through the version stamp
  const other = new HybridKV({ redis: new RedisKV({ url: 'https://r', token: 't' }, r.fetchImpl), neon: n.kv });
  await other.beginRequest();
  assert.equal((await other.get('trades', []))[0].stop, 100);
  await other.set('trades', [{ ...t, status: 'win', exitPrice: 98 }]);
  await kv.beginRequest();
  assert.equal((await kv.get('trades', []))[0].status, 'win', 'stale memory replaced after the version changed');
});

test('HybridKV: decisions newest first in Redis; only executed / error ones archived in Neon', async () => {
  const { kv, n } = make({});
  await kv.beginRequest();
  await kv.append('decisions', { id: 'D1', time: '2026-10-20T10:00:00Z', action: 'HOLD', note: 'no setup' });
  await kv.append('decisions', { id: 'D2', time: '2026-10-20T10:01:00Z', action: 'SELL', executed: true });
  await kv.append('decisions', { id: 'D3', time: '2026-10-20T10:02:00Z', action: 'ERROR', note: 'x' });
  await kv.beginRequest();
  assert.deepEqual((await kv.get('decisions', [])).map((d) => d.id), ['D3', 'D2', 'D1']);
  assert.equal(n.calls.filter((c) => c.startsWith('insert into decisions')).length, 2);
  assert.notEqual(await kv.latest('decisions'), '');
});
