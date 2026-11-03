import type { SpeakResult, VoiceIO } from './assistant';
import { floatToPcm16Base64, pcmLevel, resample } from './pcm';
import type { PcmAudioIO } from './realtime';

export interface HostedSpeechOptions {
  /**
   * An OpenAI-compatible POST /audio/speech endpoint: OpenAI, OpenRouter
   * (https://openrouter.ai/api/v1/audio/speech), or your relay that adds the key.
   */
  endpoint: string;
  /** e.g. 'elevenlabs/eleven-flash-v2.5'. A getter lets a settings screen switch it. */
  model: string | (() => string);
  voice?: string | (() => string | undefined);
  headers?: Record<string, string>;
  /** Plays the audio (24 kHz PCM16), e.g. the PcmAudioIO used for realtime voice. */
  audio: PcmAudioIO;
  /** Sample rate when the response's content-type doesn't give one. Default 24000 (OpenAI's pcm). */
  defaultRate?: number;
  /** A fetch that can stream the response body (expo/fetch in Expo) starts playing sooner. */
  fetchImpl?: typeof fetch;
  /** Called when the hosted voice fails and the device voice speaks instead. */
  onError?: (error: Error) => void;
}

const RATE = 24000;
const value = <T>(v: T | (() => T)) => (typeof v === 'function' ? (v as () => T)() : v);

/** Strips things that sound bad when read aloud (markdown, ids in brackets). */
const speakable = (text: string) =>
  text
    .replace(/\[[a-z0-9_]+\]/gi, '')
    .replace(/[*_#`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Little-endian PCM16 bytes to floats. */
function bytesToFloat(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const s = bytes[2 * i] | (bytes[2 * i + 1] << 8);
    out[i] = (s >= 0x8000 ? s - 0x10000 : s) / 0x8000;
  }
  return out;
}

/**
 * Speaks answers with a hosted text-to-speech model instead of the device voice, keeping the
 * device voice for listening (and as the fallback when the hosted one fails). Audio streams to the
 * speaker as it arrives when `fetchImpl` can stream; cutting an answer off reports how much of it
 * was heard, so the model knows.
 */
export function withHostedSpeech(voice: VoiceIO, opts: HostedSpeechOptions): VoiceIO {
  const doFetch = opts.fetchImpl ?? fetch;
  const levelListeners = new Set<(level: number) => void>();

  const speak = async (text: string, signal: AbortSignal): Promise<void | SpeakResult> => {
    const say = speakable(text);
    if (signal.aborted || !say) return;
    let res: Response;
    try {
      res = await doFetch(opts.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        body: JSON.stringify({ model: value(opts.model), input: say, voice: value(opts.voice), response_format: 'pcm' }),
        signal,
      });
      if (!res.ok) throw new Error(`Speech request failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      if (signal.aborted) return { spokenChars: 0 };
      opts.onError?.(e as Error);
      return voice.speak(text, signal);
    }
    const rate = Number(/rate=(\d+)/.exec(res.headers.get('content-type') ?? '')?.[1]) || opts.defaultRate || RATE;

    let startedAt = 0;
    let queuedMs = 0;
    let complete = false;
    let carry: Uint8Array | null = null; // an odd trailing byte, completed by the next chunk
    const timers: ReturnType<typeof setTimeout>[] = [];
    const play = (chunk: Uint8Array) => {
      let bytes = chunk;
      if (carry) {
        bytes = new Uint8Array(carry.length + chunk.length);
        bytes.set(carry);
        bytes.set(chunk, carry.length);
        carry = null;
      }
      if (bytes.length % 2) {
        carry = bytes.slice(-1);
        bytes = bytes.subarray(0, -1);
      }
      if (!bytes.length || signal.aborted) return;
      const pcm = floatToPcm16Base64(resample(bytesToFloat(bytes), rate, RATE));
      opts.audio.play(pcm);
      if (!startedAt) startedAt = Date.now();
      // Report loudness when this chunk is heard, not when it arrived.
      if (levelListeners.size) {
        const level = pcmLevel(pcm);
        const at = startedAt + queuedMs - Date.now();
        timers.push(setTimeout(() => levelListeners.forEach(l => l(level)), Math.max(0, at)));
      }
      queuedMs += (bytes.length / 2 / rate) * 1000;
    };
    const heard = (): SpeakResult => {
      const playedMs = startedAt ? Date.now() - startedAt : 0;
      // Until the whole answer has arrived its length is a guess (about 60 ms per character).
      const totalMs = complete ? queuedMs : Math.max(queuedMs, say.length * 60);
      return { spokenChars: Math.round(text.length * Math.min(1, playedMs / Math.max(1, totalMs))) };
    };

    const aborted = new Promise<'aborted'>(resolve => signal.addEventListener('abort', () => resolve('aborted'), { once: true }));
    try {
      const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
      if (reader) {
        for (;;) {
          const next = await Promise.race([reader.read(), aborted]);
          if (next === 'aborted') {
            void reader.cancel().catch(() => {});
            break;
          }
          if (next.done) break;
          play(next.value);
        }
      } else {
        const whole = await Promise.race([res.arrayBuffer(), aborted]);
        if (whole !== 'aborted') play(new Uint8Array(whole));
      }
      complete = !signal.aborted;
      if (!signal.aborted) await Promise.race([opts.audio.drained(), aborted]);
    } catch (e) {
      if (!signal.aborted) throw e;
    } finally {
      if (signal.aborted) {
        opts.audio.flush();
        timers.forEach(clearTimeout);
        levelListeners.forEach(l => l(0));
      }
    }
    return signal.aborted ? heard() : undefined;
  };

  return {
    ...voice,
    speak,
    onSpeakingLevel(listener) {
      levelListeners.add(listener);
      return () => levelListeners.delete(listener);
    },
  };
}
