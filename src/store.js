// Tiny async key/value store for JSON documents.
// - FileKV: one JSON file per key in a directory (default, local runs).
// - RedisKV: Upstash Redis REST API, used when KV_REST_API_URL / UPSTASH_REDIS_REST_URL is set
//   (needed on Vercel, where the filesystem is not persistent between invocations).
import fs from 'node:fs/promises';
import path from 'node:path';

const clone = (v) => (v === undefined ? v : structuredClone(v));

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

export function createKV({ dataDir, redis }) {
  if (redis?.url && redis?.token) return new RedisKV(redis);
  return new FileKV(dataDir);
}
