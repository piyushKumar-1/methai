import type { RealtimeVoiceModel } from './session';
import { voiceAgentModel, type VoiceAgentOptions, type VoiceAgentProtocol, type VoiceAgentSetup } from './voiceAgent';

/** Streaming mic + speaker at 24 kHz mono PCM16 (base64), e.g. example/pcm-audio.ts. */
export interface PcmAudioIO {
  startCapture(onChunk: (pcm16Base64: string) => void): Promise<void>;
  stopCapture(): Promise<void>;
  /** Queue a chunk for gapless playback. */
  play(pcm16Base64: string): void;
  /** Drop everything queued (the user started talking over the model). */
  flush(): void;
  /** Resolves when queued audio has finished playing. */
  drained(): Promise<void>;
  close(): Promise<void>;
}

export interface RealtimeConnection {
  /** e.g. wss://gateway/v1/realtime?model=xor-latest-custom, or your relay. */
  url: string;
  headers?: Record<string, string>;
  protocols?: string[];
}

export interface OpenAIRealtimeSettings {
  voice?: string;
  /** Event/session shape: 'ga' (current OpenAI Realtime) or 'beta' (older realtime-preview models). Default 'ga'. */
  protocol?: 'ga' | 'beta';
  /**
   * How the server decides the user's turn is over. 'semantic' (default) judges from the words
   * whether they're done (a trailing "umm" waits longer); 'server' waits for `silenceDurationMs`
   * of silence. Falls back to 'server' if the model rejects semantic_vad.
   */
  turnDetection?: 'semantic' | 'server';
  /** semantic_vad: how quickly to answer. 'low' gives the user more time. Default 'auto'. */
  eagerness?: 'low' | 'medium' | 'high' | 'auto';
  /** server_vad: silence that ends the user's turn. Default 600ms. */
  silenceDurationMs?: number;
}

/** `connect`: fetch a short-lived token from your backend here, or return your relay URL. */
export type OpenAIRealtimeOptions = VoiceAgentOptions & OpenAIRealtimeSettings;

const END_TOOL = 'end_conversation';

/** The OpenAI Realtime WebSocket protocol (LiteLLM's /v1/realtime speaks it too): base64 PCM in JSON both ways. */
export function openAIRealtimeProtocol(settings: OpenAIRealtimeSettings = {}): VoiceAgentProtocol {
  const ga = (settings.protocol ?? 'ga') === 'ga';
  const serverVad = { type: 'server_vad', silence_duration_ms: settings.silenceDurationMs ?? 600 };
  let vad: object = (settings.turnDetection ?? 'semantic') === 'semantic' ? { type: 'semantic_vad', eagerness: settings.eagerness ?? 'auto' } : serverVad;
  let setup: VoiceAgentSetup | undefined;
  const partials = new Map<string, string>(); // live transcription per input item

  const sessionUpdate = () => {
    const { instructions: systemPrompt, screen, tools } = setup!;
    const instructions = `${systemPrompt}\n\nCurrent screen:\n${screen}`;
    const toolDefs = [
      ...tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema })),
      {
        type: 'function',
        name: END_TOOL,
        description: "End the voice session when the user is finished (\"that's all\", \"thanks, bye\", \"stop\"). Say a short goodbye first.",
        parameters: { type: 'object', properties: {} },
      },
    ];
    const session = ga
      ? {
          type: 'realtime',
          instructions,
          tools: toolDefs,
          tool_choice: 'auto',
          audio: {
            input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection: vad },
            output: { format: { type: 'audio/pcm', rate: 24000 }, ...(settings.voice && { voice: settings.voice }) },
          },
        }
      : {
          modalities: ['audio', 'text'],
          instructions,
          tools: toolDefs,
          tool_choice: 'auto',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          turn_detection: vad,
          ...(settings.voice && { voice: settings.voice }),
        };
    return { type: 'session.update', session };
  };

  return {
    name: 'Realtime',
    audioIn: { kind: 'json', message: audio => ({ type: 'input_audio_buffer.append', audio }) },
    open: {
      messages: s => {
        setup = s;
        // Speak the configured greeting first; the mic opens after it (so it doesn't hear it).
        return [sessionUpdate(), { type: 'response.create', response: { instructions: `Say exactly this greeting and nothing else: "${s.greeting}"` } }];
      },
    },
    parse: msg => {
      switch (msg.type) {
        case 'response.output_audio.delta':
        case 'response.audio.delta':
          return msg.delta ? [{ type: 'audio', base64: msg.delta, replyId: msg.item_id }] : [];
        case 'response.output_audio_transcript.delta':
        case 'response.audio_transcript.delta':
          return msg.delta ? [{ type: 'agent-text', text: msg.delta, partial: true }] : [];
        case 'response.output_audio_transcript.done':
        case 'response.audio_transcript.done':
          return msg.transcript?.trim() ? [{ type: 'agent-text', text: msg.transcript.trim() }] : [];
        case 'input_audio_buffer.speech_started':
          return [{ type: 'user-speaking' }];
        case 'conversation.item.input_audio_transcription.delta': {
          const text = (partials.get(msg.item_id) ?? '') + (msg.delta ?? '');
          partials.set(msg.item_id, text);
          return text.trim() ? [{ type: 'user-text', text: text.trim(), final: false }] : [];
        }
        case 'conversation.item.input_audio_transcription.completed':
          partials.delete(msg.item_id);
          return msg.transcript?.trim() ? [{ type: 'user-text', text: String(msg.transcript).trim(), final: true }] : [];
        case 'response.done': {
          const output: any[] = msg.response?.output ?? [];
          const calls = output.filter(o => o.type === 'function_call');
          if (calls.length) return [{ type: 'tool-calls', calls: calls.map(c => ({ id: c.call_id, name: c.name, args: c.arguments })) }];
          return [{ type: 'reply-done', cancelled: msg.response?.status === 'cancelled' }];
        }
        case 'error': {
          const message: string = msg.error?.message ?? '';
          // Older models don't know semantic_vad: retry with silence-based turn detection.
          if (vad !== serverVad && /semantic_vad|turn_detection/i.test(message)) {
            vad = serverVad;
            return [{ type: 'send', messages: [sessionUpdate()] }];
          }
          // Cancelling with nothing to cancel, or truncating finished audio, is harmless.
          return [{ type: 'error', message: message || 'error', fatal: !/cancel|truncat/i.test(`${msg.error?.code ?? ''} ${message}`) }];
        }
        default:
          return [];
      }
    },
    toolResult: (call, result) => [{ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.id, output: result.content } }],
    afterToolResults: () => [{ type: 'response.create' }],
    userText: text => [
      { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
      { type: 'response.create' },
    ],
    context: text => [{ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } }],
    // The model learns how much of its answer was heard (otherwise it thinks all of it was).
    interrupted: ({ replyId, heardMs }) => [
      { type: 'response.cancel' },
      ...(replyId ? [{ type: 'conversation.item.truncate', item_id: replyId, content_index: 0, audio_end_ms: heardMs }] : []),
    ],
    endTool: END_TOOL,
  };
}

/** Speech-to-speech over the OpenAI Realtime WebSocket protocol. */
export function openAIRealtimeModel(opts: OpenAIRealtimeOptions): RealtimeVoiceModel {
  return voiceAgentModel(() => openAIRealtimeProtocol(opts), opts);
}
