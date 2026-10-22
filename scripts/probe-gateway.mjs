// Checks what the gateway supports for a voice model. Never prints the API key.
//   GRID_API_KEY=... node scripts/probe-gateway.mjs [model]
// or put the key in ~/.config/grid/key (chmod 600).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import WebSocket from 'ws';

const BASE = process.env.GRID_BASE_URL ?? 'https://grid.ai.juspay.net/v1';
const MODEL = process.argv[2] ?? 'xor-latest-custom';
let KEY = process.env.GRID_API_KEY;
if (!KEY) {
  try {
    KEY = readFileSync(`${homedir()}/.config/grid/key`, 'utf8').trim();
  } catch {}
}
if (!KEY) {
  console.error('Set GRID_API_KEY or create ~/.config/grid/key');
  process.exit(1);
}
const auth = { Authorization: `Bearer ${KEY}` };

async function models() {
  const res = await fetch(`${BASE}/models`, { headers: auth });
  console.log(`\n[models] HTTP ${res.status}`);
  if (!res.ok) return console.log((await res.text()).slice(0, 300));
  const ids = ((await res.json()).data ?? []).map(m => m.id);
  console.log(`  ${ids.length} models; ${MODEL} listed: ${ids.includes(MODEL)}`);
  const voiceish = ids.filter(id => /xor|realtime|audio|voice|tts|whisper|transcri/i.test(id));
  console.log(`  voice-related: ${voiceish.join(', ') || '(none)'}`);
}

function realtime(protocol) {
  return new Promise(resolve => {
    const url = `${BASE.replace(/^http/, 'ws')}/realtime?model=${encodeURIComponent(MODEL)}`;
    console.log(`\n[realtime ${protocol}] ${url}`);
    const ws = new WebSocket(url, { headers: auth });
    const counts = {};
    let transcript = '';
    let toolCalled = false;
    let answered = false;
    const done = summary => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      console.log(`  events: ${JSON.stringify(counts)}`);
      if (transcript) console.log(`  model said: ${JSON.stringify(transcript.slice(0, 200))}`);
      console.log(`  => ${summary}`);
      resolve();
    };
    const timer = setTimeout(() => done('timed out after 40s'), 40000);
    const send = e => ws.send(JSON.stringify(e));
    const tools = [{ type: 'function', name: 'get_time', description: 'Returns the current time.', parameters: { type: 'object', properties: {} } }];
    const session = protocol === 'ga'
      ? { type: 'realtime', instructions: 'You are a test assistant. Always use tools when asked.', tools, tool_choice: 'auto', audio: { input: { format: { type: 'audio/pcm', rate: 24000 } }, output: { format: { type: 'audio/pcm', rate: 24000 } } } }
      : { modalities: ['audio', 'text'], instructions: 'You are a test assistant. Always use tools when asked.', tools, tool_choice: 'auto', input_audio_format: 'pcm16', output_audio_format: 'pcm16' };

    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => done(`handshake rejected: HTTP ${res.statusCode} ${body.slice(0, 300)}`));
    });
    ws.on('error', err => done(`connection error: ${err.message}`));
    ws.on('open', () => {
      send({ type: 'session.update', session });
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What time is it? Call the get_time tool.' }] } });
      send({ type: 'response.create' });
    });
    ws.on('message', raw => {
      const e = JSON.parse(raw.toString());
      counts[e.type] = (counts[e.type] ?? 0) + 1;
      if (e.type === 'session.created') console.log(`  session shape: ${e.session?.audio ? 'GA (audio.*)' : e.session?.modalities ? 'beta (modalities)' : Object.keys(e.session ?? {}).join(',')}`);
      if (e.type === 'error') return done(`error: ${JSON.stringify(e.error).slice(0, 300)}`);
      if (/transcript\.delta$/.test(e.type) || e.type === 'response.output_text.delta' || e.type === 'response.text.delta') transcript += e.delta ?? '';
      if (e.type === 'response.done') {
        const call = (e.response?.output ?? []).find(o => o.type === 'function_call');
        if (call && !toolCalled) {
          toolCalled = true;
          send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({ time: '10:42' }) } });
          send({ type: 'response.create' });
        } else if (!answered) {
          answered = true;
          const audio = (counts['response.output_audio.delta'] ?? 0) + (counts['response.audio.delta'] ?? 0);
          done(`OK. tool call: ${toolCalled ? 'yes' : 'NO'}, audio chunks: ${audio}`);
        }
      }
    });
  });
}

async function clientSecret() {
  const res = await fetch(`${BASE}/realtime/client_secrets`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: { type: 'realtime', model: MODEL } }),
  });
  const body = await res.text();
  let hasSecret = false;
  try {
    const j = JSON.parse(body);
    hasSecret = typeof (j.value ?? j.client_secret?.value) === 'string';
  } catch {}
  console.log(`\n[client_secrets] HTTP ${res.status}; short-lived secret returned: ${hasSecret}${hasSecret ? '' : `\n  ${body.slice(0, 300)}`}`);
}

console.log(`gateway ${BASE}, model ${MODEL}`);
await models();
await realtime('ga');
await realtime('beta');
await clientSecret();
