// The assistant's remote configuration: plain JSON, edited in the methai dashboard and loaded at
// start-up with methai.init(). Everything that needs code (audio, the phone's voice, user context)
// stays in the app; this is everything that doesn't. No runtime imports: the dashboard server
// imports this file to validate what it publishes.
import type { AppContext } from './llm';

export const METHAI_CONFIG_VERSION = 1;

/** A chat-completions model (OpenAI-compatible), usually behind your relay. */
export interface ChatModelConfig {
  endpoint: string;
  model: string;
  /** Tried in order when the model is rate-limited, down or slow. */
  fallbackModels?: string[];
  /** Per-model time limit before trying the next one. */
  attemptTimeoutMs?: number;
  /** How long a failed model is skipped. */
  cooldownMs?: number;
  /** Extra fields for every request (temperature…). */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Time limit for a whole model call. */
  timeoutMs?: number;
}

/** A hosted voice for the answers (OpenAI-compatible /audio/speech, e.g. your relay to OpenRouter or Sarvam). */
export interface HostedSpeechConfig {
  endpoint: string;
  model: string;
  voice?: string;
  /** Default: the app's language. */
  language?: string;
}

/** How the assistant listens, thinks and talks. */
export type VoiceConfig =
  /** The phone's speech recognition, a chat model, and the phone's voice (or `speech`). */
  | { type: 'device'; model: ChatModelConfig; speech?: HostedSpeechConfig }
  /** Deepgram Voice Agent through `url` (a relay that adds the key). */
  | { type: 'deepgram'; url: string; language?: string; listen?: Record<string, unknown>; think?: Record<string, unknown>; speak?: Record<string, unknown> }
  /** An ElevenLabs agent: `url` returns { signed_url }; `captionsUrl` returns { url } for live captions. */
  | { type: 'elevenlabs'; url: string; captionsUrl?: string; voiceId?: string; language?: string }
  /** OpenAI Realtime (or LiteLLM's /v1/realtime) at `url`. */
  | { type: 'openai-realtime'; url: string; voice?: string; turnDetection?: 'semantic' | 'server'; eagerness?: 'low' | 'medium' | 'high' | 'auto' };

export interface AssistantBehaviourConfig {
  /** The opening line; null lets the model open from the screen. */
  greeting?: string | null;
  /** Opening lines by language ('hi', 'kn', …), over `greeting`. */
  greetings?: Record<string, string>;
  farewell?: string;
  noInputReply?: string;
  errorReply?: string;
  conversation?: 'continuous' | 'single';
  endOnSilence?: boolean;
  stopPhrases?: string[];
  speakProgress?: boolean;
  /** 'smart' (talk over it to stop it), 'off' (take turns), 'raw'. The default the user can change. */
  voiceInterruptions?: 'smart' | 'off' | 'raw';
  resumeWithinMs?: number;
  maxSteps?: number;
  maxTurns?: number;
  noSpeechTimeoutMs?: number;
  followUpTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Replaces the built-in agent rules (the app context is still appended). */
  systemPrompt?: string;
}

/** Controls that need the user's yes first: by element id, or a pattern (case-insensitive regex) on the label. */
export interface ConfirmConfig {
  ids?: string[];
  labelPatterns?: string[];
}

export interface MethaiConfig {
  version: typeof METHAI_CONFIG_VERSION;
  /** False turns the assistant off (a remote kill switch). Default true. */
  enabled?: boolean;
  voice?: VoiceConfig;
  assistant?: AssistantBehaviourConfig;
  confirm?: ConfirmConfig;
  app?: AppContext;
  /** Anything else the app wants to read (feature flags…). */
  extra?: Record<string, unknown>;
}

export type ConfigValidation = { ok: true; config: MethaiConfig } | { ok: false; errors: string[] };

type Check = (value: unknown, path: string, errors: string[]) => void;

const kind = (v: unknown) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
const is =
  (type: 'string' | 'number' | 'boolean' | 'object'): Check =>
  (v, path, errors) => {
    if (v !== undefined && kind(v) !== type) errors.push(`${path} should be a ${type}, not ${kind(v)}`);
  };
const oneOf =
  (...values: string[]): Check =>
  (v, path, errors) => {
    if (v !== undefined && !values.includes(v as string)) errors.push(`${path} should be one of ${values.join(', ')}`);
  };
const stringList: Check = (v, path, errors) => {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.some(s => typeof s !== 'string')) errors.push(`${path} should be a list of strings`);
};
const stringMap: Check = (v, path, errors) => {
  if (v === undefined) return;
  if (kind(v) !== 'object' || Object.values(v as object).some(s => typeof s !== 'string')) errors.push(`${path} should map names to strings`);
};
const required =
  (check: Check): Check =>
  (v, path, errors) => {
    if (v === undefined || v === '') errors.push(`${path} is required`);
    else check(v, path, errors);
  };
const shape =
  (fields: Record<string, Check>): Check =>
  (v, path, errors) => {
    if (v === undefined) return;
    if (kind(v) !== 'object') return void errors.push(`${path} should be an object`);
    for (const [key, check] of Object.entries(fields)) check((v as any)[key], `${path}.${key}`, errors);
  };
const regexList: Check = (v, path, errors) => {
  stringList(v, path, errors);
  if (!Array.isArray(v)) return;
  v.forEach((p, i) => {
    try {
      new RegExp(p, 'i');
    } catch {
      errors.push(`${path}[${i}] is not a valid pattern: ${p}`);
    }
  });
};

const chatModel = shape({
  endpoint: required(is('string')),
  model: required(is('string')),
  fallbackModels: stringList,
  attemptTimeoutMs: is('number'),
  cooldownMs: is('number'),
  extraBody: is('object'),
  headers: stringMap,
  timeoutMs: is('number'),
});

const voiceChecks: Record<string, Record<string, Check>> = {
  device: { model: required(chatModel), speech: shape({ endpoint: required(is('string')), model: required(is('string')), voice: is('string'), language: is('string') }) },
  deepgram: { url: required(is('string')), language: is('string'), listen: is('object'), think: is('object'), speak: is('object') },
  elevenlabs: { url: required(is('string')), captionsUrl: is('string'), voiceId: is('string'), language: is('string') },
  'openai-realtime': { url: required(is('string')), voice: is('string'), turnDetection: oneOf('semantic', 'server'), eagerness: oneOf('low', 'medium', 'high', 'auto') },
};

const voice: Check = (v, path, errors) => {
  if (v === undefined) return;
  const type = (v as any)?.type;
  if (!voiceChecks[type]) return void errors.push(`${path}.type should be one of ${Object.keys(voiceChecks).join(', ')}`);
  shape(voiceChecks[type])(v, path, errors);
};

const assistant = shape({
  greeting: (v, path, errors) => v !== null && is('string')(v, path, errors),
  greetings: stringMap,
  farewell: is('string'),
  noInputReply: is('string'),
  errorReply: is('string'),
  conversation: oneOf('continuous', 'single'),
  endOnSilence: is('boolean'),
  stopPhrases: stringList,
  speakProgress: is('boolean'),
  voiceInterruptions: oneOf('smart', 'off', 'raw'),
  resumeWithinMs: is('number'),
  maxSteps: is('number'),
  maxTurns: is('number'),
  noSpeechTimeoutMs: is('number'),
  followUpTimeoutMs: is('number'),
  idleTimeoutMs: is('number'),
  systemPrompt: is('string'),
});

const app = shape({
  name: is('string'),
  description: is('string'),
  instructions: is('string'),
  screens: (v, path, errors) => {
    if (v === undefined) return;
    if (!Array.isArray(v)) return void errors.push(`${path} should be a list`);
    v.forEach((s, i) => shape({ name: required(is('string')), description: is('string'), howToReach: is('string') })(s, `${path}[${i}]`, errors));
  },
  flows: (v, path, errors) => {
    if (v === undefined) return;
    if (!Array.isArray(v)) return void errors.push(`${path} should be a list`);
    v.forEach((f, i) => shape({ name: required(is('string')), steps: required(is('string')) })(f, `${path}[${i}]`, errors));
  },
});

/** Checks a config before it is used (or published). Unknown fields are allowed, for newer configs. */
export function validateMethaiConfig(value: unknown): ConfigValidation {
  const errors: string[] = [];
  if (kind(value) !== 'object') return { ok: false, errors: ['the config should be a JSON object'] };
  const v = value as any;
  if (v.version !== METHAI_CONFIG_VERSION) errors.push(`version should be ${METHAI_CONFIG_VERSION}`);
  is('boolean')(v.enabled, 'enabled', errors);
  voice(v.voice, 'voice', errors);
  assistant(v.assistant, 'assistant', errors);
  shape({ ids: stringList, labelPatterns: regexList })(v.confirm, 'confirm', errors);
  app(v.app, 'app', errors);
  is('object')(v.extra, 'extra', errors);
  return errors.length ? { ok: false, errors } : { ok: true, config: v as MethaiConfig };
}
