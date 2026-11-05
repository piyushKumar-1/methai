// methai dashboard: edit, publish and serve assistant configs.
//   UI          GET  /                              the dashboard
//   API         GET  /api/apps                      apps and their published revision
//               POST /api/apps {id, config?}        a new app (from a starter config)
//               GET  /api/apps/:id                  the published config
//               PUT  /api/apps/:id {config, note?}  validate and publish a new revision
//               GET  /api/apps/:id/revisions[/:n]   history, or one revision's config
//               POST /api/apps/:id/rollback {revision}  publish an old revision again
//               POST /api/validate {config}         check without publishing
//   For apps    GET  /apps/:id/methai.json          the published file, with ETag / Last-Modified
//                                                   (304 when the app's copy is current)
// Data: METHAI_DATA_DIR or ./data (one folder per app, one file per revision).
// Writes need `Authorization: Bearer $METHAI_DASHBOARD_TOKEN` when that is set.
// Run: node dashboard/server.mjs   (Node 22.18+ for the TypeScript validator import)
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METHAI_CONFIG_VERSION, validateMethaiConfig } from '../src/config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.METHAI_DATA_DIR ?? join(here, 'data');
const PORT = Number(process.env.PORT ?? 8790);
const TOKEN = process.env.METHAI_DASHBOARD_TOKEN;
const ts = () => new Date().toISOString().slice(11, 19);

const STARTER = {
  version: METHAI_CONFIG_VERSION,
  enabled: true,
  voice: { type: 'device', model: { endpoint: 'http://10.0.2.2:8787/openrouter/chat', model: 'nvidia/nemotron-3.5-super-vl:free', fallbackModels: ['google/gemma-4-26b-a4b-it:free'] } },
  assistant: { greeting: 'How can I help?', voiceInterruptions: 'smart', conversation: 'continuous' },
  confirm: { labelPatterns: ['\\bpay\\b'] },
  app: { name: '', description: '' },
};

const validId = id => /^[a-z0-9][a-z0-9-]{0,62}$/.test(id);
const appDir = id => join(DATA, id);
const etagOf = text => `"${createHash('sha256').update(text).digest('base64url').slice(0, 27)}"`;

async function revisions(id) {
  if (!existsSync(appDir(id))) return [];
  const files = (await readdir(appDir(id))).filter(f => /^rev-\d+\.json$/.test(f));
  const list = await Promise.all(files.map(async f => JSON.parse(await readFile(join(appDir(id), f), 'utf8'))));
  return list.sort((a, b) => a.revision - b.revision);
}

async function published(id) {
  const all = await revisions(id);
  return all.at(-1);
}

/** The file the apps download: the config exactly as published. */
const fileText = rev => JSON.stringify(rev.config, null, 2);

async function publish(id, config, note, by = 'dashboard') {
  const checked = validateMethaiConfig(config);
  if (!checked.ok) return { status: 422, body: { error: 'invalid config', errors: checked.errors } };
  const all = await revisions(id);
  const revision = (all.at(-1)?.revision ?? 0) + 1;
  const rev = { revision, publishedAt: new Date().toISOString(), note: note ?? '', by, config: checked.config };
  await mkdir(appDir(id), { recursive: true });
  await writeFile(join(appDir(id), `rev-${revision}.json`), JSON.stringify(rev, null, 2));
  console.log(`${ts()} published ${id} revision ${revision}${note ? ` (${note})` : ''}`);
  return { status: 200, body: summary(id, rev) };
}

const summary = (id, rev) => ({
  id,
  revision: rev.revision,
  publishedAt: rev.publishedAt,
  note: rev.note,
  etag: etagOf(fileText(rev)),
  enabled: rev.config.enabled !== false,
  voice: rev.config.voice?.type,
  name: rev.config.app?.name ?? '',
  url: `/apps/${id}/methai.json`,
});

const send = (res, status, body, headers = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }).end(status === 304 ? undefined : text);
};

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const write = req.method !== 'GET' && req.method !== 'HEAD';
  try {
    // The file apps fetch at start-up.
    let m = path.match(/^\/apps\/([a-z0-9-]+)\/methai\.json$/);
    if (m && req.method === 'GET') {
      const rev = await published(m[1]);
      if (!rev) return send(res, 404, { error: 'no published config' });
      const text = fileText(rev);
      const etag = etagOf(text);
      const lastModified = new Date(rev.publishedAt).toUTCString();
      const headers = { ETag: etag, 'Last-Modified': lastModified, 'Cache-Control': 'no-cache' };
      const notModified = req.headers['if-none-match'] === etag;
      console.log(`${ts()} ${m[1]}/methai.json r${rev.revision} ${notModified ? '304' : '200'}`);
      return notModified ? send(res, 304, '', headers) : send(res, 200, text, headers);
    }

    if (path === '/' || path === '/index.html') {
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(await readFile(join(here, 'public', 'index.html')));
    }

    if (!path.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (write && TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'token required' });

    if (path === '/api/validate' && req.method === 'POST') {
      const { config } = await readJson(req);
      const checked = validateMethaiConfig(config);
      return send(res, 200, checked.ok ? { ok: true } : { ok: false, errors: checked.errors });
    }

    if (path === '/api/apps' && req.method === 'GET') {
      if (!existsSync(DATA)) return send(res, 200, []);
      const ids = (await readdir(DATA, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
      const apps = (await Promise.all(ids.map(async id => ((await published(id)) ? summary(id, await published(id)) : null)))).filter(Boolean);
      return send(res, 200, apps.sort((a, b) => a.id.localeCompare(b.id)));
    }

    if (path === '/api/apps' && req.method === 'POST') {
      const { id, config } = await readJson(req);
      if (!validId(id ?? '')) return send(res, 400, { error: 'id: lowercase letters, digits and dashes' });
      if (await published(id)) return send(res, 409, { error: `${id} exists` });
      const r = await publish(id, config ?? { ...STARTER, app: { ...STARTER.app, name: id } }, 'created');
      return send(res, r.status, r.body);
    }

    m = path.match(/^\/api\/apps\/([a-z0-9-]+)(\/.*)?$/);
    if (!m) return send(res, 404, { error: 'not found' });
    const [, id, rest = ''] = m;

    if (rest === '' && req.method === 'GET') {
      const rev = await published(id);
      return rev ? send(res, 200, { ...summary(id, rev), config: rev.config }) : send(res, 404, { error: 'no such app' });
    }
    if (rest === '' && req.method === 'PUT') {
      const { config, note } = await readJson(req);
      const r = await publish(id, config, note);
      return send(res, r.status, r.body);
    }
    if (rest === '/revisions' && req.method === 'GET') {
      const all = await revisions(id);
      return send(res, 200, all.map(r => ({ ...summary(id, r), by: r.by })).reverse());
    }
    const rm = rest.match(/^\/revisions\/(\d+)$/);
    if (rm && req.method === 'GET') {
      const rev = (await revisions(id)).find(r => r.revision === Number(rm[1]));
      return rev ? send(res, 200, { ...summary(id, rev), config: rev.config }) : send(res, 404, { error: 'no such revision' });
    }
    if (rest === '/rollback' && req.method === 'POST') {
      const { revision } = await readJson(req);
      const rev = (await revisions(id)).find(r => r.revision === Number(revision));
      if (!rev) return send(res, 404, { error: 'no such revision' });
      const r = await publish(id, rev.config, `rollback to revision ${rev.revision}`);
      return send(res, r.status, r.body);
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(`${ts()} ${req.method} ${path}`, e);
    return send(res, e instanceof SyntaxError ? 400 : 500, { error: e instanceof SyntaxError ? 'body is not JSON' : e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces()).flat().filter(i => i?.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`methai dashboard on ${['localhost', ...ips].map(ip => `http://${ip}:${PORT}`).join(', ')}  (data: ${DATA}${TOKEN ? ', writes need the token' : ''})`);
});
