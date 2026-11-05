import type { RealtimeVoiceModel } from './session';
import { voiceAudio, type VoiceInterruptions } from './voiceAudio';

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

export interface OpenAIRealtimeOptions {
  /** Called per session; fetch a short-lived token from your backend here, or return your relay URL. */
  connect: () => Promise<RealtimeConnection>;
  audio: PcmAudioIO;
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
  /** Live captions from a speech-to-text side stream (see ElevenLabsAgentOptions.liveTranscript). */
  liveTranscript?: () => Promise<RealtimeConnection>;
  /** Overrides the assistant's `voiceInterruptions` for this transport. */
  voiceInterruptions?: VoiceInterruptions;
  /** For tests / non-RN runtimes. Defaults to the global WebSocket (RN's accepts a headers option). */
  WebSocketImpl?: any;
}

type FunctionCall = { call_id: string; name: string; arguments: string };

const END_TOOL = 'end_conversation';

/**
 * Speech-to-speech over the OpenAI Realtime WebSocket protocol (LiteLLM's /v1/realtime speaks it
 * too). This is only the protocol: timeouts, stop phrases, confirmations and captions are the
 * assistant's (see RealtimeSession).
 */
export function openAIRealtimeModel(opts: OpenAIRealtimeOptions): RealtimeVoiceModel {
  const protocol = opts.protocol ?? 'ga';
  return {
    async run(session) {
      const { greeting, screen, instructions: systemPrompt, tools, signal } = session;
      const conn = await opts.connect();
      const WS = opts.WebSocketImpl ?? (globalThis as any).WebSocket;
      const ws = new WS(conn.url, conn.protocols ?? [], conn.headers ? { headers: conn.headers } : undefined);
      const mic = voiceAudio(opts.audio, {
        voiceInterruptions: opts.voiceInterruptions ?? session.voiceInterruptions,
        liveTranscript: opts.liveTranscript,
        WebSocketImpl: opts.WebSocketImpl,
        onCaption: text => session.emit({ type: 'user-text', text, final: false }),
        onMicLevel: level => session.emit({ type: 'mic-level', level }),
        onSpeech: () => session.emit({ type: 'user-speaking' }),
        onBargeIn: () => cutOff?.(),
      });
      let cutOff: (() => void) | undefined;

      await new Promise<void>((resolve, reject) => {
        let userSpoke = false;
        let endRequested = false;
        let settled = false;
        const partials = new Map<string, string>(); // live transcription per input item

        const send = (event: object) => ws.readyState === 1 && ws.send(JSON.stringify(event));

        const finish = async (error?: Error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          await mic.close(!!error || signal.aborted);
          try {
            ws.close();
          } catch {}
          error ? reject(error) : resolve();
        };
        const onAbort = () => void finish();
        signal.addEventListener('abort', onAbort, { once: true });

        const toolDefs = [
          ...tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema })),
          {
            type: 'function',
            name: END_TOOL,
            description: "End the voice session when the user is finished (\"that's all\", \"thanks, bye\", \"stop\"). Say a short goodbye first.",
            parameters: { type: 'object', properties: {} },
          },
        ];
        const instructions = `${systemPrompt}\n\nCurrent screen:\n${screen}`;
        const serverVad = { type: 'server_vad', silence_duration_ms: opts.silenceDurationMs ?? 600 };
        let vad: object =
          (opts.turnDetection ?? 'semantic') === 'semantic' ? { type: 'semantic_vad', eagerness: opts.eagerness ?? 'auto' } : serverVad;
        const sessionWith = (turn_detection: object) =>
          protocol === 'ga'
            ? {
                type: 'realtime',
                instructions,
                tools: toolDefs,
                tool_choice: 'auto',
                audio: {
                  input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection },
                  output: { format: { type: 'audio/pcm', rate: 24000 }, ...(opts.voice && { voice: opts.voice }) },
                },
              }
            : {
                modalities: ['audio', 'text'],
                instructions,
                tools: toolDefs,
                tool_choice: 'auto',
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm16',
                turn_detection,
                ...(opts.voice && { voice: opts.voice }),
              };

        // What the user has heard of the answer being played, so a barge-in can truncate it
        // (conversation.item.truncate): otherwise the model thinks the whole answer was heard.
        let playing: { itemId: string; startedAt: number; queuedMs: number } | null = null;
        const truncatePlaying = () => {
          if (!playing?.itemId) return;
          const heardMs = Math.max(0, Math.min(playing.queuedMs, Date.now() - playing.startedAt));
          send({ type: 'conversation.item.truncate', item_id: playing.itemId, content_index: 0, audio_end_ms: Math.round(heardMs) });
          playing = null;
        };

        /** The reply has finished playing: open the mic (once) and hand the turn to the user. */
        const answered = () =>
          void mic
            .drained()
            .then(() => {
              if (settled) return;
              playing = null;
              if (endRequested) return finish();
              void mic.startMic(chunk => send({ type: 'input_audio_buffer.append', audio: chunk })).catch(e => finish(e));
              session.emit({ type: 'agent-done' });
            })
            .catch(e => finish(e));

        const runToolCalls = async (calls: FunctionCall[]) => {
          for (const call of calls) {
            if (call.name === END_TOOL) {
              endRequested = true;
              send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: 'ok' } });
              continue;
            }
            let input: unknown;
            try {
              input = JSON.parse(call.arguments || '{}');
            } catch {
              input = call.arguments;
            }
            const result = await session.runTool(call.name, input);
            send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: result.content } });
          }
          if (endRequested) return answered();
          send({ type: 'response.create' });
        };

        // The user talked over the agent: stop the reply; their voice now reaches the server.
        cutOff = () => {
          send({ type: 'response.cancel' });
          truncatePlaying();
          session.emit({ type: 'interrupted' });
          session.emit({ type: 'user-speaking' });
        };

        session.handle({
          // Cut the answer short; the server keeps listening for the user's next turn.
          interrupt: () => {
            mic.flush();
            send({ type: 'response.cancel' });
            truncatePlaying();
            session.emit({ type: 'interrupted' });
            answered();
          },
          context: text => send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } }),
          text: text => {
            send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
            send({ type: 'response.create' });
          },
        });

        ws.onopen = () => {
          send({ type: 'session.update', session: sessionWith(vad) });
          // Speak the configured greeting first, then open the mic (avoids the mic hearing it).
          send({ type: 'response.create', response: { instructions: `Say exactly this greeting and nothing else: "${greeting}"` } });
        };

        ws.onerror = (e: any) => void finish(new Error(`Realtime connection error${e?.message ? `: ${e.message}` : ''}`));
        ws.onclose = (e: any) => {
          if (!settled) void finish(userSpoke ? undefined : new Error(`Realtime connection closed (${e?.code ?? '?'}) ${e?.reason ?? ''}`.trim()));
        };

        ws.onmessage = (msg: { data: string }) => {
          let event: any;
          try {
            event = JSON.parse(msg.data);
          } catch {
            return;
          }
          switch (event.type) {
            case 'response.output_audio.delta':
            case 'response.audio.delta':
              if (event.delta) {
                const level = mic.play(event.delta);
                if (!playing || playing.itemId !== event.item_id) playing = { itemId: event.item_id, startedAt: Date.now(), queuedMs: 0 };
                // PCM16 mono 24 kHz: 48 bytes per ms, 4 base64 chars per 3 bytes.
                playing.queuedMs += (event.delta.length * 3) / 4 / 48;
                session.emit({ type: 'agent-audio', level });
              }
              break;
            case 'response.output_audio_transcript.delta':
            case 'response.audio_transcript.delta':
              if (event.delta) mic.agentSays(event.delta);
              break;
            case 'response.output_audio_transcript.done':
            case 'response.audio_transcript.done':
              if (event.transcript?.trim()) session.emit({ type: 'agent-text', text: event.transcript.trim() });
              break;
            case 'input_audio_buffer.speech_started':
              if (playing) {
                // Barge-in: stop the answer, and the model learns how much was heard.
                mic.flush();
                truncatePlaying();
                session.emit({ type: 'interrupted' });
              }
              session.emit({ type: 'user-speaking' });
              break;
            case 'conversation.item.input_audio_transcription.delta': {
              const text = (partials.get(event.item_id) ?? '') + (event.delta ?? '');
              partials.set(event.item_id, text);
              if (text.trim()) session.emit({ type: 'user-text', text: text.trim(), final: false });
              break;
            }
            case 'conversation.item.input_audio_transcription.completed':
              partials.delete(event.item_id);
              if (event.transcript?.trim()) {
                userSpoke = true;
                session.emit({ type: 'user-text', text: String(event.transcript).trim(), final: true });
              }
              break;
            case 'response.done': {
              const output: any[] = event.response?.output ?? [];
              const calls: FunctionCall[] = output.filter(o => o.type === 'function_call');
              if (calls.length) void runToolCalls(calls).catch(e => finish(e));
              else if (event.response?.status !== 'cancelled') answered();
              break;
            }
            case 'error': {
              const message: string = event.error?.message ?? '';
              // Older models don't know semantic_vad: retry with silence-based turn detection.
              if (vad !== serverVad && /semantic_vad|turn_detection/i.test(message)) {
                vad = serverVad;
                send({ type: 'session.update', session: sessionWith(vad) });
                break;
              }
              // Cancelling with nothing to cancel, or truncating finished audio, is harmless; the rest ends the session.
              if (!/cancel|truncat/i.test(`${event.error?.code ?? ''} ${message}`)) void finish(new Error(message || 'Realtime error'));
              break;
            }
          }
        };
      });
    },
  };
}
