import { Platform } from 'react-native';
import type { VoiceIO } from './assistant';
import { toCaptionText } from './captions';
import { isNoSpeechError, micLevelFromRms, pickBestVoice, speechTimeoutMs, stripEcho, type TtsVoiceInfo } from './speech';

/** Results event from the speech recognizer: best guess first. */
export interface RecognizerResults {
  value?: string[];
}

/**
 * The speech recognizer (speech-to-text) deviceVoice drives; `@react-native-voice/voice`'s default
 * export fits as is. Handlers are assigned, the way that library takes them.
 */
export interface SpeechRecognizerModule {
  start(locale: string, options?: Record<string, unknown>): Promise<void>;
  stop(): Promise<unknown>;
  destroy(): Promise<unknown>;
  removeAllListeners(): void;
  onSpeechPartialResults?: (e: RecognizerResults) => void;
  onSpeechResults?: (e: RecognizerResults) => void;
  onSpeechEnd?: (e: unknown) => void;
  onSpeechError?: (e: { error?: { code?: string; message?: string } }) => void;
  onSpeechVolumeChanged?: (e: { value?: number }) => void;
}

/** The text-to-speech engine deviceVoice drives; `react-native-tts`'s default export fits as is. */
export interface TextToSpeechModule {
  getInitStatus(): Promise<unknown>;
  setDucking?(enabled: boolean): Promise<unknown>;
  setIgnoreSilentSwitch?(value: 'ignore'): Promise<unknown>;
  setDefaultRate(rate: number, skipTransform?: boolean): Promise<unknown>;
  setDefaultLanguage(language: string): Promise<unknown>;
  setDefaultVoice(voiceId: string): Promise<unknown>;
  voices(): Promise<TtsVoiceInfo[]>;
  speak(text: string): unknown;
  stop(): Promise<unknown> | unknown;
  addListener(event: string, handler: (...args: any[]) => void): { remove(): void };
}

export interface DeviceVoiceOptions {
  /** e.g. `import Voice from '@react-native-voice/voice'`. */
  recognizer: SpeechRecognizerModule;
  /** e.g. `import Tts from 'react-native-tts'`. */
  tts: TextToSpeechModule;
  /** BCP-47 locale, read on every turn so it can follow the app language. */
  locale: () => string;
  /** Asks for the microphone; resolve false when denied. Default: assume granted. */
  requestMicPermission?: () => Promise<boolean>;
  /** Turns a reply into what is read aloud (e.g. "₹120" → "120 rupees"). Default: drops ids, markdown and emoji. */
  speakable?: (text: string) => string;
  /** Speaking rate: Android multiplier (1 = normal), iOS AVSpeech scale (0.5 = normal). Default 1.08 / 0.53. */
  rate?: number;
  /** Stop listening this long after the last new word. Default 900ms. */
  endOfSpeechMs?: number;
  /** End a listening turn if nothing is said for this long. Default 8000ms. */
  noSpeechTimeoutMs?: number;
  /** Pause after speaking before the mic opens, so the loudspeaker's tail isn't heard. Default 150ms. */
  micOpenDelayMs?: number;
  /** Step-by-step trace (listen started, partials, why it ended, errors), for debugging. */
  log?: (message: string) => void;
}

export interface DeviceVoice extends VoiceIO {
  /** Locales that have an installed text-to-speech voice. */
  installedLocales(): Promise<string[]>;
}

// Any of these ends the current utterance.
const TTS_END_EVENTS = ['tts-finish', 'tts-cancel', 'tts-error'];

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * VoiceIO on the phone's own speech engines: a speech recognizer for listening and a TTS engine for
 * speaking, passed in so the library has no native dependencies. It picks the most natural
 * installed voice, removes the assistant's own words if the mic hears them, reports mic loudness,
 * and never hangs on an engine that dies mid-utterance.
 *
 * ```ts
 * import Voice from '@react-native-voice/voice';
 * import Tts from 'react-native-tts';
 * const voice = deviceVoice({ recognizer: Voice, tts: Tts, locale: () => 'en-IN' });
 * ```
 */
export function deviceVoice(opts: DeviceVoiceOptions): DeviceVoice {
  const { recognizer: rec, tts, locale, log = () => {} } = opts;
  const speakable = opts.speakable ?? toCaptionText;
  const endOfSpeechMs = opts.endOfSpeechMs ?? 900;
  const noSpeechTimeoutMs = opts.noSpeechTimeoutMs ?? 8000;
  const micOpenDelayMs = opts.micOpenDelayMs ?? 150;

  let ttsReady: Promise<boolean> | null = null;
  let preparedLocale: string | undefined;
  // What was last said aloud and when it finished, to strip echo and let the speaker go quiet.
  let lastSpoken = '';
  let spokeUntil = 0;

  // Android TTS binds to an engine asynchronously; speaking before that fails with not_ready.
  const ensureTts = (): Promise<boolean> =>
    (ttsReady ??= tts
      .getInitStatus()
      .then(async () => {
        await tts.setDucking?.(true);
        if (Platform.OS === 'ios') await tts.setIgnoreSilentSwitch?.('ignore');
        const rate = opts.rate ?? (Platform.OS === 'android' ? 1.08 : 0.53);
        await (Platform.OS === 'android' ? tts.setDefaultRate(rate, true) : tts.setDefaultRate(rate));
        return true;
      })
      .catch((err: unknown) => {
        ttsReady = null;
        log(`TTS unavailable: ${String(err)}`);
        return false;
      }));

  // The engine default is often a robotic compact voice; switch to the most natural one installed.
  const prepareVoice = async (wanted: string) => {
    if (preparedLocale === wanted) return;
    preparedLocale = wanted;
    await Promise.resolve(tts.setDefaultLanguage(wanted)).catch(() => {});
    try {
      const best = pickBestVoice(await tts.voices(), wanted);
      if (best) await tts.setDefaultVoice(best);
      log(`voice for ${wanted}: ${best ?? 'engine default'}`);
    } catch (err) {
      log(`choosing a voice failed: ${String(err)}`);
    }
  };

  return {
    async installedLocales() {
      if (!(await ensureTts())) return [];
      try {
        return (await tts.voices()).filter(v => !v.notInstalled).map(v => v.language);
      } catch {
        return [];
      }
    },

    async speak(text, signal) {
      const say = speakable(text);
      if (signal.aborted || !say) return;
      lastSpoken = say;
      if (!(await ensureTts())) return;
      await prepareVoice(locale());
      await new Promise<void>(resolve => {
        const subscriptions = TTS_END_EVENTS.map(event => tts.addListener(event, () => settle()));
        const settle = () => {
          clearTimeout(timeout);
          subscriptions.forEach(s => s.remove());
          signal.removeEventListener('abort', onAbort);
          spokeUntil = Date.now();
          resolve();
        };
        const onAbort = () => {
          void Promise.resolve(tts.stop()).catch(() => {});
          settle();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        // If the engine dies mid-utterance no finish event ever comes; move on instead of hanging.
        const timeout = setTimeout(() => {
          log('TTS finish event never arrived');
          onAbort();
        }, speechTimeoutMs(say));
        const fail = (err: unknown) => {
          log(`TTS speak failed: ${String(err)}`);
          onAbort();
        };
        try {
          // Android returns a promise that rejects, e.g. "Language data is missing".
          Promise.resolve(tts.speak(say)).catch(fail);
        } catch (err) {
          fail(err);
        }
      });
    },

    async listen(signal, onPartial, onLevel) {
      if (opts.requestMicPermission && !(await opts.requestMicPermission())) throw new Error('Microphone permission denied');
      // Only right after speaking: between silent listening turns every millisecond the mic is off
      // is a chance to miss a one-word "yes".
      const quietFor = Date.now() - spokeUntil;
      if (quietFor < micOpenDelayMs) await sleep(micOpenDelayMs - quietFor);
      if (signal.aborted) return '';

      const heard = await new Promise<string>((resolve, reject) => {
        let transcript = '';
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const startedAt = Date.now();

        const finish = (error: Error | undefined, reason: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          rec.removeAllListeners();
          log(`listen ended (${reason}) after ${Date.now() - startedAt}ms: ${error ? `error ${error.message}` : JSON.stringify(transcript)}`);
          // Settle first: a recognizer that died never answers stop/destroy, and awaiting them
          // would leave the assistant stuck listening.
          if (error) reject(error);
          else resolve(transcript.trim());
          rec
            .stop()
            .then(() => rec.destroy())
            .catch(() => {});
        };
        // iOS never reports end of speech on its own, so stop on silence after the last result.
        const stopAfter = (ms: number, reason: string) => {
          clearTimeout(timer);
          timer = setTimeout(() => finish(undefined, reason), ms);
        };
        const onAbort = () => finish(undefined, 'aborted');
        const onText = (kind: string) => (e: RecognizerResults) => {
          // Some recognizers send an empty final result after good partials; never let it wipe
          // what was already heard.
          const text = e.value?.find(candidate => candidate.trim().length > 0);
          log(`${kind}: ${JSON.stringify(e.value ?? [])}`);
          if (!text) return;
          transcript = text;
          onPartial?.(transcript);
          stopAfter(endOfSpeechMs, `${endOfSpeechMs}ms without new words`);
        };

        signal.addEventListener('abort', onAbort, { once: true });
        rec.onSpeechPartialResults = onText('partial');
        rec.onSpeechResults = onText('final');
        rec.onSpeechEnd = () => stopAfter(300, 'speech end');
        rec.onSpeechVolumeChanged = e => onLevel?.(micLevelFromRms(e.value));
        // "No match" / speech timeout just mean silence; only real failures are errors.
        rec.onSpeechError = e => {
          const detail = `recognizer error ${e.error?.code ?? '?'}/${e.error?.message ?? ''}`;
          if (transcript || isNoSpeechError(e.error?.code, e.error?.message)) finish(undefined, detail);
          else finish(new Error(e.error?.message ?? 'Speech recognition failed'), detail);
        };
        stopAfter(noSpeechTimeoutMs, 'nothing said');
        log('listen started');
        rec.start(locale()).catch((err: unknown) => finish(new Error(String(err)), 'start failed'));
      });
      const request = stripEcho(heard, lastSpoken);
      if (request !== heard) log(`echo removed: ${JSON.stringify(heard)} → ${JSON.stringify(request)}`);
      return request;
    },
  };
}
