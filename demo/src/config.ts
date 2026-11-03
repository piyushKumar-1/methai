import Constants from 'expo-constants';

// The demo server runs on the same computer as the Metro bundler, so reuse its address.
const metroHost = Constants.expoConfig?.hostUri?.split(':')[0];
export const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL ?? `http://${metroHost ?? 'localhost'}:8787`;

export const CHAT_MODELS = ['open-fast', 'open-large', 'kimi-latest', 'glm-latest'] as const;
/** Take the recorded utterance as input_audio over chat completions (≈1 s per step on the gateway). */
export const CLOUD_VOICE_MODELS = ['xor-latest-custom', 'xor-omni', 'xor-latest'] as const;
/** Speech-to-speech over /v1/realtime (the gateway currently rejects these for the demo key). */
export const REALTIME_MODELS = ['xor-latest-custom', 'xor-omni'] as const;

/** Hosted text-to-speech through the demo server's /speech (OpenRouter). All of these return PCM. */
export const HOSTED_VOICES = [
  { id: 'device', label: 'Device voice' },
  { id: 'eleven', label: 'ElevenLabs Flash · Jessica', model: 'elevenlabs/eleven-flash-v2.5', voice: 'Jessica' },
  { id: 'heygen', label: 'HeyGen Turbo (free) · Nadine', model: 'heygen/heygen-voice-1-turbo:free', voice: 'nadine' },
  { id: 'aura', label: 'Deepgram Aura 2 · Thalia', model: 'deepgram/aura-2', voice: 'aura-2-thalia-en' },
] as const;
export type HostedVoiceId = (typeof HOSTED_VOICES)[number]['id'];
