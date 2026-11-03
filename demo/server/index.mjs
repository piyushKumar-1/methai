// Dev server for the demo: keeps the gateway key on your laptop.
//   POST /chat      -> forwards an OpenAI chat-completions body to the gateway
//   WS   /realtime  -> relays to the gateway's /v1/realtime (speech-to-speech models)
//   POST /speech    -> OpenRouter /audio/speech (hosted text-to-speech), streamed back
//   GET  /elevenlabs/signed-url -> a one-off URL for a conversation with the ElevenLabs agent
//   GET  /elevenlabs/scribe-url -> a one-off URL for live captions (Scribe realtime speech-to-text)
// Keys: GRID_API_KEY or ~/.config/grid/key; OPENROUTER_API_KEY or ~/.config/openrouter/key;
// ELEVENLABS_API_KEY or ~/.config/elevenlabs/key, with the agent from scripts/elevenlabs-agent.mjs
// (ELEVENLABS_AGENT_ID or ~/.config/elevenlabs/agent_id).   Run: npm run server
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import WebSocket, { WebSocketServer } from 'ws';

const BASE = process.env.GRID_BASE_URL ?? 'https://grid.ai.juspay.net/v1';
const PORT = Number(process.env.PORT ?? 8787);
const secret = (env, file) => {
  if (process.env[env]) return process.env[env];
  try {
    return readFileSync(`${homedir()}/.config/${file}`, 'utf8').trim();
  } catch {
    return undefined;
  }
};
const KEY = secret('GRID_API_KEY', 'grid/key');
const OPENROUTER_KEY = secret('OPENROUTER_API_KEY', 'openrouter/key');
const ELEVENLABS_KEY = secret('ELEVENLABS_API_KEY', 'elevenlabs/key');
const ELEVENLABS_AGENT = secret('ELEVENLABS_AGENT_ID', 'elevenlabs/agent_id');
const auth = { Authorization: `Bearer ${KEY}` };
const ts = () => new Date().toISOString().slice(11, 19);

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return res.end('ok');
  if (req.method === 'GET' && req.url === '/elevenlabs/signed-url') return elevenLabsSignedUrl(res);
  if (req.method === 'GET' && req.url === '/elevenlabs/scribe-url') return elevenLabsScribeUrl(res);
  if (req.method === 'POST' && req.url === '/speech') return speech(req, res);
  if (req.method !== 'POST' || req.url !== '/chat') {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const t0 = Date.now();
  try {
    const body = JSON.parse(raw);
    const upstream = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    let summary = '';
    try {
      const msg = JSON.parse(text).choices?.[0]?.message;
      summary = msg?.tool_calls?.length
        ? msg.tool_calls.map(c => `${c.function.name}(${c.function.arguments})`).join(', ')
        : JSON.stringify((msg?.content ?? '').slice(0, 120));
    } catch {}
    console.log(`${ts()} chat ${body.model} ${upstream.status} ${Date.now() - t0}ms  ${summary || text.slice(0, 200)}`);
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(text);
  } catch (e) {
    console.error(`${ts()} chat error`, e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: e.message } }));
  }
});

const json = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

async function elevenLabsSignedUrl(res) {
  if (!ELEVENLABS_KEY || !ELEVENLABS_AGENT) return json(res, 500, { error: { message: 'No ElevenLabs key or agent: run node scripts/elevenlabs-agent.mjs' } });
  const upstream = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${ELEVENLABS_AGENT}`, {
    headers: { 'xi-api-key': ELEVENLABS_KEY },
  });
  console.log(`${ts()} elevenlabs signed-url ${upstream.status}`);
  res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(await upstream.text());
}

async function elevenLabsScribeUrl(res) {
  if (!ELEVENLABS_KEY) return json(res, 500, { error: { message: 'No ElevenLabs key' } });
  const upstream = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_KEY },
  });
  console.log(`${ts()} elevenlabs scribe-token ${upstream.status}`);
  if (!upstream.ok) return res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(await upstream.text());
  const { token } = await upstream.json();
  const params = new URLSearchParams({ model_id: 'scribe_v2_realtime', audio_format: 'pcm_24000', commit_strategy: 'vad', token });
  json(res, 200, { url: `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}` });
}

// Streams the audio through as it arrives, so the app can start playing before it's all made.
async function speech(req, res) {
  if (!OPENROUTER_KEY) return json(res, 500, { error: { message: 'No OpenRouter key' } });
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const t0 = Date.now();
  try {
    const body = JSON.parse(raw);
    const upstream = await fetch('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
      body: raw,
    });
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream' });
    let bytes = 0;
    let first = 0;
    for await (const chunk of upstream.body ?? []) {
      first ||= Date.now() - t0;
      bytes += chunk.length;
      res.write(chunk);
    }
    res.end();
    console.log(`${ts()} speech ${body.model} ${body.voice} ${upstream.status} first byte ${first}ms, ${Date.now() - t0}ms, ${Math.round(bytes / 1024)} KB  ${JSON.stringify(body.input?.slice(0, 60))}`);
  } catch (e) {
    console.error(`${ts()} speech error`, e.message);
    if (!res.headersSent) json(res, 502, { error: { message: e.message } });
    else res.end();
  }
}

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/realtime') return socket.destroy();
  wss.handleUpgrade(req, socket, head, client => {
    const model = url.searchParams.get('model') ?? 'xor-latest-custom';
    console.log(`${ts()} realtime connect ${model}`);
    const upstream = new WebSocket(`${BASE.replace(/^http/, 'ws')}/realtime?model=${encodeURIComponent(model)}`, { headers: auth });
    const pending = [];
    const close = () => {
      client.close();
      upstream.close();
    };
    client.on('message', d => (upstream.readyState === WebSocket.OPEN ? upstream.send(d.toString()) : pending.push(d.toString())));
    upstream.on('open', () => pending.splice(0).forEach(d => upstream.send(d)));
    upstream.on('message', d => client.readyState === WebSocket.OPEN && client.send(d.toString()));
    upstream.on('unexpected-response', (_q, r) => {
      console.error(`${ts()} realtime upstream rejected: HTTP ${r.statusCode}`);
      client.send(JSON.stringify({ type: 'error', error: { message: `Gateway rejected the realtime connection (HTTP ${r.statusCode})` } }));
      close();
    });
    upstream.on('error', e => {
      console.error(`${ts()} realtime upstream error`, e.message);
      close();
    });
    client.on('close', close);
    upstream.on('close', close);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces()).flat().filter(i => i?.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`demo server on ${ips.map(ip => `http://${ip}:${PORT}`).join(', ')} -> ${BASE}`);
});
