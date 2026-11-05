// Dev server for the demo: keeps the gateway key on your laptop.
//   POST /chat      -> forwards an OpenAI chat-completions body to the gateway
//   WS   /realtime  -> relays to the gateway's /v1/realtime (speech-to-speech models)
//   POST /openrouter/chat -> OpenRouter chat completions (same body as /chat)
//   POST /speech    -> hosted text-to-speech, streamed back as PCM: OpenRouter /audio/speech, or
//                      Sarvam (Indian languages) for models named sarvam/<model>, e.g. sarvam/bulbul:v3
//   GET  /elevenlabs/signed-url -> a one-off URL for a conversation with the ElevenLabs agent
//   GET  /elevenlabs/scribe-url -> a one-off URL for live captions (Scribe realtime speech-to-text)
//   WS   /deepgram/agent -> relays to Deepgram's Voice Agent (audio frames both ways), adding the key
// Keys: GRID_API_KEY or ~/.config/grid/key; OPENROUTER_API_KEY or ~/.config/openrouter/key;
// DEEPGRAM_API_KEY or ~/.config/deepgram/key; SARVAM_API_KEY or ~/.config/sarvam/key;
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
const DEEPGRAM_KEY = secret('DEEPGRAM_API_KEY', 'deepgram/key');
const SARVAM_KEY = secret('SARVAM_API_KEY', 'sarvam/key');
const auth = { Authorization: `Bearer ${KEY}` };
const ts = () => new Date().toISOString().slice(11, 19);

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return res.end('ok');
  if (req.method === 'GET' && req.url === '/elevenlabs/signed-url') return elevenLabsSignedUrl(res);
  if (req.method === 'GET' && req.url === '/elevenlabs/scribe-url') return elevenLabsScribeUrl(res);
  if (req.method === 'POST' && req.url === '/speech') return speech(req, res);
  if (req.method === 'POST' && req.url === '/openrouter/chat') return chat(req, res, 'https://openrouter.ai/api/v1', OPENROUTER_KEY, 'openrouter');
  if (req.method === 'POST' && req.url === '/chat') return chat(req, res, BASE, KEY, 'chat');
  res.writeHead(404).end();
});

/** Forwards an OpenAI chat-completions body with the key, and logs the tool calls or reply. */
async function chat(req, res, base, key, label) {
  if (!key) return json(res, 500, { error: { message: `No API key for ${label}` } });
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const t0 = Date.now();
  try {
    const body = JSON.parse(raw);
    const upstream = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
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
    console.log(`${ts()} ${label} ${body.model} ${upstream.status} ${Date.now() - t0}ms  ${summary || text.slice(0, 200)}`);
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(text);
  } catch (e) {
    console.error(`${ts()} ${label} error`, e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: e.message } }));
  }
}

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

/** The PCM samples and rate in a WAV file. */
function wavPcm(wav) {
  let rate = 24000;
  for (let i = 12; i + 8 <= wav.length; ) {
    const id = wav.toString('ascii', i, i + 4);
    const size = wav.readUInt32LE(i + 4);
    if (id === 'fmt ') rate = wav.readUInt32LE(i + 12);
    if (id === 'data') return { rate, pcm: wav.subarray(i + 8, i + 8 + size) };
    i += 8 + size + (size % 2);
  }
  return { rate, pcm: Buffer.alloc(0) };
}

// Sarvam's Bulbul voices speak Indian languages (and Indian English); it returns WAV, sent on as PCM.
async function sarvamSpeech(body, res, t0) {
  if (!SARVAM_KEY) return json(res, 500, { error: { message: 'No Sarvam key' } });
  const language = String(body.language || 'en-IN');
  const upstream = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: { 'api-subscription-key': SARVAM_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: body.input,
      model: body.model.replace(/^sarvam\//, ''),
      // Sarvam wants a region: 'kn' → 'kn-IN'.
      target_language_code: language.includes('-') ? language : `${language}-IN`,
      ...(body.voice && { speaker: body.voice }),
    }),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok || !data.audios?.[0]) {
    console.log(`${ts()} speech ${body.model} ${upstream.status} ${JSON.stringify(data).slice(0, 200)}`);
    return json(res, upstream.ok ? 502 : upstream.status, { error: { message: data.error?.message ?? 'Sarvam returned no audio' } });
  }
  const { rate, pcm } = wavPcm(Buffer.from(data.audios[0], 'base64'));
  res.writeHead(200, { 'Content-Type': `audio/pcm;rate=${rate};channels=1` }).end(pcm);
  console.log(`${ts()} speech ${body.model} ${body.voice ?? ''} ${language} 200 ${Date.now() - t0}ms, ${Math.round(pcm.length / 1024)} KB  ${JSON.stringify(body.input?.slice(0, 60))}`);
}

// Streams the audio through as it arrives, so the app can start playing before it's all made.
async function speech(req, res) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const t0 = Date.now();
  try {
    const body = JSON.parse(raw);
    if (String(body.model).startsWith('sarvam/')) return await sarvamSpeech(body, res, t0);
    if (!OPENROUTER_KEY) return json(res, 500, { error: { message: 'No OpenRouter key' } });
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
  if (url.pathname === '/deepgram/agent') return relayDeepgram(req, socket, head);
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

// Deepgram's Voice Agent: JSON messages and raw PCM audio frames, passed through as they are.
function relayDeepgram(req, socket, head) {
  if (!DEEPGRAM_KEY) return socket.destroy();
  wss.handleUpgrade(req, socket, head, client => {
    console.log(`${ts()} deepgram agent connect`);
    const upstream = new WebSocket('wss://agent.deepgram.com/v1/agent/converse', { headers: { Authorization: `Token ${DEEPGRAM_KEY}` } });
    const pending = [];
    const close = () => {
      client.close();
      upstream.close();
    };
    const forward = (to, data, isBinary) => to.readyState === WebSocket.OPEN && to.send(data, { binary: isBinary });
    client.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const m = JSON.parse(data.toString());
          if (m.type === 'Settings') {
            // A voice from ElevenLabs (other languages): Deepgram calls it with our ElevenLabs key.
            const speak = [m.agent?.speak].flat().filter(Boolean);
            for (const s of speak) if (/elevenlabs\.io/.test(s.endpoint?.url ?? '') && ELEVENLABS_KEY) s.endpoint.headers = { ...s.endpoint.headers, 'xi-api-key': ELEVENLABS_KEY };
            data = Buffer.from(JSON.stringify(m));
            console.log(
              `${ts()} deepgram Settings: language ${m.agent?.language ?? 'default'}, listen ${JSON.stringify(m.agent?.listen?.provider)}, speak ${speak.map(s => s.provider?.model_id ?? s.provider?.model).join('+')}, prompt ${m.agent?.think?.prompt?.length ?? 0} chars, ${m.agent?.think?.functions?.length ?? 0} functions`,
            );
          } else if (m.type !== 'KeepAlive') console.log(`${ts()} deepgram ← ${data.toString().slice(0, 160)}`);
        } catch {}
      }
      upstream.readyState === WebSocket.OPEN ? forward(upstream, data, isBinary) : pending.push([data, isBinary]);
    });
    upstream.on('open', () => pending.splice(0).forEach(([data, isBinary]) => forward(upstream, data, isBinary)));
    upstream.on('message', (data, isBinary) => {
      if (!isBinary) {
        const type = /"type":"(\w+)"/.exec(data.toString())?.[1];
        if (type && !['History', 'LatencyReport'].includes(type)) console.log(`${ts()} deepgram ${type} ${data.toString().slice(0, 160)}`);
      }
      forward(client, data, isBinary);
    });
    upstream.on('unexpected-response', (_q, r) => {
      console.error(`${ts()} deepgram upstream rejected: HTTP ${r.statusCode}`);
      close();
    });
    upstream.on('error', e => {
      console.error(`${ts()} deepgram upstream error`, e.message);
      close();
    });
    client.on('close', close);
    upstream.on('close', close);
  });
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces()).flat().filter(i => i?.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`demo server on ${ips.map(ip => `http://${ip}:${PORT}`).join(', ')} -> ${BASE}`);
});
