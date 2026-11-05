import { SCREEN_TOOLS, type JSONSchemaObject } from './llm';
import type { RealtimeVoiceModel } from './session';
import { voiceAgentModel, type VoiceAgentOptions, type VoiceAgentProtocol } from './voiceAgent';

export interface ElevenLabsAgentSettings {
  /** Override the agent's voice for this app. */
  voiceId?: string;
  /** Language code for speech recognition and the voice, e.g. 'en', 'hi'. Default: the agent's. */
  language?: string;
}

/**
 * `connect` returns the agent's signed URL, fetched by your backend from
 * GET /v1/convai/conversation/get-signed-url?agent_id=… (keeps the API key off the device).
 * For live captions while the user talks (agents only send the words once the turn is over), pass
 * `liveTranscript`: a Scribe realtime URL with a single-use token from POST /v1/single-use-token/realtime_scribe.
 */
export type ElevenLabsAgentOptions = VoiceAgentOptions & ElevenLabsAgentSettings;

/** Audio this long without a new chunk means the agent has finished the current answer. */
const ANSWER_GAP_MS = 400;

/** ElevenLabs accepts a subset of JSON Schema: no additionalProperties, and objects need properties. */
function toElevenLabsSchema(schema: JSONSchemaObject | Record<string, any>): Record<string, any> {
  const { additionalProperties: _drop, ...rest } = schema as Record<string, any>;
  if (rest.type === 'object') {
    const properties = Object.fromEntries(Object.entries(rest.properties ?? {}).map(([k, v]) => [k, toElevenLabsSchema(v as any)]));
    return { ...rest, properties };
  }
  return rest;
}

/**
 * The screen tools as ElevenLabs client tools (POST /v1/convai/tools with { tool_config }), for
 * setting up the agent: scripts/elevenlabs-agent.mjs creates them and the agent in one go. The app
 * runs them when the agent calls them; the agent also needs the built-in end_call system tool.
 */
export function elevenLabsClientTools() {
  return SCREEN_TOOLS.map(t => {
    const parameters = toElevenLabsSchema(t.schema);
    // A free-form object can't be described to ElevenLabs: run_screen_action takes its args as JSON text.
    if (t.name === 'run_screen_action')
      parameters.properties.args = { type: 'string', description: 'Arguments for the action as a JSON object, e.g. {"date": "2026-11-04"}. Omit if it takes none.' };
    return {
      type: 'client' as const,
      name: t.name,
      description: t.description,
      parameters,
      expects_response: true,
      response_timeout_secs: 30,
    };
  });
}

const rateOf = (format: unknown) => {
  const m = /^pcm_(\d+)$/.exec(String(format ?? ''));
  return m ? Number(m[1]) : undefined;
};

/**
 * ElevenLabs Agents Platform WebSocket: base64 PCM in JSON both ways, the screen tools as client
 * tools. The app's prompt and live screen replace the agent's prompt per session (the agent must
 * allow prompt overrides), and its greeting fills the agent's first message, "{{greeting}}".
 * scripts/elevenlabs-agent.mjs sets an agent up this way.
 */
export function elevenLabsProtocol(settings: ElevenLabsAgentSettings = {}): VoiceAgentProtocol {
  return {
    name: 'ElevenLabs',
    audioIn: { kind: 'json', message: audio => ({ user_audio_chunk: audio }) },
    open: {
      waitForReady: true,
      messages: ({ greeting, instructions, screen }) => [
        {
          type: 'conversation_initiation_client_data',
          conversation_config_override: {
            agent: {
              prompt: { prompt: `${instructions}\n\nCurrent screen:\n${screen}` },
              ...(settings.language && { language: settings.language }),
            },
            ...(settings.voiceId && { tts: { voice_id: settings.voiceId } }),
          },
          // The agent's first message is "{{greeting}}".
          dynamic_variables: { greeting },
        },
      ],
    },
    parse: msg => {
      switch (msg.type) {
        case 'conversation_initiation_metadata': {
          const meta = msg.conversation_initiation_metadata_event ?? {};
          const inputRate = rateOf(meta.user_input_audio_format);
          const outputRate = rateOf(meta.agent_output_audio_format);
          if ((meta.user_input_audio_format && !inputRate) || (meta.agent_output_audio_format && !outputRate))
            return [{ type: 'error', message: `the agent uses ${meta.user_input_audio_format}/${meta.agent_output_audio_format}; set both to pcm_24000` }];
          return [{ type: 'audio-format', inputRate, outputRate }, { type: 'ready' }];
        }
        case 'audio':
          return msg.audio_event?.audio_base_64 ? [{ type: 'audio', base64: msg.audio_event.audio_base_64 }] : [];
        case 'agent_chat_response_part':
          // The reply as it's written, ahead of its audio: lets its echo be recognised from the start.
          return msg.text_response_part?.type === 'delta' && msg.text_response_part.text
            ? [{ type: 'agent-text', text: msg.text_response_part.text, partial: true }]
            : [];
        case 'agent_response': {
          const text = String(msg.agent_response_event?.agent_response ?? '').trim();
          return text ? [{ type: 'agent-text', text }] : [];
        }
        case 'interruption':
          return [{ type: 'user-speaking' }];
        case 'vad_score':
          return (msg.vad_score_event?.vad_score ?? 0) > 0.6 ? [{ type: 'user-speaking' }] : [];
        case 'user_transcript': {
          const text = String(msg.user_transcription_event?.user_transcript ?? '').trim();
          return text ? [{ type: 'user-text', text, final: true }] : [];
        }
        case 'client_tool_call': {
          const call = msg.client_tool_call;
          if (!call) return [];
          const args = { ...call.parameters };
          // A free-form object can't be described to ElevenLabs: run_screen_action takes its args as JSON text.
          if (call.tool_name === 'run_screen_action' && typeof args.args === 'string') {
            try {
              args.args = JSON.parse(args.args);
            } catch {
              args.args = {};
            }
          }
          return [{ type: 'tool-calls', calls: [{ id: call.tool_call_id, name: call.tool_name, args }] }];
        }
        case 'ping':
          return [{ type: 'send', messages: [{ type: 'pong', event_id: msg.ping_event?.event_id }] }];
        case 'client_error':
          return [{ type: 'error', message: msg.error_event?.message || 'error' }];
        default:
          return [];
      }
    },
    toolResult: (call, result) => [{ type: 'client_tool_result', tool_call_id: call.id, result: result.content, is_error: result.isError }],
    userText: text => [{ type: 'user_message', text }],
    context: text => [{ type: 'contextual_update', text }],
    // No "reply done" message: a pause in its audio ends the reply.
    replyGapMs: ANSWER_GAP_MS,
  };
}

/**
 * A conversation with an ElevenLabs agent. ElevenLabs does the speech recognition, turn-taking and
 * voice; the agent's LLM calls the screen tools, which run here.
 */
export function elevenLabsAgentModel(opts: ElevenLabsAgentOptions): RealtimeVoiceModel {
  return voiceAgentModel(elevenLabsProtocol(opts), opts);
}
