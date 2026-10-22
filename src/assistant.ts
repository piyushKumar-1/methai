import { runAgent, runAgentFollowUp, type AgentModel } from './agent';
import { buildInstructions, SCREEN_TOOLS, type AppContext, type ToolSpec } from './llm';
import type { ScreenContextController, ToolCallResult } from './ScreenContextProvider';

/** Speech-to-text + text-to-speech, e.g. on-device recognizers (see example/voice-adapters.ts). */
export interface VoiceIO {
  speak(text: string, signal: AbortSignal): Promise<void>;
  /** Listens until the user stops talking and resolves with the final transcript ('' if nothing). */
  listen(signal: AbortSignal, onPartial?: (text: string) => void): Promise<string>;
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
    signal: AbortSignal;
  }): Promise<void>;
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
  /** When an answer ends with a question, listen for the reply up to this many times. Default 3. */
  maxFollowUps?: number;
} & ({ voice: VoiceIO; model: AgentModel } | { realtime: RealtimeVoiceModel });

export type AssistantState = 'idle' | 'greeting' | 'listening' | 'thinking' | 'speaking';

export interface AssistantStatus {
  state: AssistantState;
  /** Live transcript while listening, then the final one. */
  transcript: string;
  error?: string;
}

/** One-shot, voice-first assistant: greet → listen → act on the screen → speak the answer → idle. */
export class VoiceAssistant {
  private status: AssistantStatus = { state: 'idle', transcript: '' };
  private abort: AbortController | null = null;
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
    this.status = { ...this.status, ...patch };
    for (const l of [...this.listeners]) l(this.status);
  }

  /** Starts a session, or cancels the running one (so one button can do both). */
  toggle(): void {
    if (this.abort) this.cancel();
    else void this.start();
  }

  cancel(): void {
    this.abort?.abort();
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
    try {
      // Capture before the user speaks: this is the screen they are asking about.
      const screen = await this.controller.describe();

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
          signal,
        });
        return;
      }

      const { voice, model } = config;
      await voice.speak(greeting, signal);
      this.set({ state: 'listening' });
      const request = (await voice.listen(signal, partial => this.set({ transcript: partial }))).trim();
      this.set({ transcript: request });
      if (!request) {
        if (config.noInputReply) {
          this.set({ state: 'speaking' });
          await voice.speak(config.noInputReply, signal);
        }
        return;
      }

      this.set({ state: 'thinking' });
      const opts = { signal, maxSteps: config.maxSteps, app: config.app, systemPrompt: config.systemPrompt };
      let answer = await runAgent(this.controller, model, request, { ...opts, screen });
      // Voice-first, not chat: only keep listening when the model asked something (e.g. "Should I check out?").
      for (let round = 0; ; round++) {
        if (!answer) break;
        this.set({ state: 'speaking' });
        await voice.speak(answer, signal);
        if (!answer.trim().endsWith('?') || !model.followUp || round >= (config.maxFollowUps ?? 3)) break;
        this.set({ state: 'listening', transcript: '' });
        const reply = (await voice.listen(signal, partial => this.set({ transcript: partial }))).trim();
        if (!reply) break;
        this.set({ state: 'thinking', transcript: reply });
        answer = await runAgentFollowUp(this.controller, model, reply, opts);
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
