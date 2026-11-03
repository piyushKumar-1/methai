import type { RealtimeVoiceModel } from './assistant';
import { SCREEN_TOOLS, type JSONSchemaObject } from './llm';
import { floatToPcm16Base64, pcm16Base64ToFloat, pcmLevel, resample } from './pcm';
import type { PcmAudioIO, RealtimeConnection } from './realtime';

export interface ElevenLabsAgentOptions {
  /**
   * Called per session. Return the agent's signed URL, fetched by your backend from
   * GET /v1/convai/conversation/get-signed-url?agent_id=… (keeps the API key off the device).
   */
  connect: () => Promise<RealtimeConnection>;
  audio: PcmAudioIO;
  /**
   * Live captions of what the user is saying. ElevenLabs agents only send the user's words once
   * their turn is over, so for words on screen while they talk, the same mic audio also streams to
   * Scribe realtime speech-to-text. Return its URL with a single-use token, fetched by your backend
   * from POST /v1/single-use-token/realtime_scribe:
   * wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_24000&commit_strategy=vad&token=…
   */
  liveTranscript?: () => Promise<RealtimeConnection>;
  /** Override the agent's voice for this app. */
  voiceId?: string;
  /** Language code for speech recognition and the voice, e.g. 'en', 'hi'. Default: the agent's. */
  language?: string;
  /** End the session if the user says nothing for this long after the greeting. Default 8000ms. */
  noSpeechTimeoutMs?: number;
  /** 'single' conversations: after an answer, keep listening this long for a reply. Default 4000ms. */
  followUpTimeoutMs?: number;
  /** 'continuous' conversations: end after this much silence following an answer. Default 12000ms. */
  idleTimeoutMs?: number;
  /** For tests / non-RN runtimes. Defaults to the global WebSocket. */
  WebSocketImpl?: any;
}

const RATE = 24000; // PcmAudioIO's rate
/** Mic loudness (pcmLevel) that counts as the user talking, for this many 100 ms chunks in a row. */
const SPEECH_LEVEL = 0.3;
const SPEECH_CHUNKS = 3;
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
const convert = (chunk: string, from: number, to: number) =>
  from === to ? chunk : floatToPcm16Base64(resample(pcm16Base64ToFloat(chunk), from, to));

/**
 * A conversation with an ElevenLabs agent (Agents Platform WebSocket). ElevenLabs does the speech
 * recognition, turn-taking, interruptions and voice; the agent's LLM calls the screen tools, which
 * run here. The app's prompt and live screen replace the agent's prompt for each session (the agent
 * must allow prompt overrides), and its greeting fills the agent's first message, "{{greeting}}".
 * scripts/elevenlabs-agent.mjs sets an agent up this way.
 */
export function elevenLabsAgentModel(opts: ElevenLabsAgentOptions): RealtimeVoiceModel {
  return {
    async run({ greeting, screen, instructions, onToolCall, setState, onTranscript, onLevel, conversation, isStopPhrase, onInterrupt, signal }) {
      const conn = await opts.connect();
      const WS = opts.WebSocketImpl ?? (globalThis as any).WebSocket;
      const ws = new WS(conn.url, conn.protocols ?? [], conn.headers ? { headers: conn.headers } : undefined);
      const { audio } = opts;

      await new Promise<void>((resolve, reject) => {
        let phase: 'greeting' | 'conversation' = 'greeting';
        let inRate = RATE;
        let outRate = RATE;
        let userSpoke = false;
        let awaitingSpeech = false;
        let endRequested = false;
        let capturing = false;
        let tools = 0; // tool calls running
        let muted = false; // the user tapped to cut the answer: drop its remaining audio
        let answerTimer: ReturnType<typeof setTimeout> | undefined;
        let noSpeechTimer: ReturnType<typeof setTimeout> | undefined;
        let toolQueue = Promise.resolve();
        let loudChunks = 0;
        let agentSpeaking = false;
        let captions: any = null; // Scribe realtime socket for live captions
        let settled = false;

        const send = (event: object) => ws.readyState === 1 && ws.send(JSON.stringify(event));

        const finish = async (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(answerTimer);
          clearTimeout(noSpeechTimer);
          signal.removeEventListener('abort', onAbort);
          try {
            if (capturing) await audio.stopCapture();
            if (!error && !signal.aborted) await audio.drained();
            else audio.flush();
          } catch {}
          try {
            ws.close();
            captions?.close();
          } catch {}
          error ? reject(error) : resolve();
        };
        const onAbort = () => void finish();
        signal.addEventListener('abort', onAbort, { once: true });

        /** Live captions are a nicety: if Scribe can't be reached, the conversation goes on without them. */
        const openCaptions = () => {
          if (!opts.liveTranscript) return;
          void opts
            .liveTranscript()
            .then(c => {
              if (settled) return;
              captions = new WS(c.url, c.protocols ?? [], c.headers ? { headers: c.headers } : undefined);
              captions.onmessage = (msg: { data: string }) => {
                let event: any;
                try {
                  event = JSON.parse(msg.data);
                } catch {
                  return;
                }
                const text = String(event.text ?? '').trim();
                // While the agent talks, the mic mostly hears the agent: only show the user's words.
                if (!text || agentSpeaking || settled) return;
                if (event.message_type === 'partial_transcript' || event.message_type === 'committed_transcript') onTranscript?.(text);
              };
              captions.onerror = () => {};
            })
            .catch(() => {});
        };

        /** Opens the mic (once) and ends the session if nobody speaks within `timeoutMs`. */
        const listen = async (timeoutMs: number) => {
          phase = 'conversation';
          setState?.('listening');
          agentSpeaking = false;
          if (!capturing) {
            capturing = true;
            openCaptions();
            await audio.startCapture(chunk => {
              send({ user_audio_chunk: convert(chunk, RATE, inRate) });
              if (captions?.readyState === 1) captions.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: chunk, sample_rate: RATE }));
              const level = pcmLevel(chunk);
              if (onLevel) onLevel(level);
              // The user is talking: don't time out before ElevenLabs ends their turn (it only
              // sends the transcript then, and vad_score only when the agent enables it).
              loudChunks = level >= SPEECH_LEVEL ? loudChunks + 1 : 0;
              if (loudChunks >= SPEECH_CHUNKS && awaitingSpeech) heardUser();
            });
          }
          awaitingSpeech = true;
          clearTimeout(noSpeechTimer);
          noSpeechTimer = setTimeout(() => awaitingSpeech && void finish(), timeoutMs);
        };
        const heardUser = () => {
          userSpoke = true;
          awaitingSpeech = false;
          clearTimeout(noSpeechTimer);
        };

        /** The agent stopped sending audio: once it has played, it's the user's turn (or the end). */
        const answered = () => {
          if (tools > 0) return; // still acting: more speech follows the tool results
          void audio
            .drained()
            .then(() => {
              if (settled || tools > 0) return;
              if (phase === 'greeting') return listen(opts.noSpeechTimeoutMs ?? 8000);
              if (endRequested) return finish();
              const timeout = conversation === 'continuous' ? opts.idleTimeoutMs ?? 12000 : opts.followUpTimeoutMs ?? 4000;
              return listen(timeout);
            })
            .catch(e => finish(e));
        };

        const runTool = (call: { tool_call_id: string; tool_name: string; parameters?: Record<string, any>; expects_response?: boolean }) => {
          tools++;
          clearTimeout(answerTimer);
          setState?.('thinking');
          toolQueue = toolQueue.then(async () => {
            const input = { ...call.parameters };
            if (call.tool_name === 'run_screen_action' && typeof input.args === 'string') {
              try {
                input.args = JSON.parse(input.args);
              } catch {
                input.args = {};
              }
            }
            let result: { content: string; isError: boolean };
            try {
              result = await onToolCall(call.tool_name, input);
            } catch (e) {
              result = { content: String(e), isError: true };
            }
            tools--;
            if (call.expects_response !== false) send({ type: 'client_tool_result', tool_call_id: call.tool_call_id, result: result.content, is_error: result.isError });
          });
        };

        onInterrupt(() => {
          // There is no "cancel" message: stop playing, and ignore the rest of this answer.
          audio.flush();
          muted = true;
          clearTimeout(answerTimer);
          answered();
        });

        ws.onopen = () => {
          send({
            type: 'conversation_initiation_client_data',
            conversation_config_override: {
              agent: {
                prompt: { prompt: `${instructions}\n\nCurrent screen:\n${screen}` },
                ...(opts.language && { language: opts.language }),
              },
              ...(opts.voiceId && { tts: { voice_id: opts.voiceId } }),
            },
            // The agent's first message is "{{greeting}}".
            dynamic_variables: { greeting },
          });
          setState?.('greeting');
        };

        ws.onerror = (e: any) => void finish(new Error(`ElevenLabs connection error${e?.message ? `: ${e.message}` : ''}`));
        ws.onclose = (e: any) => {
          // The agent hangs up (end_call) by closing the socket; let the goodbye finish playing.
          if (settled) return;
          if (userSpoke) void finish();
          else void finish(new Error(`ElevenLabs connection closed (${e?.code ?? '?'}) ${e?.reason ?? ''}`.trim()));
        };

        ws.onmessage = (msg: { data: string }) => {
          let event: any;
          try {
            event = JSON.parse(msg.data);
          } catch {
            return;
          }
          switch (event.type) {
            case 'conversation_initiation_metadata': {
              const meta = event.conversation_initiation_metadata_event ?? {};
              const input = rateOf(meta.user_input_audio_format);
              const output = rateOf(meta.agent_output_audio_format);
              if ((meta.user_input_audio_format && !input) || (meta.agent_output_audio_format && !output))
                return void finish(new Error(`ElevenLabs agent uses ${meta.user_input_audio_format}/${meta.agent_output_audio_format}; set both to pcm_24000`));
              inRate = input ?? RATE;
              outRate = output ?? RATE;
              // No greeting configured: the agent waits for the user.
              if (!greeting) void listen(opts.noSpeechTimeoutMs ?? 8000).catch(e => finish(e));
              break;
            }
            case 'audio': {
              const chunk = event.audio_event?.audio_base_64;
              if (!chunk || muted) break;
              const pcm = convert(chunk, outRate, RATE);
              agentSpeaking = true;
              audio.play(pcm);
              if (onLevel) onLevel(pcmLevel(pcm));
              if (phase === 'conversation' && tools === 0) setState?.('speaking');
              clearTimeout(answerTimer);
              answerTimer = setTimeout(answered, ANSWER_GAP_MS);
              break;
            }
            case 'interruption':
              // The user talked over the agent (ElevenLabs decides this, with echo in mind).
              audio.flush();
              agentSpeaking = false;
              clearTimeout(answerTimer);
              heardUser();
              setState?.('listening');
              break;
            case 'vad_score':
              // The user is speaking: don't time out in the middle of a long request.
              if ((event.vad_score_event?.vad_score ?? 0) > 0.6 && awaitingSpeech) heardUser();
              break;
            case 'user_transcript': {
              const text = String(event.user_transcription_event?.user_transcript ?? '').trim();
              if (!text) break;
              heardUser();
              muted = false;
              onTranscript?.(text);
              if (isStopPhrase(text)) endRequested = true; // end after the agent's reply
              setState?.('thinking');
              break;
            }
            case 'client_tool_call':
              if (event.client_tool_call) runTool(event.client_tool_call);
              break;
            case 'ping':
              send({ type: 'pong', event_id: event.ping_event?.event_id });
              break;
            case 'client_error':
              void finish(new Error(event.error_event?.message || 'ElevenLabs error'));
              break;
          }
        };
      });
    },
  };
}
