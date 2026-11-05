import type { RealtimeVoiceModel } from './session';
import { voiceAgentModel, type VoiceAgentOptions, type VoiceAgentProtocol } from './voiceAgent';

export interface DeepgramAgentSettings {
  /** Speech recognition. Default `{ type: 'deepgram', model: 'nova-3' }`. */
  listen?: Record<string, unknown>;
  /** The LLM that calls the screen tools. Default `{ type: 'open_ai', model: 'gpt-4o-mini' }` (run by Deepgram). */
  think?: Record<string, unknown>;
  /** The voice. Default `{ type: 'deepgram', model: 'aura-2-thalia-en' }`. */
  speak?: Record<string, unknown>;
  /** e.g. 'en', 'hi'. Default: Deepgram's ('en'). */
  language?: string;
}

/** `connect` returns your relay to wss://agent.deepgram.com/v1/agent/converse that adds `Authorization: Token <key>`. */
export type DeepgramAgentOptions = VoiceAgentOptions & DeepgramAgentSettings;

const RATE = 24000;

/**
 * Deepgram's Voice Agent API: raw PCM both ways as binary frames, the screen tools as client-side
 * functions.
 */
export function deepgramProtocol(settings: DeepgramAgentSettings = {}): VoiceAgentProtocol {
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
            ...(settings.language && { language: settings.language }),
            listen: { provider: settings.listen ?? { type: 'deepgram', model: 'nova-3' } },
            think: {
              provider: settings.think ?? { type: 'open_ai', model: 'gpt-4o-mini' },
              prompt: `${instructions}\n\nCurrent screen:\n${screen}`,
              functions: tools.map(t => ({ name: t.name, description: t.description, parameters: t.schema })),
            },
            speak: { provider: settings.speak ?? { type: 'deepgram', model: 'aura-2-thalia-en' } },
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
  return voiceAgentModel(deepgramProtocol(opts), opts);
}
