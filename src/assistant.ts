import { runAgent, runAgentFollowUp, type AgentModel } from './agent';
import { buildInstructions, SCREEN_TOOLS, type AppContext, type ToolSpec } from './llm';
import type { ScreenContextController, ToolCallResult } from './ScreenContextProvider';

/** Speech-to-text + text-to-speech, e.g. on-device recognizers (see example/voice-adapters.ts). */
export interface VoiceIO {
  speak(text: string, signal: AbortSignal): Promise<void>;
  /**
   * Listens until the user stops talking and resolves with the final transcript ('' if nothing).
   * `onLevel` takes the mic loudness (0–1) for visuals, if the engine reports it.
   */
  listen(signal: AbortSignal, onPartial?: (text: string) => void, onLevel?: (level: number) => void): Promise<string>;
  /** Optional: loudness (0–1) of the speech being played, for visuals. */
  onSpeakingLevel?: (listener: (level: number) => void) => () => void;
}

/**
 * Speech-to-speech model session (realtime voice APIs). It owns the mic and speaker, greets the
 * user, and calls `onToolCall` for screen actions; it resolves when the exchange is over.
 */
export interface RealtimeVoiceModel {
  run(session: {
    greeting: string;
    screen: string;
    /** System prompt: agent rules + app context. */
    instructions: string;
    tools: ToolSpec[];
    onToolCall: (name: string, input: unknown) => Promise<ToolCallResult>;
    /** Report listening / thinking / speaking so the UI can follow along. */
    setState?: (state: AssistantState) => void;
    onTranscript?: (text: string) => void;
    /** Mic or model loudness (0–1), for visuals. */
    onLevel?: (level: number) => void;
    /** 'continuous': keep the session open after each answer until the user is done. */
    conversation: ConversationMode;
    /** True for utterances like "stop", "that's all", "thanks, bye". */
    isStopPhrase: (text: string) => boolean;
    /** Register what to do when the user taps to cut the model off mid-answer. */
    onInterrupt: (handler: () => void) => void;
    signal: AbortSignal;
  }): Promise<void>;
}

/**
 * 'continuous' (default): after every answer the assistant listens again, until the user says a
 * stop phrase, stays silent, or taps the button. 'single': one request; it listens again only when
 * the answer is a question.
 */
export type ConversationMode = 'continuous' | 'single';

export const DEFAULT_STOP_PHRASES = [
  'stop', 'stop listening', "that's all", 'that is all', "that's it", 'thanks', 'thank you', 'bye', 'goodbye',
  'good bye', 'never mind', 'nevermind', 'cancel', "i'm done", 'done', 'nothing', 'no thanks', 'exit', 'close',
];

const normalize = (t: string) => t.toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();

const FILLER = new Set(['so', 'much', 'very', 'bye', 'for', 'now', 'then', 'please', 'you', 'a', 'lot', 'again', 'all', 'ok', 'okay']);

/** Matches short closing utterances only, so "stop the timer" or "cancel my order" are still requests. */
export function isStopPhrase(text: string, phrases: string[] = DEFAULT_STOP_PHRASES): boolean {
  const t = normalize(text).replace(/^(ok|okay|alright|no|great|cool|perfect)\s+/, '');
  if (!t || t.split(' ').length > 5) return false;
  return phrases.some(p => {
    const n = normalize(p);
    let rest: string | null = null;
    if (t === n) rest = '';
    else if (t.startsWith(`${n} `)) rest = t.slice(n.length + 1);
    else if (t.endsWith(` ${n}`)) rest = t.slice(0, -n.length - 1);
    // Whatever surrounds the phrase must be filler ("thank you so much", "bye bye").
    return rest !== null && rest.split(' ').every(w => !w || FILLER.has(w));
  });
}

export type AssistantConfig = {
  /** Spoken when the assistant is triggered. Default "How can I help?" */
  greeting?: string;
  /** What the app is, its screens and flows; added to the system prompt. */
  app?: AppContext;
  /** Replaces the built-in agent rules (the app context is still appended). */
  systemPrompt?: string;
  /** Spoken when nothing was heard. Default: stays silent and goes idle. */
  noInputReply?: string;
  maxSteps?: number;
  /** Default 'continuous'. */
  conversation?: ConversationMode;
  /** Utterances that end a continuous conversation. Default DEFAULT_STOP_PHRASES. */
  stopPhrases?: string[];
  /** Spoken when the user ends the conversation. Default "Okay." */
  farewell?: string;
  /** Safety cap on user turns per session. Default 30. */
  maxTurns?: number;
  /** 'single' mode: when an answer ends with a question, listen for the reply up to this many times. Default 3. */
  maxFollowUps?: number;
} & ({ voice: VoiceIO; model: AgentModel } | { realtime: RealtimeVoiceModel });

export type AssistantState = 'idle' | 'greeting' | 'listening' | 'thinking' | 'speaking';

export interface AssistantStatus {
  state: AssistantState;
  /** Live transcript while listening, then the final one. */
  transcript: string;
  error?: string;
}

/** Voice-first assistant: greet → listen → act on the screen → speak → (listen again…) → idle. */
export class VoiceAssistant {
  private status: AssistantStatus = { state: 'idle', transcript: '' };
  private abort: AbortController | null = null;
  private interruptHandler: (() => void) | null = null;
  private listeners = new Set<(s: AssistantStatus) => void>();

  constructor(
    private readonly controller: ScreenContextController,
    /** A config, or a getter read at the start of every session (so it can change at runtime). */
    private readonly configSource: AssistantConfig | (() => AssistantConfig),
  ) {}

  private get config(): AssistantConfig {
    return typeof this.configSource === 'function' ? this.configSource() : this.configSource;
  }

  getStatus(): AssistantStatus {
    return this.status;
  }

  subscribe(listener: (s: AssistantStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(patch: Partial<AssistantStatus>) {
    // Skip no-op updates: realtime models report state per audio chunk, and every notify re-renders subscribers.
    if ((Object.keys(patch) as (keyof AssistantStatus)[]).every(k => this.status[k] === patch[k])) return;
    if (patch.state && patch.state !== this.status.state) {
      this.controller.reportVoice(patch.state === 'greeting' ? 'speaking' : patch.state);
    }
    this.status = { ...this.status, ...patch };
    for (const l of [...this.listeners]) l(this.status);
  }

  /**
   * One button for everything: idle → start; speaking → cut the answer short and listen;
   * otherwise → end the session.
   */
  toggle(): void {
    if (!this.abort) void this.start();
    else if (this.status.state === 'speaking' && this.interruptHandler) this.interrupt();
    else this.cancel();
  }

  /** Stops the current spoken answer (the session continues and listens). */
  interrupt(): void {
    this.interruptHandler?.();
  }

  cancel(): void {
    this.abort?.abort();
  }

  private voicePhase() {
    const s = this.status.state;
    return s === 'greeting' ? 'speaking' : s;
  }

  /** Speaks, but can be cut short with interrupt() without ending the session. */
  private async speak(voice: VoiceIO, text: string, signal: AbortSignal): Promise<void> {
    const offLevel = voice.onSpeakingLevel?.(level => this.controller.reportVoice('speaking', level));
    const speech = new AbortController();
    const onAbort = () => speech.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    this.interruptHandler = () => speech.abort();
    try {
      await voice.speak(text, speech.signal);
    } finally {
      offLevel?.();
      this.interruptHandler = null;
      signal.removeEventListener('abort', onAbort);
    }
  }

  async start(): Promise<void> {
    if (this.abort) return;
    const abort = new AbortController();
    this.abort = abort;
    const { signal } = abort;
    const config = this.config;
    const greeting = config.greeting ?? 'How can I help?';
    this.controller.setActive(true);
    this.set({ state: 'greeting', transcript: '', error: undefined });
    this.interruptHandler = null;
    try {
      // Capture before the user speaks: this is the screen they are asking about.
      const screen = await this.controller.describe();

      const conversation = config.conversation ?? 'continuous';
      const stop = (text: string) => isStopPhrase(text, config.stopPhrases);

      if ('realtime' in config) {
        this.set({ state: 'listening' });
        await config.realtime.run({
          greeting,
          screen,
          instructions: buildInstructions(config.app, config.systemPrompt),
          tools: SCREEN_TOOLS,
          onToolCall: (name, input) => {
            this.set({ state: 'thinking' });
            return this.controller.executeToolCall(name, input);
          },
          setState: state => this.set({ state }),
          onTranscript: transcript => this.set({ transcript }),
          onLevel: level => this.controller.reportVoice(this.voicePhase(), level),
          conversation,
          isStopPhrase: stop,
          onInterrupt: handler => (this.interruptHandler = handler),
          signal,
        });
        return;
      }

      const { voice, model } = config;
      const opts = { signal, maxSteps: config.maxSteps, app: config.app, systemPrompt: config.systemPrompt };
      const listen = async () => {
        this.set({ state: 'listening', transcript: '' });
        const heard = (
          await voice.listen(
            signal,
            partial => this.set({ transcript: partial }),
            level => this.controller.reportVoice('listening', level),
          )
        ).trim();
        this.set({ transcript: heard });
        return heard;
      };

      this.set({ state: 'greeting' });
      await this.speak(voice, greeting, signal);
      let answer = '';
      for (let turn = 0; turn < (config.maxTurns ?? 30); turn++) {
        if (turn > 0) {
          const keepListening = conversation === 'continuous' || (answer.trim().endsWith('?') && turn <= (config.maxFollowUps ?? 3));
          if (!keepListening) break;
        }
        const request = await listen();
        if (!request) {
          if (turn === 0 && config.noInputReply) await this.speak(voice, config.noInputReply, signal);
          break;
        }
        if (stop(request)) {
          this.set({ state: 'speaking' });
          await this.speak(voice, config.farewell ?? 'Okay.', signal);
          break;
        }
        this.set({ state: 'thinking' });
        // Later turns continue the same conversation, so "and one more" or "yes" make sense.
        answer =
          turn === 0 || !model.followUp
            ? await runAgent(this.controller, model, request, { ...opts, screen: turn === 0 ? screen : undefined })
            : await runAgentFollowUp(this.controller, model, request, opts);
        if (answer) {
          this.set({ state: 'speaking' });
          await this.speak(voice, answer, signal);
        }
      }
    } catch (e: any) {
      if (!signal.aborted) this.set({ error: e?.message ?? String(e) });
    } finally {
      this.abort = null;
      this.controller.setActive(false);
      this.set({ state: 'idle' });
    }
  }
}
