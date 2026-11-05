import { memoryStorage, Methai, toAssistantConfig, validateMethaiConfig, type MethaiConfig, type VoiceIO } from '../src';

const config: MethaiConfig = {
  version: 1,
  voice: { type: 'device', model: { endpoint: 'https://relay/chat', model: 'open-fast', fallbackModels: ['open-large'] } },
  assistant: { greeting: 'How can I help?', greetings: { hi: 'बताइए क्या करना है?' }, voiceInterruptions: 'off', idleTimeoutMs: 9000 },
  confirm: { ids: ['review_journey_button_cta'], labelPatterns: ['^book ride', '\\bpay\\b'] },
  app: { name: 'Namma Yatri', flows: [{ name: 'Book', steps: 'Where to → pick → Book' }] },
};

/** A server that answers with `config` and an ETag, and 304 when the client already has it. */
function server(body: unknown = config) {
  const calls: Record<string, string>[] = [];
  let down = false;
  let current: unknown = body;
  const fetchImpl = (async (_url: string, init: any) => {
    calls.push(init.headers);
    if (down) throw new Error('Network request failed');
    const etag = `"${JSON.stringify(current).length}"`;
    if (init.headers['If-None-Match'] === etag) return { status: 304, ok: false, headers: { get: () => null }, json: async () => ({}) };
    return { status: 200, ok: true, headers: { get: (h: string) => (h === 'etag' ? etag : h === 'last-modified' ? 'Wed, 05 Nov 2026 10:00:00 GMT' : null) }, json: async () => current };
  }) as any;
  return { fetchImpl, calls, setDown: (d: boolean) => (down = d), publish: (c: unknown) => (current = c) };
}

test('validation: a good config passes; mistakes are listed with their paths', () => {
  expect(validateMethaiConfig(config)).toEqual({ ok: true, config });
  const bad = validateMethaiConfig({ version: 2, enabled: 'yes', voice: { type: 'device', model: { model: 'x' } }, confirm: { labelPatterns: ['(oops'] }, assistant: { voiceInterruptions: 'sometimes' } });
  expect(bad.ok).toBe(false);
  expect(!bad.ok && bad.errors).toEqual([
    'version should be 1',
    'enabled should be a boolean, not string',
    'voice.model.endpoint is required',
    'assistant.voiceInterruptions should be one of smart, off, raw',
    'confirm.labelPatterns[0] is not a valid pattern: (oops',
  ]);
});

test('init(url): fetches and saves a copy; next start sends the ETag and reuses the copy on 304', async () => {
  const storage = memoryStorage();
  const s = server();
  const first = new Methai();
  expect(await first.init('https://dash/apps/ny/methai.json', { storage, fetchImpl: s.fetchImpl })).toEqual(config);
  expect(first.state?.source).toBe('network');

  const next = new Methai();
  expect(await next.init('https://dash/apps/ny/methai.json', { storage, fetchImpl: s.fetchImpl })).toEqual(config);
  expect(next.state?.source).toBe('not-modified');
  expect(s.calls[1]['If-None-Match']).toBe(first.state!.etag);
  expect(s.calls[1]['If-Modified-Since']).toBe('Wed, 05 Nov 2026 10:00:00 GMT');

  // A newer config published: fetched and saved.
  s.publish({ ...config, enabled: false });
  expect((await next.refresh()).enabled).toBe(false);
  expect(next.state?.source).toBe('network');
});

test('init(url): offline or a bad answer falls back to the local copy, then to the fallback', async () => {
  const storage = memoryStorage();
  const s = server();
  await new Methai().init('https://dash/c.json', { storage, fetchImpl: s.fetchImpl });

  s.setDown(true);
  const offline = new Methai();
  const seen: string[] = [];
  offline.subscribe(state => seen.push(state.source));
  expect(await offline.init('https://dash/c.json', { storage, fetchImpl: s.fetchImpl })).toEqual(config);
  expect(offline.state).toMatchObject({ source: 'cache', error: 'Network request failed' });
  expect(seen).toEqual(['cache']);

  s.setDown(false);
  s.publish({ version: 1, voice: { type: 'nope' } });
  const broken = new Methai();
  // An invalid config from the server is never used: with no local copy, the fallback is.
  await broken.init('https://dash/c.json', { storage: memoryStorage(), fetchImpl: s.fetchImpl, fallback: { version: 1, enabled: false } });
  expect(broken.state).toMatchObject({ source: 'fallback', config: { enabled: false } });
  expect(broken.state?.error).toMatch(/^invalid config: voice.type should be one of/);

  await expect(new Methai().init('https://dash/c.json', { fetchImpl: s.fetchImpl })).rejects.toThrow(/methai config unavailable/);
  await expect(new Methai().init({ version: 9 } as any)).rejects.toThrow(/Invalid methai config: version should be 1/);
});

test('toAssistantConfig: behaviour, language greetings, confirm rules, live interruptions; off when disabled', () => {
  const deviceVoice: VoiceIO = { speak: async () => {}, listen: async () => '' };
  let lang = 'hi-IN';
  let choice: 'smart' | 'off' | undefined;
  const assistant = toAssistantConfig(config, { deviceVoice, language: () => lang, voiceInterruptions: () => choice })!;
  expect('model' in assistant && 'voice' in assistant).toBe(true);
  expect((assistant.greeting as any)({ screen: '', resumed: false })).toBe('बताइए क्या करना है?');
  lang = 'en';
  expect((assistant.greeting as any)({ screen: '', resumed: false })).toBe('How can I help?');
  expect(assistant.idleTimeoutMs).toBe(9000);
  expect(assistant.app?.name).toBe('Namma Yatri');
  expect(assistant.confirm!.isSensitive('review_journey_button_cta', undefined)).toBe(true);
  expect(assistant.confirm!.isSensitive('x', 'Book Ride @ ₹45')).toBe(true);
  expect(assistant.confirm!.isSensitive('x', 'book a ride to Cubbon Park')).toBe(false);
  expect(assistant.voiceInterruptions).toBe('off'); // the config's default
  choice = 'smart';
  expect(assistant.voiceInterruptions).toBe('smart'); // the user's choice, live
  expect(toAssistantConfig({ ...config, enabled: false }, { deviceVoice })).toBeUndefined();
  expect(() => toAssistantConfig({ version: 1, voice: { type: 'deepgram', url: 'wss://relay' } }, {})).toThrow(/needs runtime.audio/);
});
