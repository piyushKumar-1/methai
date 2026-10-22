// On-device speech: @react-native-voice/voice for speech-to-text, expo-speech for text-to-speech.
// Swap in any other engine (cloud STT/TTS, Whisper, …) by implementing VoiceIO.
import Voice from '@react-native-voice/voice';
import * as Speech from 'expo-speech';
import type { VoiceIO } from '../src';

export interface DeviceVoiceOptions {
  locale?: string;
  /** Stop listening after this much silence once the user has started talking. Default 1200ms. */
  endOfSpeechMs?: number;
  /** Give up if the user says nothing for this long. Default 6000ms. */
  noSpeechTimeoutMs?: number;
}

export function deviceVoice({ locale = 'en-US', endOfSpeechMs = 1200, noSpeechTimeoutMs = 6000 }: DeviceVoiceOptions = {}): VoiceIO {
  return {
    speak(text, signal) {
      return new Promise<void>(resolve => {
        if (signal.aborted) return resolve();
        const onAbort = () => {
          void Speech.stop();
          resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        const done = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        Speech.speak(text, { language: locale, onDone: done, onStopped: done, onError: done });
      });
    },

    listen(signal, onPartial) {
      return new Promise<string>((resolve, reject) => {
        let transcript = '';
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;

        const finish = async (error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          try {
            await Voice.stop();
            await Voice.destroy();
          } catch {}
          Voice.removeAllListeners();
          error ? reject(error) : resolve(transcript);
        };
        // iOS never reports end of speech on its own, so end on silence after the last result.
        const arm = (ms: number) => {
          clearTimeout(timer);
          timer = setTimeout(() => void finish(), ms);
        };
        const onAbort = () => void finish();
        const onText = (e: { value?: string[] }) => {
          transcript = e.value?.[0] ?? transcript;
          onPartial?.(transcript);
          arm(endOfSpeechMs);
        };

        if (signal.aborted) return resolve('');
        signal.addEventListener('abort', onAbort, { once: true });
        Voice.onSpeechPartialResults = onText;
        Voice.onSpeechResults = onText;
        Voice.onSpeechEnd = () => arm(300);
        Voice.onSpeechError = e => (transcript ? void finish() : void finish(new Error(e.error?.message ?? 'Speech recognition failed')));
        arm(noSpeechTimeoutMs);
        Voice.start(locale).catch(finish);
      });
    },
  };
}
