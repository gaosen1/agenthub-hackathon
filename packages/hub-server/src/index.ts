/**
 * hub-server 入口：生产装配（spec §4.2）
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { createOssSigner } from './oss.js';

const PORT = Number(process.env.HUB_PORT ?? 4180);
const DB_PATH = process.env.HUB_DB_PATH ?? './data/hub.sqlite';
const SECRET = process.env.HUB_SECRET_KEY;

if (!SECRET) {
  console.error('HUB_SECRET_KEY is required');
  process.exit(1);
}

mkdirSync(dirname(DB_PATH), { recursive: true });
const app = buildApp({
  db: openDb(DB_PATH),
  signer: createOssSigner(),
  secret: SECRET,
  webBaseUrl: process.env.HUB_WEB_URL,
});

app
  .listen({ port: PORT, host: process.env.HUB_HOST ?? '127.0.0.1' })
  .then(() => console.log(`hub-server listening on :${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
