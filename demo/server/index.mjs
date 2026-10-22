// Dev server for the demo: keeps the gateway key on your laptop.
//   POST /chat      -> forwards an OpenAI chat-completions body to the gateway
//   WS   /realtime  -> relays to the gateway's /v1/realtime (speech-to-speech models)
// Key: GRID_API_KEY env var, or ~/.config/grid/key.   Run: npm run server
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import WebSocket, { WebSocketServer } from 'ws';

const BASE = process.env.GRID_BASE_URL ?? 'https://grid.ai.juspay.net/v1';
const PORT = Number(process.env.PORT ?? 8787);
const KEY = process.env.GRID_API_KEY ?? readFileSync(`${homedir()}/.config/grid/key`, 'utf8').trim();
const auth = { Authorization: `Bearer ${KEY}` };
const ts = () => new Date().toISOString().slice(11, 19);

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return res.end('ok');
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
