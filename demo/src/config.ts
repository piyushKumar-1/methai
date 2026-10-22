import Constants from 'expo-constants';

// The demo server runs on the same computer as the Metro bundler, so reuse its address.
const metroHost = Constants.expoConfig?.hostUri?.split(':')[0];
export const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL ?? `http://${metroHost ?? 'localhost'}:8787`;

export const CHAT_MODELS = ['open-fast', 'open-large', 'kimi-latest', 'glm-latest'] as const;
export const REALTIME_MODELS = ['xor-latest-custom', 'xor-omni'] as const;
