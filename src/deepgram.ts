import { base64ToBytes, bytesToBase64 } from './pcm';
import type { PcmAudioIO, RealtimeConnection } from './realtime';
import type { RealtimeVoiceModel } from './session';
import { voiceAudio, type VoiceInterruptions } from './voiceAudio';

export interface DeepgramAgentOptions {
  /**
   * Called per session. Return your relay to wss://agent.deepgram.com/v1/agent/converse that adds
   * `Authorization: Token <key>` (keeps the API key off the device; see the demo server's
   * /deepgram/agent), or a URL with a short-lived token.
   */
  connect: () => Promise<RealtimeConnection>;
  audio: PcmAudioIO;
  /** Speech recognition. Default `{ type: 'deepgram', model: 'nova-3' }`. */
  listen?: Record<string, unknown>;
  /** The LLM that calls the screen tools. Default `{ type: 'open_ai', model: 'gpt-4o-mini' }` (run by Deepgram). */
  think?: Record<string, unknown>;
  /** The voice. Default `{ type: 'deepgram', model: 'aura-2-thalia-en' }`. */
  speak?: Record<string, unknown>;
  /** e.g. 'en', 'hi'. Default: Deepgram's ('en'). */
  language?: string;
  /** Live captions from a speech-to-text side stream (see ElevenLabsAgentOptions.liveTranscript). */
  liveTranscript?: () => Promise<RealtimeConnection>;
  /** Overrides the assistant's `voiceInterruptions` for this transport. */
  voiceInterruptions?: VoiceInterruptions;
  /** For tests / non-RN runtimes. Defaults to the global WebSocket. */
  WebSocketImpl?: any;
}

const RATE = 24000; // PcmAudioIO's rate; both directions stream raw PCM16 at it
/** Sent while no audio flows (before the mic opens), so the connection isn't closed as idle. */
const KEEPALIVE_MS = 5000;

/** A binary frame from React Native (ArrayBuffer) or Node (Buffer / Uint8Array) as bytes. */
const frameBytes = (data: any): Uint8Array | null =>
  data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;

/**
 * A conversation with a Deepgram Voice Agent (wss://agent.deepgram.com/v1/agent/converse). The
 * mic streams up as raw PCM and the agent's voice streams back as raw PCM as it is spoken;
 * Deepgram does the speech recognition, turn-taking and voice, and its LLM calls the screen tools,
 * which run here (client-side functions). This is only the protocol: timeouts, stop phrases,
 * confirmations and captions are the assistant's (see RealtimeSession).
 */
export function deepgramAgentModel(opts: DeepgramAgentOptions): RealtimeVoiceModel {
  return {
    async run(session) {
      const { greeting, screen, instructions, tools, signal } = session;
      const conn = await opts.connect();
      const WS = opts.WebSocketImpl ?? (globalThis as any).WebSocket;
      const ws = new WS(conn.url, conn.protocols ?? [], conn.headers ? { headers: conn.headers } : undefined);
      ws.binaryType = 'arraybuffer';
      let cutOff: (() => void) | undefined;
      const mic = voiceAudio(opts.audio, {
        voiceInterruptions: opts.voiceInterruptions ?? session.voiceInterruptions,
        liveTranscript: opts.liveTranscript,
        WebSocketImpl: opts.WebSocketImpl,
        onCaption: text => session.emit({ type: 'user-text', text, final: false }),
        onMicLevel: level => session.emit({ type: 'mic-level', level }),
        onSpeech: () => session.emit({ type: 'user-speaking' }),
        onBargeIn: () => cutOff?.(),
      });

      await new Promise<void>((resolve, reject) => {
        let ready = false; // Settings applied: audio may flow
        let userSpoke = false;
        let calls = 0; // function calls running
        let muted = false; // cut off by the app: drop the rest of this reply until Deepgram notices
        let toolQueue = Promise.resolve();
        let settled = false;
        const keepAlive = setInterval(() => send({ type: 'KeepAlive' }), KEEPALIVE_MS);

        function send(message: object) {
          if (ws.readyState === 1) ws.send(JSON.stringify(message));
        }

        const finish = async (error?: Error) => {
          if (settled) return;
          settled = true;
          clearInterval(keepAlive);
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
        const openMic = () =>
          void mic
            .startMic(chunk => {
              if (ready && ws.readyState === 1) ws.send(base64ToBytes(chunk).buffer);
            })
            .catch(e => finish(e));

        /** The reply has finished playing: it's the user's turn. */
        const answered = () => {
          if (calls > 0) return; // still acting: more speech follows the function results
          void mic
            .drained()
            .then(() => {
              if (settled || calls > 0) return;
              openMic();
              session.emit({ type: 'agent-done' });
            })
            .catch(e => finish(e));
        };

        cutOff = () => {
          if (muted) return;
          muted = true;
          session.emit({ type: 'interrupted' });
          session.emit({ type: 'user-speaking' });
        };

        session.handle({
          interrupt: () => {
            mic.flush();
            muted = true;
            session.emit({ type: 'interrupted' });
            answered();
          },
          // Added to the agent's instructions for the rest of the conversation.
          context: text => send({ type: 'UpdatePrompt', prompt: text }),
          text: text => send({ type: 'InjectUserMessage', content: text }),
        });

        const runFunction = (call: { id: string; name: string; arguments: string; client_side?: boolean }) => {
          if (call.client_side === false) return; // run by Deepgram
          calls++;
          toolQueue = toolQueue.then(async () => {
            let input: unknown;
            try {
              input = JSON.parse(call.arguments || '{}');
            } catch {
              input = call.arguments;
            }
            let result: { content: string; isError: boolean };
            try {
              result = await session.runTool(call.name, input);
            } catch (e) {
              result = { content: String(e), isError: true };
            }
            calls--;
            send({ type: 'FunctionCallResponse', id: call.id, name: call.name, content: result.content });
          });
        };

        ws.onerror = (e: any) => void finish(new Error(`Deepgram connection error${e?.message ? `: ${e.message}` : ''}`));
        ws.onclose = (e: any) => {
          if (settled) return;
          if (userSpoke) void finish();
          else void finish(new Error(`Deepgram connection closed (${e?.code ?? '?'}) ${e?.reason ?? ''}`.trim()));
        };

        ws.onmessage = (msg: { data: any }) => {
          const bytes = typeof msg.data === 'string' ? null : frameBytes(msg.data);
          if (bytes) {
            // The agent's voice, streamed as it is spoken.
            if (!muted && bytes.length) session.emit({ type: 'agent-audio', level: mic.play(bytesToBase64(bytes)) });
            return;
          }
          let event: any;
          try {
            event = JSON.parse(String(msg.data));
          } catch {
            return;
          }
          switch (event.type) {
            case 'Welcome':
              send({
                type: 'Settings',
                audio: {
                  input: { encoding: 'linear16', sample_rate: RATE },
                  output: { encoding: 'linear16', sample_rate: RATE, container: 'none' },
                },
                agent: {
                  ...(opts.language && { language: opts.language }),
                  listen: { provider: opts.listen ?? { type: 'deepgram', model: 'nova-3' } },
                  think: {
                    provider: opts.think ?? { type: 'open_ai', model: 'gpt-4o-mini' },
                    prompt: `${instructions}\n\nCurrent screen:\n${screen}`,
                    functions: tools.map(t => ({ name: t.name, description: t.description, parameters: t.schema })),
                  },
                  speak: { provider: opts.speak ?? { type: 'deepgram', model: 'aura-2-thalia-en' } },
                  ...(greeting && { greeting }),
                },
              });
              break;
            case 'SettingsApplied':
              ready = true;
              // No greeting: the agent waits for the user.
              if (!greeting) answered();
              break;
            case 'ConversationText': {
              const text = String(event.content ?? '').trim();
              if (!text) break;
              if (event.role === 'user') {
                userSpoke = true;
                muted = false;
                session.emit({ type: 'user-text', text, final: true });
              } else {
                mic.agentSays(text);
                session.emit({ type: 'agent-text', text });
              }
              break;
            }
            case 'UserStartedSpeaking':
              // Deepgram heard the user talk over the agent and stopped its reply (if the app cut in
              // first, this confirms it: the next audio is a new reply).
              if (!muted && mic.speaking()) session.emit({ type: 'interrupted' });
              mic.flush();
              muted = false;
              session.emit({ type: 'user-speaking' });
              break;
            case 'FunctionCallRequest':
              for (const call of event.functions ?? []) runFunction(call);
              break;
            case 'AgentAudioDone':
              answered();
              break;
            case 'Error':
              void finish(new Error(event.description || event.message || `Deepgram error ${event.code ?? ''}`.trim()));
              break;
          }
        };
      });
    },
  };
}
