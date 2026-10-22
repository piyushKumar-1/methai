import type { RealtimeVoiceModel } from './assistant';

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
  /** End the session if the user says nothing for this long after the greeting. Default 8000ms. */
  noSpeechTimeoutMs?: number;
  /** 'single' conversations: after an answer, keep listening this long for a reply. Default 4000ms. */
  followUpTimeoutMs?: number;
  /** 'continuous' conversations: end after this much silence following an answer. Default 12000ms. */
  idleTimeoutMs?: number;
  /** Server VAD: silence that ends the user's turn. Default 600ms. */
  silenceDurationMs?: number;
  /** For tests / non-RN runtimes. Defaults to the global WebSocket (RN's accepts a headers option). */
  WebSocketImpl?: any;
}

type FunctionCall = { call_id: string; name: string; arguments: string };

const END_TOOL = 'end_conversation';

/** Speech-to-speech over the OpenAI Realtime WebSocket protocol (LiteLLM's /v1/realtime speaks it too). */
export function openAIRealtimeModel(opts: OpenAIRealtimeOptions): RealtimeVoiceModel {
  const protocol = opts.protocol ?? 'ga';
  return {
    async run({ greeting, screen, instructions: systemPrompt, tools, onToolCall, setState, onTranscript, conversation, isStopPhrase, onInterrupt, signal }) {
      const conn = await opts.connect();
      const WS = opts.WebSocketImpl ?? (globalThis as any).WebSocket;
      const ws = new WS(conn.url, conn.protocols ?? [], conn.headers ? { headers: conn.headers } : undefined);
      const { audio } = opts;

      await new Promise<void>((resolve, reject) => {
        let phase: 'greeting' | 'conversation' = 'greeting';
        let userSpoke = false;
        let awaitingSpeech = false;
        let endRequested = false;
        let capturing = false;
        let busy = false; // running tool calls
        let noSpeechTimer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;

        const send = (event: object) => ws.readyState === 1 && ws.send(JSON.stringify(event));

        const finish = async (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(noSpeechTimer);
          signal.removeEventListener('abort', onAbort);
          try {
            if (capturing) await audio.stopCapture();
            if (!error && !signal.aborted) await audio.drained();
            else audio.flush();
          } catch {}
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
        const vad = { type: 'server_vad', silence_duration_ms: opts.silenceDurationMs ?? 600 };
        const session =
          protocol === 'ga'
            ? {
                type: 'realtime',
                instructions,
                tools: toolDefs,
                tool_choice: 'auto',
                audio: {
                  input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection: vad },
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
                turn_detection: vad,
                ...(opts.voice && { voice: opts.voice }),
              };

        /** Opens the mic (once) and ends the session if nobody speaks within `timeoutMs`. */
        const listen = async (timeoutMs: number) => {
          phase = 'conversation';
          setState?.('listening');
          if (!capturing) {
            capturing = true;
            await audio.startCapture(chunk => send({ type: 'input_audio_buffer.append', audio: chunk }));
          }
          awaitingSpeech = true;
          clearTimeout(noSpeechTimer);
          noSpeechTimer = setTimeout(() => awaitingSpeech && void finish(), timeoutMs);
        };

        const runToolCalls = async (calls: FunctionCall[]) => {
          busy = true;
          setState?.('thinking');
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
            const result = await onToolCall(call.name, input);
            send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: result.content } });
          }
          busy = false;
          if (endRequested) return void finish();
          send({ type: 'response.create' });
        };

        onInterrupt(() => {
          // Cut the answer short; the server keeps listening for the user's next turn.
          audio.flush();
          send({ type: 'response.cancel' });
          setState?.('listening');
        });

        ws.onopen = () => {
          send({ type: 'session.update', session });
          // Speak the configured greeting first, then open the mic (avoids the mic hearing it).
          send({ type: 'response.create', response: { instructions: `Say exactly this greeting and nothing else: "${greeting}"` } });
          setState?.('greeting');
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
              if (event.delta) audio.play(event.delta);
              if (phase === 'conversation' && !busy) setState?.('speaking');
              break;
            case 'input_audio_buffer.speech_started':
              userSpoke = true;
              awaitingSpeech = false;
              clearTimeout(noSpeechTimer);
              audio.flush(); // barge-in
              setState?.('listening');
              break;
            case 'input_audio_buffer.speech_stopped':
              setState?.('thinking');
              break;
            case 'conversation.item.input_audio_transcription.completed':
              if (event.transcript) {
                const text = String(event.transcript).trim();
                onTranscript?.(text);
                if (isStopPhrase(text)) endRequested = true; // end after the model's reply
              }
              break;
            case 'response.done': {
              const output: any[] = event.response?.output ?? [];
              const calls: FunctionCall[] = output.filter(o => o.type === 'function_call');
              if (calls.length) {
                void runToolCalls(calls).catch(e => finish(e));
              } else if (phase === 'greeting') {
                void audio.drained().then(() => listen(opts.noSpeechTimeoutMs ?? 8000)).catch(e => finish(e));
              } else if (endRequested) {
                void finish();
              } else if (userSpoke && event.response?.status !== 'cancelled') {
                // Answer given: once it has played, keep listening (continuous) or wait briefly for a reply.
                const timeout = conversation === 'continuous' ? opts.idleTimeoutMs ?? 12000 : opts.followUpTimeoutMs ?? 4000;
                void audio.drained().then(() => listen(timeout)).catch(e => finish(e));
              }
              break;
            }
            case 'error':
              // Cancelling with nothing to cancel is harmless; everything else ends the session.
              if (!/cancel/i.test(event.error?.code ?? '')) void finish(new Error(event.error?.message ?? 'Realtime error'));
              break;
          }
        };
      });
    },
  };
}
