import type { ListenOptions, VoiceIO } from './assistant';
import { base64ToBytes, bytesToBase64, floatToPcm16Base64, pcm16Base64ToFloat, pcmLevel, resample } from './pcm';
import type { PcmAudioIO } from './realtime';

export interface HostedListeningOptions {
  /**
   * POST endpoint, usually your relay (it adds the key): gets JSON `{ model, audio, language }`
   * with `audio` a base64 16 kHz mono WAV, and answers `{ text, language? }`. The demo server's
   * /transcribe forwards it to Sarvam's speech-to-text (saaras / saarika: Indian languages and
   * Hindi-English mixed speech).
   */
  endpoint: string;
  /** e.g. 'saaras:v3'. A getter lets a settings screen switch it. */
  model: string | (() => string);
  /** BCP-47 ('hi-IN'), or 'unknown' / undefined to let the service detect it. */
  language?: string | (() => string | undefined);
  headers?: Record<string, string>;
  /** The mic (24 kHz PCM16 chunks), e.g. the PcmAudioIO used for realtime voice. */
  audio: PcmAudioIO;
  fetchImpl?: typeof fetch;
  /** Called when hosted listening fails and the device recognizer listens instead. */
  onError?: (error: Error) => void;
  /** Turn-by-turn tracing: when speech started and ended, upload size and time. */
  log?: (message: string) => void;
  /** Quiet after the user has spoken that ends their turn. Default 900 ms. */
  endSilenceMs?: number;
  /** Nothing said in this long: the turn ends with ''. Default 8000 ms. */
  noSpeechMs?: number;
  /** The longest turn (Sarvam's synchronous API takes up to 30 s). Default 20000 ms. */
  maxTurnMs?: number;
}

const MIC_RATE = 24000; // PcmAudioIO's rate
const UPLOAD_RATE = 16000; // what speech-to-text wants; a third smaller than 24 kHz
/** Loudness (pcmLevel) that is always speech, and how far above the room's noise a chunk must be. */
const MIN_SPEECH_LEVEL = 0.18;
const ABOVE_NOISE = 1.8;
const MAX_START_NOISE = 0.35;
/** Loud for this much in a row (chunks are ~100 ms) before it counts as the user talking. */
const SPEECH_START_MS = 200;
/** Audio kept from just before speech was detected, so the first syllable isn't clipped. */
const PRE_ROLL_MS = 400;

const value = <T>(v: T | (() => T)) => (typeof v === 'function' ? (v as () => T)() : v);

/** 16-bit mono PCM samples in a WAV container. */
export function pcm16ToWav(samples: Float32Array, rate: number): Uint8Array {
  const data = base64ToBytes(floatToPcm16Base64(samples));
  const out = new Uint8Array(44 + data.length);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + data.length, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

/**
 * Tells the user's speech from the room's noise, chunk by chunk, and says when their turn is over:
 * after `endSilenceMs` of quiet once they've spoken, after `noSpeechMs` if they never do, or at
 * `maxTurnMs`. The noise floor is learned while they're quiet, so a noisy street doesn't count as talking.
 */
export function speechEndpointer(opts: { endSilenceMs: number; noSpeechMs: number; maxTurnMs: number }) {
  let noise = 0;
  let elapsed = 0;
  let loudFor = 0;
  let quietFor = 0;
  let speaking = false;
  return {
    get speaking() {
      return speaking;
    },
    /** Feeds one chunk; returns why the turn is over, or null to keep listening. */
    push(level: number, ms: number): 'end of speech' | 'no speech' | 'too long' | null {
      elapsed += ms;
      // The mic's first moment is the room before anyone talks (capped: they may already be talking).
      if (noise === 0) noise = Math.min(level, MAX_START_NOISE);
      const loud = level >= Math.max(MIN_SPEECH_LEVEL, noise * ABOVE_NOISE);
      if (loud) {
        loudFor += ms;
        quietFor = 0;
        if (loudFor >= SPEECH_START_MS) speaking = true;
      } else {
        loudFor = 0;
        quietFor += ms;
        // Follows the noise down quickly and up slowly, so speech doesn't raise it.
        noise = level < noise ? noise * 0.7 + level * 0.3 : noise * 0.95 + level * 0.05;
      }
      if (speaking && quietFor >= opts.endSilenceMs) return 'end of speech';
      if (!speaking && elapsed >= opts.noSpeechMs) return 'no speech';
      if (elapsed >= opts.maxTurnMs) return 'too long';
      return null;
    },
  };
}

/**
 * Listens with a hosted speech-to-text service instead of the device recognizer: records the mic
 * (`audio`), ends the turn when the user stops talking, and sends the recording to `endpoint`. The
 * rest of `voice` (speaking, warm-up) is kept, and the device recognizer listens instead when the
 * service fails. No live captions: the words arrive once the user has finished.
 */
export function withHostedListening(voice: VoiceIO, opts: HostedListeningOptions): VoiceIO {
  const doFetch = opts.fetchImpl ?? fetch;
  const endpointing = { endSilenceMs: opts.endSilenceMs ?? 900, noSpeechMs: opts.noSpeechMs ?? 8000, maxTurnMs: opts.maxTurnMs ?? 20000 };

  /** Records one turn; resolves with its audio (empty when nothing was said or it was cut off). */
  const record = (signal: AbortSignal, onLevel?: (level: number) => void) =>
    new Promise<{ chunks: string[]; why: string }>((resolve, reject) => {
      const endpointer = speechEndpointer(endpointing);
      const chunks: string[] = [];
      let preRollMs = 0;
      let done = false;
      const finish = (why: string) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        onLevel?.(0);
        opts.audio.stopCapture().then(
          () => resolve({ chunks: endpointer.speaking && !signal.aborted ? chunks : [], why }),
          () => resolve({ chunks: endpointer.speaking && !signal.aborted ? chunks : [], why }),
        );
      };
      const onAbort = () => finish('aborted');
      if (signal.aborted) return resolve({ chunks: [], why: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
      opts.audio
        .startCapture(chunk => {
          if (done) return;
          const ms = ((chunk.length * 3) / 4 / 2 / MIC_RATE) * 1000;
          const level = pcmLevel(chunk);
          onLevel?.(level);
          chunks.push(chunk);
          // Before the user starts, keep only the last moment (the start of their first word).
          if (!endpointer.speaking) {
            preRollMs += ms;
            while (preRollMs > PRE_ROLL_MS && chunks.length > 1) {
              preRollMs -= ((chunks[0].length * 3) / 4 / 2 / MIC_RATE) * 1000;
              chunks.shift();
            }
          }
          const why = endpointer.push(level, ms);
          if (why) finish(why);
        })
        .catch(e => {
          done = true;
          signal.removeEventListener('abort', onAbort);
          reject(e);
        });
    });

  const transcribe = async (chunks: string[], signal: AbortSignal): Promise<string> => {
    const parts = chunks.map(pcm16Base64ToFloat);
    const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((at, p) => (all.set(p, at), at + p.length), 0);
    const wav = pcm16ToWav(resample(all, MIC_RATE, UPLOAD_RATE), UPLOAD_RATE);
    const started = Date.now();
    const language = opts.language ? value(opts.language) : undefined;
    const res = await doFetch(opts.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: JSON.stringify({ model: value(opts.model), audio: bytesToBase64(wav), ...(language && { language }) }),
      signal,
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Transcription failed: HTTP ${res.status} ${body?.error?.message ?? ''}`.trim());
    const text = String(body.text ?? body.transcript ?? '').trim();
    opts.log?.(`transcribed ${Math.round(all.length / MIC_RATE * 10) / 10}s of speech in ${Date.now() - started}ms: ${JSON.stringify(text)}`);
    return text;
  };

  const listen = async (signal: AbortSignal, onPartial?: (text: string) => void, onLevel?: (level: number) => void, options?: ListenOptions) => {
    let recorded: { chunks: string[]; why: string };
    try {
      recorded = await record(signal, onLevel);
    } catch (e) {
      if (signal.aborted) return '';
      opts.onError?.(e as Error);
      return voice.listen(signal, onPartial, onLevel, options);
    }
    opts.log?.(`listen ended (${recorded.why})${recorded.chunks.length ? '' : ', nothing said'}`);
    if (!recorded.chunks.length || signal.aborted) return '';
    try {
      const text = await transcribe(recorded.chunks, signal);
      if (text) onPartial?.(text);
      return text;
    } catch (e) {
      if (signal.aborted) return '';
      // Counts as not heard: the assistant asks again.
      opts.onError?.(e as Error);
      return '';
    }
  };

  return { ...voice, listen };
}
