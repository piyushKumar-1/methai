// One transport for every streaming voice-agent API (Deepgram, ElevenLabs, OpenAI Realtime, …).
// They all stream mic audio up and the agent's voice down over a WebSocket, call tools that run in
// the app, and report transcripts and turns; only the message shapes differ. A provider is
// described by a VoiceAgentProtocol; this engine does the rest, the same for each.
import { base64ToBytes, bytesToBase64, floatToPcm16Base64, pcm16Base64ToFloat, resample } from './pcm';
import type { PcmAudioIO, RealtimeConnection } from './realtime';
import type { ToolCallResult } from './ScreenContextProvider';
import type { RealtimeVoiceModel } from './session';
import type { ToolSpec } from './llm';
import { voiceAudio, type VoiceInterruptions } from './voiceAudio';

const RATE = 24000; // PcmAudioIO's rate

/** What the protocol is told when a session opens. */
export interface VoiceAgentSetup {
  greeting: string;
  /** System prompt (agent rules + app context) and the live screen. */
  instructions: string;
  screen: string;
  tools: ToolSpec[];
}

export interface VoiceAgentToolCall {
  id: string;
  name: string;
  /** JSON text or an object. */
  args: unknown;
}

/** What a server message means, in the engine's terms. */
export type VoiceAgentEvent =
  /** The session is configured: mic audio may flow (sent once, if the protocol waits for it). */
  | { type: 'ready' }
  /** The audio formats the server settled on (PCM sample rates). */
  | { type: 'audio-format'; inputRate?: number; outputRate?: number }
  /** A chunk of the agent's voice (PCM16 base64 at the output rate); `replyId` groups a reply. */
  | { type: 'audio'; base64: string; replyId?: string }
  /** The agent's reply has been fully sent (its audio may still be playing). */
  | { type: 'reply-done'; cancelled?: boolean }
  /** What the agent says, as text: `partial` pieces as written, then (or only) the whole reply. */
  | { type: 'agent-text'; text: string; partial?: boolean }
  /** The user's words: live (`final: false`) or the turn's transcript. */
  | { type: 'user-text'; text: string; final: boolean }
  /** The server heard the user start talking (it stops the agent's reply). */
  | { type: 'user-speaking' }
  /** The agent wants these tools run, in order. */
  | { type: 'tool-calls'; calls: VoiceAgentToolCall[] }
  /** Messages to send back right away (e.g. pong). */
  | { type: 'send'; messages: object[] }
  | { type: 'error'; message: string; fatal?: boolean };

/**
 * A provider's WebSocket protocol, as data plus small mapping functions. See protocols/*.ts for
 * Deepgram, ElevenLabs and OpenAI Realtime.
 */
export interface VoiceAgentProtocol {
  name: string;
  /** Mic audio up: raw PCM16 binary frames, or a JSON message carrying base64 PCM16. */
  audioIn: { kind: 'binary' } | { kind: 'json'; message: (base64: string) => object };
  /** PCM sample rates until the server says otherwise. Default 24000 both ways. */
  inputRate?: number;
  outputRate?: number;
  /**
   * The opening messages. Sent when the socket opens, or when the server's `afterMessage` hello
   * arrives (e.g. Deepgram's Welcome). Audio waits for a 'ready' event if `waitForReady`.
   */
  open: { afterMessage?: (msg: any) => boolean; messages: (setup: VoiceAgentSetup) => object[]; waitForReady?: boolean };
  /** A server message (JSON) as events. Binary frames are the agent's voice. */
  parse: (msg: any) => VoiceAgentEvent[];
  /** The result of a tool call. */
  toolResult: (call: VoiceAgentToolCall, result: ToolCallResult) => object[];
  /** After a batch of tool results, to make the agent carry on (e.g. OpenAI's response.create). */
  afterToolResults?: () => object[];
  /** A typed request. */
  userText?: (text: string) => object[];
  /** A note for the agent without a reply (the screen changed…). */
  context?: (text: string) => object[];
  /** The agent was cut off after the user heard `heardMs` of reply `replyId` (cancel, truncate…). */
  interrupted?: (reply: { replyId?: string; heardMs: number }) => object[];
  /** Sent every `everyMs` so an idle connection stays open. */
  keepAlive?: { everyMs: number; message: () => object };
  /** No 'reply-done' event: a reply is over after this long without audio. */
  replyGapMs?: number;
  /** A tool the agent calls to end the conversation (answered 'ok'; the session ends after the goodbye). */
  endTool?: string;
  /** How the server's closing of the socket reads (default: fine once the user has spoken). */
  closeError?: (e: { code?: number; reason?: string }) => string;
}

export interface VoiceAgentOptions {
  /** Called per session: the provider URL, or your relay that adds the key / a signed URL. */
  connect: () => Promise<RealtimeConnection>;
  audio: PcmAudioIO;
  /** Live captions from a speech-to-text side stream (see VoiceAudioOptions.liveTranscript). */
  liveTranscript?: () => Promise<RealtimeConnection>;
  /** Overrides the assistant's `voiceInterruptions` for this transport. */
  voiceInterruptions?: VoiceInterruptions;
  /** For tests / non-RN runtimes. Defaults to the global WebSocket. */
  WebSocketImpl?: any;
}

const convert = (chunk: string, from: number, to: number) => (from === to ? chunk : floatToPcm16Base64(resample(pcm16Base64ToFloat(chunk), from, to)));

/** A binary frame from React Native (ArrayBuffer) or Node (Buffer / Uint8Array) as bytes. */
const frameBytes = (data: any): Uint8Array | null =>
  data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;

/**
 * A speech-to-speech transport for any provider described by `protocol`: the mic streams up, the
 * agent's voice streams down and plays as it arrives, tools run through the app's middleware, and
 * turns, transcripts and interruptions reach the assistant core as events. Pass a function to get a
 * fresh protocol per session.
 */
export function voiceAgentModel(protocolSource: VoiceAgentProtocol | (() => VoiceAgentProtocol), opts: VoiceAgentOptions): RealtimeVoiceModel {
  return {
    async run(session) {
      // A factory gives each session a fresh protocol (for protocols that keep per-session state).
      const protocol = typeof protocolSource === 'function' ? protocolSource() : protocolSource;
      const { signal } = session;
      const setup: VoiceAgentSetup = { greeting: session.greeting, instructions: session.instructions, screen: session.screen, tools: session.tools };
      const conn = await opts.connect();
      const WS = opts.WebSocketImpl ?? (globalThis as any).WebSocket;
      const ws = new WS(conn.url, conn.protocols ?? [], conn.headers ? { headers: conn.headers } : undefined);
      ws.binaryType = 'arraybuffer';
      let cutOff: (() => void) | undefined;
      const mic = voiceAudio(opts.audio, {
        // Read live from the session, so the user can switch between interrupting and taking turns.
        voiceInterruptions: () => opts.voiceInterruptions ?? session.voiceInterruptions,
        liveTranscript: opts.liveTranscript,
        WebSocketImpl: opts.WebSocketImpl,
        // The provider's transcript is the final one; captions only show the words as they come.
        onCaption: text => session.emit({ type: 'user-text', text, final: false }),
        onMicLevel: level => session.emit({ type: 'mic-level', level }),
        onSpeech: () => session.emit({ type: 'user-speaking' }),
        onBargeIn: () => cutOff?.(),
      });

      await new Promise<void>((resolve, reject) => {
        let inRate = protocol.inputRate ?? RATE;
        let outRate = protocol.outputRate ?? RATE;
        let ready = !protocol.open.waitForReady;
        let opened = false; // the opening messages went out
        let userSpoke = false;
        let calls = 0; // tool calls running
        let endRequested = false;
        // Cut off by the app: the rest of this reply is dropped until the server notices.
        let muted = false;
        // The reply playing, for "how much did the user hear" when it's cut off.
        let reply: { id?: string; startedAt: number; queuedMs: number } | null = null;
        let replyTimer: ReturnType<typeof setTimeout> | undefined;
        let toolQueue = Promise.resolve();
        let settled = false;
        const keepAlive = protocol.keepAlive && setInterval(() => send(protocol.keepAlive!.message()), protocol.keepAlive.everyMs);

        function send(...messages: object[]) {
          for (const m of messages) if (ws.readyState === 1) ws.send(JSON.stringify(m));
        }

        const finish = async (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(replyTimer);
          if (keepAlive) clearInterval(keepAlive);
          signal.removeEventListener('abort', onAbort);
          await mic.close(!!error || signal.aborted);
          try {
            ws.close();
          } catch {}
          error ? reject(error) : resolve();
        };
        const onAbort = () => void finish();
        signal.addEventListener('abort', onAbort, { once: true });

        const sendOpening = () => {
          if (opened) return;
          opened = true;
          send(...protocol.open.messages(setup));
        };

        // The mic opens once the greeting has played, so it doesn't start by hearing it.
        const openMic = () =>
          void mic
            .startMic(chunk => {
              if (!ready || ws.readyState !== 1) return;
              const pcm = convert(chunk, RATE, inRate);
              if (protocol.audioIn.kind === 'binary') ws.send(base64ToBytes(pcm).buffer);
              else send(protocol.audioIn.message(pcm));
            })
            .catch(e => finish(e));

        /** The reply has been sent: once it has played, it's the user's turn (or the end). */
        const answered = () => {
          if (calls > 0) return; // still acting: more speech follows the tool results
          void mic
            .drained()
            .then(() => {
              if (settled || calls > 0) return;
              reply = null;
              if (endRequested) return finish();
              openMic();
              session.emit({ type: 'agent-done' });
            })
            .catch(e => finish(e));
        };

        /** The agent stops talking now; the protocol learns how much the user heard. */
        const stopReply = () => {
          mic.flush();
          clearTimeout(replyTimer);
          const heardMs = reply ? Math.max(0, Math.min(reply.queuedMs, Date.now() - reply.startedAt)) : 0;
          if (reply && protocol.interrupted) send(...protocol.interrupted({ replyId: reply.id, heardMs: Math.round(heardMs) }));
          reply = null;
        };

        cutOff = () => {
          if (muted) return;
          muted = true;
          stopReply();
          session.emit({ type: 'interrupted' });
          session.emit({ type: 'user-speaking' });
        };

        session.handle({
          // A tap: stop the reply and hand the turn to the user.
          interrupt: () => {
            muted = true;
            stopReply();
            session.emit({ type: 'interrupted' });
            answered();
          },
          ...(protocol.context && { context: (text: string) => send(...protocol.context!(text)) }),
          ...(protocol.userText && { text: (text: string) => send(...protocol.userText!(text)) }),
        });

        const runTools = (batch: VoiceAgentToolCall[]) => {
          calls += batch.length;
          clearTimeout(replyTimer);
          toolQueue = toolQueue.then(async () => {
            for (const call of batch) {
              let result: ToolCallResult;
              if (protocol.endTool && call.name === protocol.endTool) {
                endRequested = true;
                result = { isError: false, content: 'ok' };
              } else {
                let input: unknown = call.args;
                if (typeof input === 'string') {
                  try {
                    input = JSON.parse(input || '{}');
                  } catch {}
                }
                try {
                  result = await session.runTool(call.name, input);
                } catch (e) {
                  result = { isError: true, content: String(e) };
                }
              }
              calls--;
              send(...protocol.toolResult(call, result));
            }
            if (protocol.afterToolResults) send(...protocol.afterToolResults());
          });
        };

        const handle = (event: VoiceAgentEvent) => {
          switch (event.type) {
            case 'ready':
              ready = true;
              // No greeting: the agent waits for the user.
              if (!setup.greeting) answered();
              break;
            case 'audio-format':
              inRate = event.inputRate ?? inRate;
              outRate = event.outputRate ?? outRate;
              break;
            case 'audio': {
              if (muted && event.replyId && event.replyId !== reply?.id) muted = false; // a new reply
              if (muted || !event.base64) break;
              const pcm = convert(event.base64, outRate, RATE);
              if (!reply || (event.replyId && event.replyId !== reply.id)) reply = { id: event.replyId, startedAt: Date.now(), queuedMs: 0 };
              // PCM16 mono 24 kHz: 48 bytes per ms, 4 base64 characters per 3 bytes.
              reply.queuedMs += (pcm.length * 3) / 4 / 48;
              session.emit({ type: 'agent-audio', level: mic.play(pcm) });
              if (protocol.replyGapMs) {
                clearTimeout(replyTimer);
                replyTimer = setTimeout(answered, protocol.replyGapMs);
              }
              break;
            }
            case 'reply-done':
              if (!event.cancelled) answered();
              break;
            case 'agent-text':
              mic.agentSays(event.text);
              if (!event.partial) session.emit({ type: 'agent-text', text: event.text });
              break;
            case 'user-text':
              if (event.final) {
                userSpoke = true;
                muted = false;
              }
              session.emit(event);
              break;
            case 'user-speaking':
              // The server heard the user talk over the agent and stopped its reply (if the app cut
              // in first, this confirms it: the next audio is a new reply).
              if (!muted && reply) {
                stopReply();
                session.emit({ type: 'interrupted' });
              } else mic.flush();
              muted = false;
              session.emit({ type: 'user-speaking' });
              break;
            case 'tool-calls':
              if (event.calls.length) runTools(event.calls);
              break;
            case 'send':
              send(...event.messages);
              break;
            case 'error':
              if (event.fatal !== false) void finish(new Error(`${protocol.name}: ${event.message}`));
              break;
          }
        };

        ws.onopen = () => {
          if (!protocol.open.afterMessage) sendOpening();
        };
        ws.onerror = (e: any) => void finish(new Error(`${protocol.name} connection error${e?.message ? `: ${e.message}` : ''}`));
        ws.onclose = (e: any) => {
          // The agent hangs up by closing the socket; let the goodbye finish playing.
          if (settled) return;
          if (userSpoke) void finish();
          else void finish(new Error(protocol.closeError?.(e) ?? `${protocol.name} connection closed (${e?.code ?? '?'}) ${e?.reason ?? ''}`.trim()));
        };
        ws.onmessage = (msg: { data: any }) => {
          const bytes = typeof msg.data === 'string' ? null : frameBytes(msg.data);
          if (bytes) {
            if (bytes.length) handle({ type: 'audio', base64: bytesToBase64(bytes) });
            return;
          }
          let parsed: any;
          try {
            parsed = JSON.parse(String(msg.data));
          } catch {
            return;
          }
          if (!opened && protocol.open.afterMessage?.(parsed)) sendOpening();
          for (const event of protocol.parse(parsed)) handle(event);
        };
      });
    },
  };
}
