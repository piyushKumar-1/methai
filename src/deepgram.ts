import type { RealtimeVoiceModel } from './session';
import { voiceAgentModel, type VoiceAgentOptions, type VoiceAgentProtocol } from './voiceAgent';

export interface DeepgramAgentSettings {
  /**
   * The conversation's language (BCP-47, e.g. 'en', 'hi', 'kn', 'ta'), or a getter read at the start
   * of each session so it can follow the app's language. It picks the speech recognition and voice
   * unless `listen` / `speak` are given:
   * - English: Flux, which ends turns from what was said, and an Aura-2 voice.
   * - Hindi and the other Flux languages (es, fr, de, ru, pt, ja, it, nl): Flux multilingual, hinted
   *   with the language and English (people mix them).
   * - Other languages Nova-3 knows (Kannada, Tamil, Telugu, Bengali, Marathi, Gujarati, Punjabi…):
   *   Nova-3 in that language.
   * - The voice: Aura-2 for English and Spanish; otherwise ElevenLabs v3 (70+ languages), whose key
   *   your relay adds (see `elevenLabsVoice`).
   */
  language?: string | (() => string | undefined);
  /** Speech recognition, overriding the language's default. */
  listen?: Record<string, unknown>;
  /** The LLM that calls the screen tools. Default `{ type: 'open_ai', model: 'gpt-4o-mini' }` (run by Deepgram). */
  think?: Record<string, unknown>;
  /** The voice (Deepgram speak settings: `{ provider, endpoint? }`), overriding the language's default. */
  speak?: Record<string, unknown>;
}

/** `connect` returns your relay to wss://agent.deepgram.com/v1/agent/converse that adds `Authorization: Token <key>`. */
export type DeepgramAgentOptions = VoiceAgentOptions & DeepgramAgentSettings;

const RATE = 24000;

/** Languages Flux's multilingual model understands (Flux decides from the words when a turn is over). */
const FLUX_MULTI = ['en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl'];
/** Deepgram's own Aura-2 voices, by language. */
const AURA_VOICES: Record<string, string> = { en: 'aura-2-thalia-en', es: 'aura-2-celeste-es' };

const baseLanguage = (code: string) => code.toLowerCase().split(/[-_]/)[0];

/** Speech recognition that fits `language`: Flux where it can, else Nova-3 in that language. */
export function deepgramListen(language = 'en'): Record<string, unknown> {
  const base = baseLanguage(language);
  if (base === 'en') return { type: 'deepgram', version: 'v2', model: 'flux-general-en' };
  if (FLUX_MULTI.includes(base)) return { type: 'deepgram', version: 'v2', model: 'flux-general-multi', language_hints: [base, 'en'] };
  return { type: 'deepgram', model: 'nova-3', language: base };
}

export interface ElevenLabsVoiceOptions {
  /** An ElevenLabs voice id. Default Jessica (cgSgspJ2msm6clMCkdW9), a premade voice every account has. */
  voiceId?: string;
  /**
   * 'eleven_v3' (default): 70+ languages, including Kannada, Telugu, Malayalam, Bengali and Marathi,
   * over HTTPS. 'eleven_turbo_v2_5' / 'eleven_multilingual_v2': faster (streamed), fewer languages
   * (Hindi and Tamil among the Indian ones).
   */
  model?: 'eleven_v3' | 'eleven_turbo_v2_5' | 'eleven_multilingual_v2';
  language?: string;
  /** Usually left empty: your relay adds `xi-api-key`, so the key never ships in the app. */
  headers?: Record<string, string>;
}

/** Deepgram speak settings that use an ElevenLabs voice (Deepgram calls ElevenLabs for the audio). */
export function elevenLabsVoice({ voiceId = 'cgSgspJ2msm6clMCkdW9', model = 'eleven_v3', language, headers = {} }: ElevenLabsVoiceOptions = {}): Record<string, unknown> {
  // v3 isn't available over ElevenLabs' streaming WebSocket.
  const url = model === 'eleven_v3' ? `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}` : `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/multi-stream-input`;
  return { provider: { type: 'eleven_labs', model_id: model, ...(language && { language }) }, endpoint: { url, headers } };
}

/** The voice that fits `language`: Aura-2 where Deepgram has one, else ElevenLabs v3. */
export function deepgramSpeak(language = 'en'): Record<string, unknown> {
  const base = baseLanguage(language);
  return AURA_VOICES[base] ? { provider: { type: 'deepgram', model: AURA_VOICES[base] } } : elevenLabsVoice({ language: base });
}

/**
 * Deepgram's Voice Agent API: raw PCM both ways as binary frames, the screen tools as client-side
 * functions.
 */
export function deepgramProtocol(settings: DeepgramAgentSettings = {}): VoiceAgentProtocol {
  const language = (typeof settings.language === 'function' ? settings.language() : settings.language) || undefined;
  return {
    name: 'Deepgram',
    audioIn: { kind: 'binary' },
    open: {
      afterMessage: msg => msg.type === 'Welcome',
      waitForReady: true,
      messages: ({ greeting, instructions, screen, tools }) => [
        {
          type: 'Settings',
          audio: {
            input: { encoding: 'linear16', sample_rate: RATE },
            output: { encoding: 'linear16', sample_rate: RATE, container: 'none' },
          },
          agent: {
            // The language goes to the recognizer and voice (Deepgram rejects agent.language with Flux).
            listen: { provider: settings.listen ?? deepgramListen(language) },
            think: {
              provider: settings.think ?? { type: 'open_ai', model: 'gpt-4o-mini' },
              prompt: `${instructions}\n\nCurrent screen:\n${screen}`,
              functions: tools.map(t => ({ name: t.name, description: t.description, parameters: t.schema })),
            },
            speak: settings.speak ?? deepgramSpeak(language),
            ...(greeting && { greeting }),
          },
        },
      ],
    },
    parse: msg => {
      switch (msg.type) {
        case 'SettingsApplied':
          return [{ type: 'ready' }];
        case 'ConversationText': {
          const text = String(msg.content ?? '').trim();
          if (!text) return [];
          return [msg.role === 'user' ? { type: 'user-text', text, final: true } : { type: 'agent-text', text }];
        }
        case 'UserStartedSpeaking':
          return [{ type: 'user-speaking' }];
        case 'FunctionCallRequest':
          return [
            {
              type: 'tool-calls',
              // Server-side functions are Deepgram's to run.
              calls: (msg.functions ?? []).filter((f: any) => f.client_side !== false).map((f: any) => ({ id: f.id, name: f.name, args: f.arguments })),
            },
          ];
        case 'AgentAudioDone':
          return [{ type: 'reply-done' }];
        case 'Error':
          return [{ type: 'error', message: msg.description || msg.message || `error ${msg.code ?? ''}`.trim() }];
        default:
          return [];
      }
    },
    toolResult: (call, result) => [{ type: 'FunctionCallResponse', id: call.id, name: call.name, content: result.content }],
    userText: text => [{ type: 'InjectUserMessage', content: text }],
    // Added to the agent's instructions for the rest of the conversation.
    context: text => [{ type: 'UpdatePrompt', prompt: text }],
    keepAlive: { everyMs: 5000, message: () => ({ type: 'KeepAlive' }) },
  };
}

/**
 * A conversation with a Deepgram Voice Agent: the mic streams up and the agent's voice streams
 * back as it is spoken.
 */
export function deepgramAgentModel(opts: DeepgramAgentOptions): RealtimeVoiceModel {
  // A fresh protocol per session, so a `language` getter follows the app's language.
  return voiceAgentModel(() => deepgramProtocol(opts), opts);
}
