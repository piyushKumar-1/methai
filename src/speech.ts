// Pure helpers for on-device speech: choosing a voice, reading recognizer events, cleaning up
// what the mic heard. Used by deviceVoice(); exported for custom VoiceIO adapters.

/** Base language of a BCP-47 / Android locale: "kn-IN" → "kn", "en_US" → "en". */
export function baseLanguage(locale: string): string {
  return locale.split(/[-_]/)[0]?.toLowerCase() ?? '';
}

/** True when one of `voiceLocales` speaks the language of `locale` (any region). */
export function canSpeak(locale: string, voiceLocales: readonly string[]): boolean {
  const base = baseLanguage(locale);
  return voiceLocales.some(v => baseLanguage(v) === base);
}

/**
 * True when a speech-recognition error only means the user said nothing: Android
 * ERROR_SPEECH_TIMEOUT (6) / ERROR_NO_MATCH (7), iOS kAFAssistantErrorDomain 1110 "No speech detected".
 */
export function isNoSpeechError(code: string | null | undefined, message: string | null | undefined): boolean {
  return code === '6' || code === '7' || /^1110\//.test(message ?? '');
}

/**
 * True for recognizer errors that go away on a retry: Android ERROR_CLIENT (5), ERROR_RECOGNIZER_BUSY
 * (8) and ERROR_SERVER_DISCONNECTED (11), which show up when a new session starts while the last
 * one is still shutting down.
 */
export function isTransientSpeechError(code: string | null | undefined): boolean {
  return code === '5' || code === '8' || code === '11';
}

/**
 * Upper bound for speaking `text` aloud, so a TTS engine that dies mid-utterance (and never sends
 * its finish event) can't stall the conversation. Generous on purpose (8 characters a second plus
 * slack, capped): it only matters when the engine dies, and a tight one cuts off long replies, e.g.
 * a fare list read with "rupees" after every number.
 */
export function speechTimeoutMs(text: string): number {
  return Math.min(4000 + Math.ceil(text.length / 8) * 1000, 45000);
}

/**
 * Mic loudness (0–1) from a recognizer volume event. Android reports RMS dB roughly in -2..10
 * (silence ≈ 0); iOS reports 0..~10. Clamped, with silence near 0.
 */
export function micLevelFromRms(rmsDb: number | null | undefined): number {
  if (rmsDb === null || rmsDb === undefined || Number.isNaN(rmsDb)) return 0;
  return Math.min(1, Math.max(0, rmsDb / 10));
}

/** A text-to-speech voice as react-native-tts lists it. */
export interface TtsVoiceInfo {
  id: string;
  language: string;
  /** Android: 100 (very low) … 500 (very high). iOS: 300 default, 500 enhanced. */
  quality: number;
  /** Android: 100 (very low) … 500 (very high); iOS reports 0. */
  latency: number;
  networkConnectionRequired: boolean;
  notInstalled: boolean;
}

const PREMIUM_VOICE = /premium|enhanced|neural|siri/i;

/**
 * Most natural-sounding installed voice for `locale`: same language required, exact region
 * (en-IN over en-US) preferred, then higher quality. Network voices are allowed but lose a little
 * to an equal local one for their extra latency.
 */
export function pickBestVoice(voices: readonly TtsVoiceInfo[], locale: string): string | undefined {
  const wanted = locale.replace('_', '-').toLowerCase();
  const base = baseLanguage(wanted);
  const score = (voice: TtsVoiceInfo): number =>
    (voice.language.replace('_', '-').toLowerCase() === wanted ? 1000 : 0) +
    voice.quality +
    (PREMIUM_VOICE.test(voice.id) ? 150 : 0) -
    voice.latency / 5 -
    (voice.networkConnectionRequired ? 20 : 0);
  return voices
    .filter(voice => !voice.notInstalled && baseLanguage(voice.language) === base)
    .reduce<TtsVoiceInfo | undefined>((best, voice) => (!best || score(voice) > score(best) ? voice : best), undefined)?.id;
}

const MIN_ECHO_WORDS = 3;

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * Removes the assistant's own words picked up by the mic from the start of what was heard: on a
 * loudspeaker the recognizer can catch the tail of its last reply ("…where would you like to go").
 * Only a leading run of 3+ words that is the *end* of `spoken` counts as echo, so a user who
 * repeats its words ("book it" after "Shall I book it?") is never cut off.
 */
export function stripEcho(heard: string, spoken: string | null | undefined): string {
  const said = words(spoken ?? '');
  const heardWords = words(heard);
  let echoed = 0;
  for (let n = MIN_ECHO_WORDS; n <= Math.min(said.length, heardWords.length); n++) {
    if (said.slice(said.length - n).join(' ') === heardWords.slice(0, n).join(' ')) echoed = n;
  }
  return echoed > 0 ? heardWords.slice(echoed).join(' ') : heard.trim();
}

const INTERRUPT_WORDS = ['stop', 'wait', 'hold', 'hey', 'sorry', 'excuse', 'pause', 'quiet'];

/**
 * Whether `heard`, picked up while the assistant was saying `spoken`, is the user telling it to
 * stop ("stop", "wait", "hold on", "hey"…). Phones don't cancel their own speaker from the mic, so
 * the recognizer hears the reply too, garbled ("Nexus" → "next is called"); new words alone can't
 * tell the user from that echo. An interrupting word that sounds like none of the reply's words can.
 */
export function isInterruption(heard: string, spoken: string): boolean {
  const said = words(spoken);
  const soundsSaid = (w: string) => said.some(s => s.startsWith(w) || w.startsWith(s));
  return words(heard).some(w => INTERRUPT_WORDS.includes(w) && !soundsSaid(w));
}
