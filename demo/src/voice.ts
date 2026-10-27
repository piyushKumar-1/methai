// On-device speech: expo-speech-recognition (speech-to-text) + expo-speech (text-to-speech).
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { Platform } from 'react-native';
import type { VoiceIO } from 'react-native-screen-context';

export interface RankedVoice extends Speech.Voice {
  /** 3 premium / neural, 2 enhanced / network, 1 standard. */
  tier: number;
}

// iOS novelty voices (Bells, Zarvox…) and the old Eloquence voices sound robotic.
const NOVELTY = /speech\.synthesis\.voice|eloquence/i;

function tierOf(v: Speech.Voice): number {
  const id = v.identifier.toLowerCase();
  if (id.includes('premium') || id.includes('neural')) return 3;
  if (id.includes('enhanced') || id.includes('network') || v.quality === Speech.VoiceQuality.Enhanced) return 2;
  return 1;
}

/** Voices for `lang` (and the same base language), best first. */
export async function rankedVoices(lang = 'en-US'): Promise<RankedVoice[]> {
  const base = lang.split('-')[0].toLowerCase();
  const all = await Speech.getAvailableVoicesAsync();
  return all
    .filter(v => v.language?.toLowerCase().startsWith(base) && !NOVELTY.test(v.identifier))
    .map(v => ({ ...v, tier: tierOf(v) }))
    .sort((a, b) => b.tier - a.tier || Number(b.language === lang) - Number(a.language === lang) || a.name.localeCompare(b.name));
}

/** Strips things that sound bad when read aloud (markdown, ids in brackets). */
const speakable = (text: string) =>
  text
    .replace(/\[[a-z0-9_]+\]/gi, '')
    .replace(/[*_#`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export interface DeviceVoiceOptions {
  lang?: string;
  /** Voice identifier, or a getter (so a settings screen can change it). Default: best installed voice. */
  voice?: string | (() => string | undefined);
  /** 1.0 is normal. Default 1.0 on iOS, 1.05 on Android. */
  rate?: number;
  pitch?: number;
  endOfSpeechMs?: number;
  /** End listening if nothing is said for this long. In a continuous conversation, this ends the session. */
  noSpeechTimeoutMs?: number;
  /**
   * Also record the utterance and hand the audio to the model (HeardSpeech.audio), for models that
   * hear speech (xor-*). The on-device transcript still drives the UI and stop phrases.
   * A getter lets a settings screen switch it.
   */
  sendAudio?: boolean | (() => boolean);
}

/** Reads a local file as base64 (fetch + FileReader work on file:// URIs in React Native). */
async function readBase64(uri: string): Promise<string> {
  const blob = await (await fetch(uri)).blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function deviceVoice({ lang = 'en-US', voice, rate, pitch = 1.0, endOfSpeechMs = 1200, noSpeechTimeoutMs = 10000, sendAudio = false }: DeviceVoiceOptions = {}): VoiceIO {
  let best: Promise<string | undefined> | undefined;
  const speakingListeners = new Set<(level: number) => void>();
  const pickVoice = async () => {
    const chosen = typeof voice === 'function' ? voice() : voice;
    if (chosen) return chosen;
    best ??= rankedVoices(lang).then(v => v[0]?.identifier, () => undefined);
    return best;
  };

  return {
    onSpeakingLevel(listener) {
      speakingListeners.add(listener);
      return () => speakingListeners.delete(listener);
    },

    async speak(text, signal) {
      const say = speakable(text);
      if (signal.aborted || !say) return;
      const identifier = await pickVoice();
      // End of the word being spoken, in `say`; mapped back onto `text` (which may have [ids] stripped).
      let spokenEnd = 0;
      const result = () => ({ spokenChars: Math.round((spokenEnd / say.length) * text.length) });
      return new Promise(resolve => {
        const onAbort = () => {
          void Speech.stop();
          resolve(result());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        const done = () => {
          signal.removeEventListener('abort', onAbort);
          spokenEnd = say.length;
          resolve(result());
        };
        Speech.speak(say, {
          language: lang,
          voice: identifier,
          rate: rate ?? (Platform.OS === 'android' ? 1.05 : 1.0),
          pitch,
          // Own playback session on iOS: full volume on the loudspeaker, not the quiet
          // voice-call route the recognizer's record session would give it.
          useApplicationAudioSession: false,
          // A pulse per spoken word, so the glow moves with the speech.
          onBoundary: (e: { charIndex?: number; charLength?: number } | undefined) => {
            if (e?.charIndex !== undefined) spokenEnd = e.charIndex + (e.charLength ?? 0);
            speakingListeners.forEach(l => l(0.55 + Math.random() * 0.35));
          },
          onDone: done,
          onStopped: done,
          onError: done,
        });
      });
    },

    async listen(signal, onPartial, onLevel, options) {
      // The assistant's word-aware pause (longer after "and…", "um…"), else the fixed one.
      const endOfTurnDelay = options?.endOfTurnDelay ?? (() => endOfSpeechMs);
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) throw new Error('Microphone / speech recognition permission denied');

      const record = typeof sendAudio === 'function' ? sendAudio() : sendAudio;
      const heard = await new Promise<{ transcript: string; uri: string | null }>(resolve => {
        let transcript = '';
        let uri: string | null = null;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const subs: { remove(): void }[] = [];

        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          subs.forEach(s => s.remove());
          signal.removeEventListener('abort', onAbort);
          resolve({ transcript: transcript.trim(), uri });
        };
        // Stop after a pause; the recognizer then emits its final result and `end`.
        const stopAfter = (ms: number) => {
          clearTimeout(timer);
          timer = setTimeout(() => ExpoSpeechRecognitionModule.stop(), ms);
        };
        const onAbort = () => {
          ExpoSpeechRecognitionModule.abort();
          finish();
        };

        subs.push(
          ExpoSpeechRecognitionModule.addListener('result', e => {
            transcript = e.results[0]?.transcript ?? transcript;
            onPartial?.(transcript);
            // When recording, wait for `end`: the file is complete only after `audioend`.
            if (e.isFinal && !record) finish();
            else if (!e.isFinal) stopAfter(endOfTurnDelay(transcript));
          }),
          ExpoSpeechRecognitionModule.addListener('audioend', e => void (uri = e.uri)),
          ExpoSpeechRecognitionModule.addListener('end', finish),
          // Mic loudness: -2 (silence) … 10 (loud).
          ExpoSpeechRecognitionModule.addListener('volumechange', e => onLevel?.(Math.max(0, Math.min(1, (e.value + 2) / 12)) ** 1.3)),
          ExpoSpeechRecognitionModule.addListener('error', finish),
        );
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });

        ExpoSpeechRecognitionModule.start({
          lang,
          interimResults: true,
          continuous: false,
          volumeChangeEventOptions: { enabled: true, intervalMillis: 80 },
          iosCategory: { category: 'playAndRecord', categoryOptions: ['defaultToSpeaker', 'allowBluetooth'], mode: 'default' },
          ...(record && { recordingOptions: { persist: true, outputSampleRate: 16000, outputEncoding: 'pcmFormatInt16' } }),
        });
        stopAfter(noSpeechTimeoutMs);
      });

      // Nothing recognized means nothing was said (or it was cancelled): don't send silence.
      if (!record || !heard.uri || !heard.transcript || signal.aborted) return heard.transcript;
      try {
        return { text: heard.transcript, audio: { data: await readBase64(heard.uri), format: 'wav' } };
      } catch {
        return heard.transcript;
      }
    },
  };
}
