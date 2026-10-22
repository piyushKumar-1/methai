// On-device speech: expo-speech-recognition (speech-to-text) + expo-speech (text-to-speech).
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import type { VoiceIO } from 'react-native-screen-context';

export function deviceVoice({ lang = 'en-US', endOfSpeechMs = 1300, noSpeechTimeoutMs = 7000 } = {}): VoiceIO {
  return {
    speak(text, signal) {
      return new Promise<void>(resolve => {
        if (signal.aborted || !text) return resolve();
        const onAbort = () => {
          void Speech.stop();
          resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        const done = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        Speech.speak(text, { language: lang, onDone: done, onStopped: done, onError: done });
      });
    },

    async listen(signal, onPartial) {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) throw new Error('Microphone / speech recognition permission denied');

      return new Promise<string>(resolve => {
        let transcript = '';
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const subs: { remove(): void }[] = [];

        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          subs.forEach(s => s.remove());
          signal.removeEventListener('abort', onAbort);
          resolve(transcript.trim());
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
            if (e.isFinal) finish();
            else stopAfter(endOfSpeechMs);
          }),
          ExpoSpeechRecognitionModule.addListener('end', finish),
          ExpoSpeechRecognitionModule.addListener('error', finish),
        );
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });

        ExpoSpeechRecognitionModule.start({
          lang,
          interimResults: true,
          continuous: false,
          // Speaker output stays on the loudspeaker for the spoken reply afterwards.
          iosCategory: { category: 'playAndRecord', categoryOptions: ['defaultToSpeaker', 'allowBluetooth'], mode: 'default' },
        });
        stopAfter(noSpeechTimeoutMs);
      });
    },
  };
}
