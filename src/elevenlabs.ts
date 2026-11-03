import { SCREEN_TOOLS, type JSONSchemaObject } from './llm';
import { floatToPcm16Base64, pcm16Base64ToFloat, resample } from './pcm';
import type { PcmAudioIO, RealtimeConnection } from './realtime';
import type { RealtimeVoiceModel } from './session';
import { voiceAudio, type VoiceInterruptions } from './voiceAudio';

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
  /** Overrides the assistant's `voiceInterruptions` for this transport. */
  voiceInterruptions?: VoiceInterruptions;
  /** Override the agent's voice for this app. */
  voiceId?: string;
  /** Language code for speech recognition and the voice, e.g. 'en', 'hi'. Default: the agent's. */
  language?: string;
  /** For tests / non-RN runtimes. Defaults to the global WebSocket. */
  WebSocketImpl?: any;
}

const RATE = 24000; // PcmAudioIO's rate
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
 * recognition, turn-taking and voice; the agent's LLM calls the screen tools, which run here. The
 * app's prompt and live screen replace the agent's prompt for each session (the agent must allow
 * prompt overrides), and its greeting fills the agent's first message, "{{greeting}}".
 * scripts/elevenlabs-agent.mjs sets an agent up this way. This is only the protocol: timeouts,
 * stop phrases, confirmations and captions are the assistant's (see RealtimeSession).
 */
export function elevenLabsAgentModel(opts: ElevenLabsAgentOptions): RealtimeVoiceModel {
  return {
    async run(session) {
      const { greeting, screen, instructions, signal } = session;
      const conn = await opts.connect();
      const WS = opts.WebSocketImpl ?? (globalThis as any).WebSocket;
      const ws = new WS(conn.url, conn.protocols ?? [], conn.headers ? { headers: conn.headers } : undefined);
      const mic = voiceAudio(opts.audio, {
        voiceInterruptions: opts.voiceInterruptions ?? session.voiceInterruptions,
        liveTranscript: opts.liveTranscript,
        WebSocketImpl: opts.WebSocketImpl,
        // The agent sends the final transcript; captions only show the words as they come.
        onCaption: text => session.emit({ type: 'user-text', text, final: false }),
        onMicLevel: level => session.emit({ type: 'mic-level', level }),
        onSpeech: () => session.emit({ type: 'user-speaking' }),
        // The user talked over the agent: drop the rest of its reply. Their voice now reaches
        // ElevenLabs, which ends the agent's turn itself.
        onBargeIn: () => cutOff?.(),
      });
      let cutOff: (() => void) | undefined;

      await new Promise<void>((resolve, reject) => {
        let inRate = RATE;
        let outRate = RATE;
        let userSpoke = false;
        let tools = 0; // tool calls running
        let muted = false; // the user tapped to cut the answer: drop the rest of its audio
        let answerTimer: ReturnType<typeof setTimeout> | undefined;
        let toolQueue = Promise.resolve();
        let settled = false;

        const send = (event: object) => ws.readyState === 1 && ws.send(JSON.stringify(event));

        const finish = async (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(answerTimer);
          signal.removeEventListener('abort', onAbort);
          await mic.close(!!error || signal.aborted);
          try {
            ws.close();
          } catch {}
          error ? reject(error) : resolve();
        };
        const onAbort = () => void finish();
        signal.addEventListener('abort', onAbort, { once: true });

        // The mic opens once the greeting has played, so it doesn't start by hearing it.
        const openMic = () => void mic.startMic(chunk => send({ user_audio_chunk: convert(chunk, RATE, inRate) })).catch(e => finish(e));

        /** The agent stopped sending audio: once it has played, it's the user's turn. */
        const answered = () => {
          if (tools > 0) return; // still acting: more speech follows the tool results
          void mic
            .drained()
            .then(() => {
              if (settled || tools > 0) return;
              openMic();
              session.emit({ type: 'agent-done' });
            })
            .catch(e => finish(e));
        };

        const runTool = (call: { tool_call_id: string; tool_name: string; parameters?: Record<string, any>; expects_response?: boolean }) => {
          tools++;
          clearTimeout(answerTimer);
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
              result = await session.runTool(call.tool_name, input);
            } catch (e) {
              result = { content: String(e), isError: true };
            }
            tools--;
            if (call.expects_response !== false) send({ type: 'client_tool_result', tool_call_id: call.tool_call_id, result: result.content, is_error: result.isError });
          });
        };

        // The app heard the user cut in: ElevenLabs is still sending the old reply until it notices.
        cutOff = () => {
          if (muted) return;
          muted = true;
          clearTimeout(answerTimer);
          session.emit({ type: 'interrupted' });
          session.emit({ type: 'user-speaking' });
        };

        session.handle({
          // There is no "cancel" message: stop playing, and ignore the rest of this answer.
          interrupt: () => {
            mic.flush();
            muted = true;
            clearTimeout(answerTimer);
            session.emit({ type: 'interrupted' });
            answered();
          },
          context: text => send({ type: 'contextual_update', text }),
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
              if (!greeting) answered();
              break;
            }
            case 'audio': {
              const chunk = event.audio_event?.audio_base_64;
              if (!chunk || muted) break;
              session.emit({ type: 'agent-audio', level: mic.play(convert(chunk, outRate, RATE)) });
              clearTimeout(answerTimer);
              answerTimer = setTimeout(answered, ANSWER_GAP_MS);
              break;
            }
            case 'agent_chat_response_part': {
              // The reply as it's written, ahead of its audio: lets its echo be recognised from the start.
              const part = event.text_response_part;
              if (part?.type === 'delta' && part.text) mic.agentSays(part.text);
              break;
            }
            case 'agent_response': {
              const text = String(event.agent_response_event?.agent_response ?? '').trim();
              if (!text) break;
              mic.agentSays(text);
              session.emit({ type: 'agent-text', text });
              break;
            }
            case 'interruption':
              // ElevenLabs heard the user talk over the agent and stopped its reply (if the app cut
              // in first, this confirms it: the next audio is a new reply).
              mic.flush();
              clearTimeout(answerTimer);
              if (!muted) session.emit({ type: 'interrupted' });
              muted = false;
              session.emit({ type: 'user-speaking' });
              break;
            case 'vad_score':
              if ((event.vad_score_event?.vad_score ?? 0) > 0.6 && !mic.speaking()) session.emit({ type: 'user-speaking' });
              break;
            case 'user_transcript': {
              const text = String(event.user_transcription_event?.user_transcript ?? '').trim();
              if (!text) break;
              userSpoke = true;
              muted = false;
              session.emit({ type: 'user-text', text, final: true });
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
