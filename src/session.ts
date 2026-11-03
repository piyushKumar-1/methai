// The contract between the assistant core and voice transports (OpenAI Realtime, ElevenLabs
// agents, …). A transport only speaks its protocol: it reports what happens as events and runs
// tools through `runTool`. Behaviour (turn timeouts, stop phrases, taps, captions, confirmations,
// screen-change notes, tracing) lives in the core, the same for every transport.
import type { ToolSpec } from './llm';
import type { ToolCallResult } from './ScreenContextProvider';
import type { VoiceInterruptions } from './voiceAudio';

/** What a transport reports while a session runs. */
export type RealtimeEvent =
  /** The agent's voice is playing (`level` 0–1 for visuals). */
  | { type: 'agent-audio'; level?: number }
  /** The agent's reply (or greeting) has finished playing: it's the user's turn. */
  | { type: 'agent-done' }
  /** What the agent said, as text (final, per reply). */
  | { type: 'agent-text'; text: string }
  /** The user started talking (voice activity), before any words are known. */
  | { type: 'user-speaking' }
  /** The user's words: live while they talk (`final: false`), then the turn's final transcript. */
  | { type: 'user-text'; text: string; final: boolean }
  /** Mic loudness (0–1), for visuals. */
  | { type: 'mic-level'; level: number }
  /** The agent was cut off; `heard` is what the user heard of the reply, if known. */
  | { type: 'interrupted'; heard?: string };

/** What the core may ask of a running session. */
export interface RealtimeControls {
  /** The user tapped to cut the agent off: stop playing its reply. */
  interrupt?(): void;
  /** Tell the agent something without a reply (e.g. the user changed the screen themselves). */
  context?(text: string): void;
}

/** One voice session, as the core hands it to a transport. Resolve `run` when it's over. */
export interface RealtimeSession {
  greeting: string;
  /** The screen when the session started, and the system prompt (agent rules + app context). */
  screen: string;
  instructions: string;
  tools: ToolSpec[];
  /** Runs a tool call through the app's tool middleware (confirmations, tracing…). */
  runTool(name: string, input: unknown): Promise<ToolCallResult>;
  emit(event: RealtimeEvent): void;
  /** Register what the session can do on request (interrupt, context updates). */
  handle(controls: RealtimeControls): void;
  /** How the user can cut the agent off by talking (see VoiceInterruptions). */
  voiceInterruptions: VoiceInterruptions;
  /** Aborted when the session ends (the user closed it, a stop phrase, silence…). */
  signal: AbortSignal;
}

/** Speech-to-speech transport: owns the mic, speaker and connection for one session at a time. */
export interface RealtimeVoiceModel {
  run(session: RealtimeSession): Promise<void>;
}

export type SessionEndReason = 'user' | 'stop-phrase' | 'silence' | 'agent' | 'error' | 'max-turns';

/** Everything that happens in the assistant, the same for every kind of assistant: for logs and debugging. */
export type AssistantEvent =
  | { type: 'session-start'; kind: 'chat' | 'realtime'; resumed: boolean }
  | { type: 'state'; state: string }
  | { type: 'user'; text: string }
  | { type: 'agent'; text: string }
  | { type: 'tool'; name: string; input: unknown; result: ToolCallResult; ms: number }
  | { type: 'interrupted'; heard?: string }
  | { type: 'context'; text: string }
  | { type: 'session-end'; reason: SessionEndReason; error?: string };

/** One readable line per event, for logcat / console. */
export function describeEvent(e: AssistantEvent): string {
  switch (e.type) {
    case 'session-start':
      return `session start (${e.kind}${e.resumed ? ', resumed' : ''})`;
    case 'state':
      return `state ${e.state}`;
    case 'user':
      return `user: ${JSON.stringify(e.text)}`;
    case 'agent':
      return `agent: ${JSON.stringify(e.text)}`;
    case 'tool':
      return `tool ${e.name}(${typeof e.input === 'string' ? e.input : JSON.stringify(e.input)}) ${e.result.isError ? 'FAILED' : 'ok'} in ${e.ms}ms: ${e.result.content.split('\n', 1)[0]}`;
    case 'interrupted':
      return `interrupted${e.heard !== undefined ? `, heard ${JSON.stringify(e.heard)}` : ''}`;
    case 'context':
      return `context: ${e.text.split('\n', 1)[0]}`;
    case 'session-end':
      return `session end: ${e.reason}${e.error ? ` (${e.error})` : ''}`;
  }
}
