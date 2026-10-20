// Creates the bot's tables on Neon (neon/schema.sql). Reads the connection string from DATABASE_URL (env or .env).
//   DATABASE_URL='postgresql://...' node scripts/neon-setup.js
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL to the Neon connection string');
const sql = neon(url);
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'neon', 'schema.sql');
const statements = fs.readFileSync(file, 'utf8').replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
for (const s of statements) await sql.query(s);
const tables = await sql.query("select table_name from information_schema.tables where table_schema = 'public' order by 1");
console.log(`Neon schema ready (${statements.length} statements): ${tables.map((t) => t.table_name).join(', ')}`);
