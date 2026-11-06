import { base64ToBytes, floatToPcm16Base64, pcm16ToWav, speechEndpointer, validateMethaiConfig, withHostedListening, type PcmAudioIO, type VoiceIO } from '../src';

const CHUNK = 2400; // 100 ms at 24 kHz
const tone = (amplitude: number) => floatToPcm16Base64(Float32Array.from({ length: CHUNK }, (_, i) => amplitude * Math.sin(i / 3)));
const LOUD = tone(0.3);
const QUIET = tone(0.001);

function fakeMic() {
  let onChunk: ((c: string) => void) | null = null;
  const audio: PcmAudioIO & { feed(chunks: string[]): void; stopped: number } = {
    stopped: 0,
    startCapture: jest.fn(async cb => {
      onChunk = cb;
    }),
    stopCapture: jest.fn(async () => {
      audio.stopped++;
      onChunk = null;
    }),
    play: jest.fn(),
    flush: jest.fn(),
    drained: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
    feed(chunks) {
      for (const c of chunks) onChunk?.(c);
    },
  };
  return audio;
}

const deviceVoice = (): VoiceIO => ({
  speak: jest.fn(async () => {}),
  listen: jest.fn(async () => 'from the phone'),
});

const repeat = (chunk: string, n: number) => Array.from({ length: n }, () => chunk);
const flush = () => new Promise(r => setTimeout(r, 0));

describe('speechEndpointer', () => {
  const opts = { endSilenceMs: 900, noSpeechMs: 8000, maxTurnMs: 20000 };

  it('ends the turn after the user has spoken and gone quiet', () => {
    const e = speechEndpointer(opts);
    const results = [...repeat('q', 5), ...repeat('l', 10), ...repeat('q', 9)].map(k => e.push(k === 'l' ? 0.7 : 0.04, 100));
    expect(results.slice(0, -1).every(r => r === null)).toBe(true);
    expect(results[results.length - 1]).toBe('end of speech');
  });

  it("doesn't count a short click as speech", () => {
    const e = speechEndpointer(opts);
    e.push(0.04, 100);
    e.push(0.8, 100);
    for (let i = 0; i < 12; i++) e.push(0.04, 100);
    expect(e.speaking).toBe(false);
  });

  it('gives up when nothing is said', () => {
    const e = speechEndpointer(opts);
    const results = Array.from({ length: 80 }, () => e.push(0.04, 100));
    expect(results[79]).toBe('no speech');
    expect(results.slice(0, 79).every(r => r === null)).toBe(true);
  });

  it("learns a noisy room's level, so steady noise isn't speech", () => {
    const e = speechEndpointer(opts);
    for (let i = 0; i < 30; i++) e.push(0.25, 100);
    expect(e.speaking).toBe(false);
    for (let i = 0; i < 3; i++) e.push(0.7, 100);
    expect(e.speaking).toBe(true);
  });

  it('hears someone who talks from the first moment', () => {
    const e = speechEndpointer(opts);
    for (let i = 0; i < 3; i++) e.push(0.7, 100);
    expect(e.speaking).toBe(true);
  });

  it('keeps following the room while the user talks, and ends after their last word', () => {
    const e = speechEndpointer(opts);
    // A noisy room (0.3), words (0.75) with short gaps back to the room's level, then quiet.
    for (let i = 0; i < 10; i++) e.push(0.3, 100);
    const words = Array.from({ length: 40 }, (_, i) => (i % 5 === 4 ? 0.3 : 0.75));
    expect(words.map(l => e.push(l, 100)).every(r => r === null)).toBe(true);
    const after = Array.from({ length: 9 }, () => e.push(0.3, 100));
    expect(after[8]).toBe('end of speech');
    expect(e.levels).toEqual({ noise: 0.3, peak: 0.75 });
  });

  it('stops a turn that runs too long', () => {
    const e = speechEndpointer({ ...opts, maxTurnMs: 1000 });
    const results = Array.from({ length: 10 }, () => e.push(0.7, 100));
    expect(results[9]).toBe('too long');
  });
});

describe('pcm16ToWav', () => {
  it('writes a 16-bit mono WAV header around the samples', () => {
    const wav = pcm16ToWav(new Float32Array([0, 0.5, -0.5]), 16000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(wav.length).toBe(50);
  });
});

describe('withHostedListening', () => {
  const okFetch = (text: string) =>
    jest.fn(async (_url: string, _init: any) => ({ ok: true, status: 200, json: async () => ({ text }) }) as any) as jest.Mock & typeof fetch;

  it('records until the user stops, sends a WAV and returns the words', async () => {
    const audio = fakeMic();
    const fetchImpl = okFetch('Book an auto to Cubbon Park');
    const voice = withHostedListening(deviceVoice(), { endpoint: 'http://relay/transcribe', model: 'saaras:v3', language: () => 'hi-IN', audio, fetchImpl });
    const partial = jest.fn();
    const heard = voice.listen(new AbortController().signal, partial);
    await flush();
    audio.feed([...repeat(QUIET, 3), ...repeat(LOUD, 8), ...repeat(QUIET, 9)]);

    await expect(heard).resolves.toBe('Book an auto to Cubbon Park');
    expect(audio.stopped).toBe(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://relay/transcribe');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'saaras:v3', language: 'hi-IN' });
    const wav = base64ToBytes(body.audio);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    // The quiet lead-in is trimmed to a short pre-roll: 3 quiet + 8 loud + 9 quiet chunks at most.
    expect((wav.length - 44) / 2).toBeLessThanOrEqual(20 * 1600);
    expect(partial).toHaveBeenCalledWith('Book an auto to Cubbon Park');
  });

  it("returns '' without uploading when nothing is said", async () => {
    const audio = fakeMic();
    const fetchImpl = okFetch('ignored');
    const voice = withHostedListening(deviceVoice(), { endpoint: 'x', model: 'm', audio, fetchImpl, noSpeechMs: 1000 });
    const heard = voice.listen(new AbortController().signal);
    await flush();
    audio.feed(repeat(QUIET, 10));
    await expect(heard).resolves.toBe('');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops the mic and returns nothing when cut off', async () => {
    const audio = fakeMic();
    const fetchImpl = okFetch('ignored');
    const voice = withHostedListening(deviceVoice(), { endpoint: 'x', model: 'm', audio, fetchImpl });
    const abort = new AbortController();
    const heard = voice.listen(abort.signal);
    await flush();
    audio.feed(repeat(LOUD, 5));
    abort.abort();
    await expect(heard).resolves.toBe('');
    expect(audio.stopped).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lets the phone's recognizer listen when the mic can't be opened", async () => {
    const audio = fakeMic();
    (audio.startCapture as jest.Mock).mockRejectedValueOnce(new Error('mic busy'));
    const device = deviceVoice();
    const onError = jest.fn();
    const voice = withHostedListening(device, { endpoint: 'x', model: 'm', audio, fetchImpl: okFetch('x'), onError });
    await expect(voice.listen(new AbortController().signal)).resolves.toBe('from the phone');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'mic busy' }));
  });

  it("reports a failed transcription and returns '' so the assistant asks again", async () => {
    const audio = fakeMic();
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'rate limited' } }) }) as any) as jest.Mock & typeof fetch;
    const onError = jest.fn();
    const voice = withHostedListening(deviceVoice(), { endpoint: 'x', model: 'm', audio, fetchImpl, onError });
    const heard = voice.listen(new AbortController().signal);
    await flush();
    audio.feed([...repeat(LOUD, 5), ...repeat(QUIET, 10)]);
    await expect(heard).resolves.toBe('');
    expect(onError.mock.calls[0][0].message).toMatch(/HTTP 429 rate limited/);
  });

  it("keeps the wrapped voice's speaking", async () => {
    const device = deviceVoice();
    const voice = withHostedListening(device, { endpoint: 'x', model: 'm', audio: fakeMic() });
    await voice.speak('hi', new AbortController().signal);
    expect(device.speak).toHaveBeenCalledWith('hi', expect.anything());
  });
});

describe('config: hosted listening', () => {
  const base = { version: 1, voice: { type: 'device', model: { endpoint: 'e', model: 'm' } } };

  it('accepts a listen block', () => {
    const config = { ...base, voice: { ...base.voice, listen: { endpoint: 'http://relay/transcribe', model: 'saaras:v3', endSilenceMs: 800 } } };
    expect(validateMethaiConfig(config).ok).toBe(true);
  });

  it('rejects one without a model', () => {
    const result = validateMethaiConfig({ ...base, voice: { ...base.voice, listen: { endpoint: 'x' } } });
    expect(result).toEqual({ ok: false, errors: ['voice.listen.model is required'] });
  });
});
