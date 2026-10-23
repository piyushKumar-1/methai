import { Platform } from 'react-native';
import type { HeardSpeech, VoiceIO } from './assistant';
import { toCaptionText } from './captions';
import { isInterruption, isNoSpeechError, isTransientSpeechError, micLevelFromRms, pickBestVoice, speechTimeoutMs, stripEcho, type TtsVoiceInfo } from './speech';

/** Results event from the speech recognizer: best guess first. */
export interface RecognizerResults {
  value?: string[];
}

/**
 * The speech recognizer (speech-to-text) deviceVoice drives; `@react-native-voice/voice`'s default
 * export fits as is. Handlers are assigned, the way that library takes them.
 */
export interface SpeechRecognizerModule {
  start(locale: string, options?: Record<string, unknown>): Promise<unknown>;
  stop(): Promise<unknown>;
  destroy(): Promise<unknown>;
  removeAllListeners(): void;
  onSpeechPartialResults?: (e: RecognizerResults) => void;
  onSpeechResults?: (e: RecognizerResults) => void;
  onSpeechEnd?: (e: any) => void;
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
  /**
   * How long a pause ends the user's turn. Pauses shorter than this never cut them off: if the
   * phone's recognizer stops by itself sooner (Android's often does after about a second), it is
   * restarted and what follows is added on. Default 1300ms.
   */
  endOfSpeechMs?: number;
  /** End a listening turn if nothing is said for this long. Default 8000ms. */
  noSpeechTimeoutMs?: number;
  /** Pause after speaking before the mic opens, so the loudspeaker's tail isn't heard. Default 150ms. */
  micOpenDelayMs?: number;
  /**
   * Listen while speaking and stop talking when the user says "stop", "wait", "hold on", "hey"…;
   * then listen to them afresh. Default true.
   */
  bargeIn?: boolean;
  /** Step-by-step trace (listen started, partials, why it ended, errors), for debugging. */
  log?: (message: string) => void;
}

export interface DeviceVoice extends VoiceIO {
  listen(signal: AbortSignal, onPartial?: (text: string) => void, onLevel?: (level: number) => void): Promise<HeardSpeech>;
  /** Locales that have an installed text-to-speech voice. */
  installedLocales(): Promise<string[]>;
}

// Any of these ends the current utterance.
const TTS_END_EVENTS = ['tts-finish', 'tts-cancel', 'tts-error'];

// A restarted recognizer takes a moment to hear again; allow for it on top of the pause.
const CONTINUE_GRACE_MS = 500;
// Sessions joined into one turn at most, so a noisy room can't keep a turn open forever.
const MAX_PARTS = 6;

const joinWords = (a: string, b: string) => [a.trim(), b.trim()].filter(Boolean).join(' ');

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
  const endOfSpeechMs = opts.endOfSpeechMs ?? 1300;
  const noSpeechTimeoutMs = opts.noSpeechTimeoutMs ?? 8000;
  const micOpenDelayMs = opts.micOpenDelayMs ?? 150;
  const bargeIn = opts.bargeIn ?? true;

  let ttsReady: Promise<boolean> | null = null;
  let preparedLocale: string | undefined;
  // What was last said aloud and when it finished, to strip echo and let the speaker go quiet.
  let lastSpoken = '';
  let spokeUntil = 0;
  // The last turn's stop() + destroy(). A new turn waits for it: destroying late would kill the
  // session that just started ("Connection to speech recognition service lost").
  let teardown: Promise<unknown> = Promise.resolve();

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

  interface Session {
    /** What was heard ('' for silence); rejects on a real recognizer failure. */
    result: Promise<string>;
    /** The recognizer's other guesses for the latest words. */
    alternatives(): string[];
    /** Where partials and mic levels go; can be set while the session runs. */
    attach(onPartial?: (text: string) => void, onLevel?: (level: number) => void): void;
    abort(reason: string): void;
    /** True when the recognizer stopped by itself (its own end of speech, no match…), not on our timer or an abort. */
    endedByRecognizer(): boolean;
    /** When the latest new words arrived (0 if none). */
    lastWordAt(): number;
  }

  /** One recognizer session, started once the previous one has shut down. */
  const startSession = async (
    label: string,
    onWords?: (text: string, session: Session) => void,
    silenceMs = noSpeechTimeoutMs,
  ): Promise<Session> => {
    // A recognizer that died never answers stop/destroy, so don't wait for it forever.
    await Promise.race([teardown, sleep(600)]);
    let transcript = '';
    let others: string[] = [];
    let settled = false;
    let byRecognizer = false;
    let speechEnded = false;
    let wordsAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let partialTo: ((text: string) => void) | undefined;
    let levelTo: ((level: number) => void) | undefined;
    let settle!: { resolve: (text: string) => void; reject: (error: Error) => void };
    const result = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
    const startedAt = Date.now();

    const finish = (error: Error | undefined, reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rec.removeAllListeners();
      log(`${label} ended (${reason}) after ${Date.now() - startedAt}ms: ${error ? `error ${error.message}` : JSON.stringify(transcript)}`);
      // Settle first: a recognizer that died never answers stop/destroy.
      if (error) settle.reject(error);
      else settle.resolve(transcript.trim());
      teardown = rec
        .stop()
        .then(() => rec.destroy())
        .catch(() => {});
    };
    // iOS never reports end of speech on its own, so stop on silence after the last result.
    const stopAfter = (ms: number, reason: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(undefined, reason), ms);
    };
    const recognizerStopped = (error: Error | undefined, reason: string) => {
      if (!settled) byRecognizer = true;
      finish(error, reason);
    };
    const session: Session = {
      result,
      alternatives: () => others,
      attach(onPartial, onLevel) {
        partialTo = onPartial;
        levelTo = onLevel;
        if (transcript) onPartial?.(transcript);
      },
      abort: reason => finish(undefined, reason),
      endedByRecognizer: () => byRecognizer,
      lastWordAt: () => wordsAt,
    };
    const onText = (kind: string) => (e: RecognizerResults) => {
      // Some recognizers send an empty final result after good partials; never let it wipe what
      // was already heard.
      const text = e.value?.find(candidate => candidate.trim().length > 0);
      log(`${kind}: ${JSON.stringify(e.value ?? [])}`);
      if (!text) return;
      if (text !== transcript) wordsAt = Date.now();
      transcript = text;
      others = (e.value ?? []).map(v => v.trim()).filter(v => v && v !== text);
      partialTo?.(transcript);
      onWords?.(transcript, session);
      // Android's final result means its recognizer has stopped (iOS sends "final" results all along).
      if (kind === 'final' && Platform.OS === 'android') recognizerStopped(undefined, 'final result');
      else if (!speechEnded) stopAfter(endOfSpeechMs, `${endOfSpeechMs}ms without new words`);
    };
    rec.onSpeechPartialResults = onText('partial');
    rec.onSpeechResults = onText('final');
    // The recognizer is done once it reports end of speech; its final result follows shortly.
    rec.onSpeechEnd = () => {
      speechEnded = true;
      clearTimeout(timer);
      timer = setTimeout(() => recognizerStopped(undefined, 'speech end'), 300);
    };
    rec.onSpeechVolumeChanged = e => levelTo?.(micLevelFromRms(e.value));
    // "No match" / speech timeout just mean silence; transient errors too (the caller listens
    // again). Only real failures are errors.
    rec.onSpeechError = e => {
      const detail = `recognizer error ${e.error?.code ?? '?'}/${e.error?.message ?? ''}`;
      if (transcript || isNoSpeechError(e.error?.code, e.error?.message) || isTransientSpeechError(e.error?.code)) recognizerStopped(undefined, detail);
      else recognizerStopped(new Error(e.error?.message ?? 'Speech recognition failed'), detail);
    };
    stopAfter(silenceMs, 'nothing said');
    log(`${label} started`);
    // Ask Android's recognizer to allow the same pause we do; engines that ignore this are restarted.
    rec.start(locale(), {
      EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: endOfSpeechMs,
      EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: endOfSpeechMs,
    }).catch((err: unknown) => finish(new Error(String(err)), 'start failed'));
    return session;
  };

  /**
   * Keeps a recognizer running while `spoken` is being said and calls `interrupt` when the user
   * says a stop word. Nothing heard here becomes a request: it is mostly the reply's own echo.
   */
  const watchForInterruption = (spoken: string, interrupt: () => void) => {
    let done = false;
    let current: Session | null = null;
    const loop = (async () => {
      if (opts.requestMicPermission && !(await opts.requestMicPermission())) return;
      while (!done) {
        const session = await startSession('interrupt watch', (text, s) => {
          if (done || !isInterruption(text, spoken)) return;
          done = true;
          log(`interrupted: ${JSON.stringify(text)}`);
          s.abort('interrupted');
          interrupt();
        });
        if (done) {
          session.abort('done speaking');
          return;
        }
        current = session;
        await session.result.catch(() => '');
      }
    })();
    return {
      async stop() {
        done = true;
        current?.abort('done speaking');
        await loop;
      },
    };
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
      let watch: { stop(): Promise<void> } | undefined;
      await new Promise<void>(resolve => {
        const subscriptions = TTS_END_EVENTS.map(event => tts.addListener(event, () => settle()));
        const settle = () => {
          clearTimeout(timeout);
          subscriptions.forEach(s => s.remove());
          signal.removeEventListener('abort', stopSpeaking);
          spokeUntil = Date.now();
          resolve();
        };
        const stopSpeaking = () => {
          void Promise.resolve(tts.stop()).catch(() => {});
          settle();
        };
        signal.addEventListener('abort', stopSpeaking, { once: true });
        // If the engine dies mid-utterance no finish event ever comes; move on instead of hanging.
        const timeout = setTimeout(() => {
          log('TTS finish event never arrived');
          stopSpeaking();
        }, speechTimeoutMs(say));
        const fail = (err: unknown) => {
          log(`TTS speak failed: ${String(err)}`);
          stopSpeaking();
        };
        try {
          // Android returns a promise that rejects, e.g. "Language data is missing".
          Promise.resolve(tts.speak(say)).catch(fail);
        } catch (err) {
          fail(err);
        }
        if (bargeIn) watch = watchForInterruption(say, stopSpeaking);
      });
      await watch?.stop();
    },

    async listen(signal, onPartial, onLevel) {
      if (opts.requestMicPermission && !(await opts.requestMicPermission())) throw new Error('Microphone permission denied');
      // Only right after speaking: between silent listening turns every millisecond the mic is off
      // is a chance to miss a one-word "yes".
      const quietFor = Date.now() - spokeUntil;
      if (quietFor < micOpenDelayMs) await sleep(micOpenDelayMs - quietFor);
      if (signal.aborted) return { text: '' };
      // What earlier recognizer sessions in this turn heard, when the user paused mid-sentence.
      let before = '';
      // The other guesses for the latest words, with what came before them.
      let alternatives: string[] = [];
      let current: Session | null = null;
      const onAbort = () => current?.abort('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        for (let part = 1; ; part++) {
          // A continued session only waits for the rest of the pause before giving up.
          const session = await startSession(part === 1 ? 'listen' : `listen (part ${part})`, undefined, part === 1 ? noSpeechTimeoutMs : endOfSpeechMs + CONTINUE_GRACE_MS);
          current = session;
          if (signal.aborted) session.abort('aborted');
          session.attach(text => onPartial?.(joinWords(before, text)), onLevel);
          // A later part failing must not lose what was already heard.
          const heard = part === 1 ? await session.result : await session.result.catch(() => '');
          if (heard) alternatives = session.alternatives().map(a => joinWords(before, a));
          before = joinWords(before, heard);
          const pausedFor = Date.now() - session.lastWordAt();
          const keepListening =
            heard && !signal.aborted && session.endedByRecognizer() && pausedFor < endOfSpeechMs && part < MAX_PARTS;
          if (keepListening) {
            log(`recognizer stopped ${pausedFor}ms after the last word; still listening`);
            continue;
          }
          const request = stripEcho(before, lastSpoken);
          if (request !== before) log(`echo removed: ${JSON.stringify(before)} → ${JSON.stringify(request)}`);
          const others = request ? alternatives.map(a => stripEcho(a, lastSpoken)).filter(a => a && a !== request) : [];
          return others.length ? { text: request, alternatives: others } : { text: request };
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
