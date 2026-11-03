// Creates (or updates) the ElevenLabs agent that elevenLabsAgentModel talks to: the screen tools as
// client tools, the built-in end_call tool, PCM 24 kHz audio, and a per-session prompt and greeting.
// Re-running it updates the same tools and agent. Never prints the API key.
//   node scripts/elevenlabs-agent.mjs [--llm gemini-3.5-flash] [--voice <voice_id>] [--name "methai demo"]
// Key: ELEVENLABS_API_KEY or ~/.config/elevenlabs/key (needs Agents read/write).
// The agent id is saved to ~/.config/elevenlabs/agent_id, where the demo server reads it.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API = process.env.ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io/v1';
const CONFIG = join(homedir(), '.config/elevenlabs');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const read = file => {
  try {
    return readFileSync(join(CONFIG, file), 'utf8').trim();
  } catch {
    return undefined;
  }
};
const KEY = process.env.ELEVENLABS_API_KEY ?? read('key');
if (!KEY) {
  console.error('Set ELEVENLABS_API_KEY or create ~/.config/elevenlabs/key');
  process.exit(1);
}

// The tool definitions live in the library's TypeScript; Node runs it directly (type stripping)
// once the relative imports name their files.
async function loadLibrary() {
  const src = join(dirname(fileURLToPath(import.meta.url)), '../src');
  const out = mkdtempSync(join(tmpdir(), 'methai-'));
  for (const name of ['llm', 'pcm', 'elevenlabs']) {
    const code = readFileSync(join(src, `${name}.ts`), 'utf8').replace(/from '\.\/(\w+)'/g, "from './$1.ts'");
    writeFileSync(join(out, `${name}.ts`), code);
  }
  return import(pathToFileURL(join(out, 'elevenlabs.ts')).href);
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : {};
}

const { elevenLabsClientTools } = await loadLibrary();
const toolConfigs = elevenLabsClientTools();

// Tools: update the ones with our names, create the rest.
const existing = new Map();
for (let cursor; ; ) {
  const page = await api('GET', `/convai/tools?page_size=100${cursor ? `&cursor=${cursor}` : ''}`);
  for (const t of page.tools ?? []) existing.set(t.tool_config?.name, t.id);
  if (!page.has_more) break;
  cursor = page.next_cursor;
}
const toolIds = [];
for (const tool_config of toolConfigs) {
  const id = existing.get(tool_config.name);
  const saved = id ? await api('PATCH', `/convai/tools/${id}`, { tool_config }) : await api('POST', '/convai/tools', { tool_config });
  toolIds.push(saved.id ?? id);
  console.log(`${id ? 'updated' : 'created'} tool ${tool_config.name}`);
}

const agent = {
  name: arg('name', 'methai demo'),
  conversation_config: {
    agent: {
      // The app sends its greeting as a dynamic variable (ElevenLabs rejects first_message
      // overrides even when allowed) and its prompt (app context + live screen) as an override.
      first_message: '{{greeting}}',
      language: 'en',
      prompt: {
        prompt: 'You operate a mobile app for the user with the screen tools.',
        llm: arg('llm', 'gemini-3.5-flash'),
        tool_ids: toolIds,
        // Lets the agent hang up when the user is done.
        built_in_tools: { end_call: { name: 'end_call', description: '', params: { system_tool_type: 'end_call' } } },
      },
    },
    // English agents must use a v2 voice model; other languages need eleven_flash_v2_5.
    tts: { model_id: 'eleven_flash_v2', voice_id: arg('voice', 'cgSgspJ2msm6clMCkdW9'), agent_output_audio_format: 'pcm_24000' },
    asr: { user_input_audio_format: 'pcm_24000' },
    turn: { turn_eagerness: 'normal' },
    conversation: { max_duration_seconds: 600 },
  },
  platform_settings: {
    overrides: {
      conversation_config_override: {
        agent: { language: true, prompt: { prompt: true } },
        tts: { voice_id: true },
      },
    },
  },
};

const agentId = process.env.ELEVENLABS_AGENT_ID ?? read('agent_id');
if (agentId) {
  await api('PATCH', `/convai/agents/${agentId}`, agent);
  console.log(`updated agent ${agentId}`);
} else {
  const { agent_id } = await api('POST', '/convai/agents/create', agent);
  mkdirSync(CONFIG, { recursive: true });
  writeFileSync(join(CONFIG, 'agent_id'), agent_id);
  console.log(`created agent ${agent_id} (saved to ~/.config/elevenlabs/agent_id)`);
}
