// Mic streaming + gapless playback at 24 kHz PCM16 with react-native-audio-api.
import { AudioContext, AudioManager, AudioRecorder } from 'react-native-audio-api';
import { floatToPcm16Base64, pcm16Base64ToFloat, resample, type PcmAudioIO } from '../src';

const RATE = 24000;

export function devicePcmAudio(): PcmAudioIO {
  // voiceChat mode turns on the OS echo cancellation, so the mic doesn't hear the model.
  AudioManager.setAudioSessionOptions({ iosCategory: 'playAndRecord', iosMode: 'voiceChat', iosOptions: ['defaultToSpeaker', 'allowBluetoothHFP'] });

  let ctx: AudioContext | null = null;
  let recorder: AudioRecorder | null = null;
  let playHead = 0;
  let playing: { stop(when?: number): void }[] = [];
  const context = () => (ctx ??= new AudioContext({ sampleRate: RATE }));

  return {
    async startCapture(onChunk) {
      if ((await AudioManager.requestRecordingPermissions()) !== 'Granted') throw new Error('Microphone permission denied');
      await AudioManager.setAudioSessionActivity(true);
      recorder = new AudioRecorder();
      // 100 ms chunks; the device may deliver a different rate, so resample to 24 kHz.
      recorder.onAudioReady({ sampleRate: RATE, bufferLength: RATE / 10, channelCount: 1 }, ({ buffer }) => {
        onChunk(floatToPcm16Base64(resample(buffer.getChannelData(0), buffer.sampleRate, RATE)));
      });
      await recorder.start();
    },

    async stopCapture() {
      recorder?.clearOnAudioReady();
      await recorder?.stop();
      recorder = null;
    },

    play(chunk) {
      const c = context();
      const samples = pcm16Base64ToFloat(chunk);
      if (!samples.length) return;
      const buffer = c.createBuffer(1, samples.length, RATE);
      buffer.copyToChannel(samples, 0);
      const source = c.createBufferSource();
      source.buffer = buffer;
      source.connect(c.destination);
      playHead = Math.max(playHead, c.currentTime);
      source.start(playHead);
      playHead += samples.length / RATE;
      playing.push(source);
      source.onEnded = () => {
        playing = playing.filter(s => s !== source);
      };
    },

    flush() {
      for (const s of playing) s.stop();
      playing = [];
      playHead = 0;
    },

    async drained() {
      const c = ctx;
      if (!c) return;
      while (c.currentTime < playHead) await new Promise(r => setTimeout(r, 50));
    },

    async close() {
      this.flush();
      await ctx?.close();
      ctx = null;
      await AudioManager.setAudioSessionActivity(false);
    },
  };
}
