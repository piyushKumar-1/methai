import { runAgent, runAgentFollowUp, type AgentModel, type UserRequest } from './agent';
import { buildInstructions, SCREEN_TOOLS, type AppContext } from './llm';
import type { ScreenContextController, ToolCallResult } from './ScreenContextProvider';
import type { AssistantEvent, RealtimeControls, RealtimeVoiceModel, SessionEndReason } from './session';
import { endOfTurnDelay, type EndOfTurnOptions } from './speech';
import { composeTools, confirmBefore, type ConfirmOptions, type ToolContext, type ToolMiddleware } from './tools';
import type { VoiceInterruptions } from './voiceAudio';

export interface ListenOptions {
  /** Silence (ms) after `transcript` that ends the user's turn: short when it sounds finished. */
  endOfTurnDelay?: (transcript: string) => number;
}

export interface SpeakOptions {
  /**
   * False: the user has chosen to take turns, so don't listen for them talking over this (a tap
   * still cuts it off). Default true.
   */
  interruptible?: boolean;
}

export interface SpeakResult {
  /** The user stopped it by voice (a stop word while it talked). */
  interrupted?: boolean;
  /** Characters of the text spoken before it stopped (through the word being said), if known. */
  spokenChars?: number;
}

/** Speech-to-text + text-to-speech, e.g. on-device recognizers (see example/voice-adapters.ts). */
export interface VoiceIO {
  /** Resolves when done or cut off; report a voice interruption and how far it got, if known. */
  speak(text: string, signal: AbortSignal, options?: SpeakOptions): Promise<void | SpeakResult>;
  /**
   * Listens until the user stops talking and resolves with the final transcript ('' if nothing).
   * `onLevel` takes the mic loudness (0–1) for visuals, if the engine reports it. End the turn
   * after `options.endOfTurnDelay(transcript)` of silence when given.
   */
  listen(signal: AbortSignal, onPartial?: (text: string) => void, onLevel?: (level: number) => void, options?: ListenOptions): Promise<string | HeardSpeech>;
  /** Optional: loudness (0–1) of the speech being played, for visuals. */
  onSpeakingLevel?: (listener: (level: number) => void) => () => void;
}

/** What the recognizer heard: its best guess, plus the other guesses it considered. */
export interface HeardSpeech {
  text: string;
  /** Other readings ("to know my office", "to know Atri office"), given to the model to resolve mishearings. */
  alternatives?: string[];
  /**
   * The recording itself (base64), for models that hear speech (e.g. xor-* over chat
   * completions): they get the audio, with `text` as the on-device reading.
   */
  audio?: { data: string; format: 'wav' | 'mp3' };
}

/**
 * The request as the model gets it: the best guess, plus the recognizer's other guesses when it
 * had any, so a misheard name can be worked out ("to know my three office" → "Namma Yatri office").
 */
export function requestWithAlternatives(heard: HeardSpeech): string {
  const seen = new Set([heard.text.trim().toLowerCase()]);
  const others = (heard.alternatives ?? [])
    .map(a => a.trim())
    .filter(a => a && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()))
    .slice(0, 3);
  return others.length ? `${heard.text}\n(Speech recognition, other possible readings: ${others.map(a => JSON.stringify(a)).join(', ')})` : heard.text;
}

/**
 * 'continuous' (default): after every answer the assistant listens again, until the user says a
 * stop phrase, stays silent, or taps the button. 'single': one request; it listens again only when
 * the answer is a question.
 */
export type ConversationMode = 'continuous' | 'single';

// Words that are also requests in many apps ("cancel" a ride, "close" a ticket, "done" a task)
// are left out, so they reach the model instead of ending the conversation.
export const DEFAULT_STOP_PHRASES = [
  'stop', 'stop listening', "that's all", 'that is all', "that's it", 'thanks', 'thank you', 'bye', 'goodbye',
  'good bye', 'never mind', 'nevermind', "i'm done", 'no thanks', 'exit',
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

/** What the assistant knows when a session starts, for choosing how to open it. */
export interface SessionStart {
  /** The screen the user is on (as the model sees it). */
  screen: string;
  /** True when this session picks up the previous conversation (see `resumeWithinMs`). */
  resumed: boolean;
}

/** One line of the conversation, for captions or a transcript. */
export interface AssistantMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** Asked of the model when it should open the session itself (a `greeting` function returned undefined). */
export const OPENING_REQUEST =
  "(The user just opened the voice assistant; they haven't said anything yet. Don't act on the screen. " +
  'Say one short line, under ten words: if the conversation so far is unfinished and still fits the current screen, pick it up from there; ' +
  'otherwise ask briefly what they need here.)';

const MAX_LOG = 50;

const screenTitle = (description: string) => description.split('\n', 1)[0]?.replace(/^Screen:\s*/, '').trim() ?? '';

/**
 * Tells the model the screen changed while it wasn't acting, so it goes by the current screen
 * instead of carrying on with the old task. Who changed it isn't known: the user may have tapped
 * around, or the model's own last action finished loading (a booking moving on to "looking for a
 * driver"); saying it was the user made models doubt actions that had worked.
 */
export function screenChangeNote(lastSeen: string, now: string): string {
  const was = screenTitle(lastSeen);
  const is = screenTitle(now);
  if (!was || !is || was === is) return '';
  return (
    `(The screen changed since you last acted: it was "${was}", now it is "${is}". ` +
    'Your last action may have finished loading, or the user moved on; go by the current screen.)'
  );
}

export type AssistantConfig = {
  /**
   * Spoken when the assistant is triggered. A function decides per session: return the line to
   * say, or undefined to let the model open from the screen and the conversation so far.
   * Default "How can I help?"
   */
  greeting?: string | ((session: SessionStart) => string | undefined);
  /**
   * Reopening the assistant within this long continues the previous conversation (history and
   * all) instead of starting over. Default 0: every session starts fresh.
   */
  resumeWithinMs?: number;
  /**
   * Speak text the model sends along with tool calls ("Sure, finding autos…") while it keeps
   * working. Default false: only answers are spoken.
   */
  speakProgress?: boolean;
  /**
   * 'continuous' conversations: end the session when the user says nothing. Default true; false
   * keeps listening until the user closes it (button or stop phrase).
   */
  endOnSilence?: boolean;
  /** What the app is, its screens and flows; added to the system prompt. */
  app?: AppContext;
  /** Replaces the built-in agent rules (the app context is still appended). */
  systemPrompt?: string;
  /**
   * Who the user is, read at the start of every session: saved places, recent trips or orders,
   * preferences… The model uses it to understand what they mean, including names the speech
   * recognizer got wrong. Keep it short; it goes into the system prompt.
   */
  userContext?: () => string | undefined | Promise<string | undefined>;
  /** Spoken when nothing was heard. Default: stays silent and goes idle. */
  noInputReply?: string;
  maxSteps?: number;
  /** Default 'continuous'. */
  conversation?: ConversationMode;
  /** Utterances that end a continuous conversation. Default DEFAULT_STOP_PHRASES. */
  stopPhrases?: string[];
  /** Spoken when the user ends the conversation. Default "Okay." */
  farewell?: string;
  /** Said when a turn fails (e.g. the model is unreachable) before listening again. Default "Sorry, I couldn't do that. Please say it again." */
  errorReply?: string;
  /** Safety cap on user turns per session. Default 30. */
  maxTurns?: number;
  /** 'single' mode: when an answer ends with a question, listen for the reply up to this many times. Default 3. */
  maxFollowUps?: number;
  /** How long a pause ends the user's turn (word-aware: longer after "and…", "um…", digits). */
  endOfTurn?: EndOfTurnOptions;
  /**
   * Controls that must not be pressed without the user's yes (pay, book, delete…), for every kind
   * of assistant: a press the user hasn't agreed to is refused and the model is told to ask.
   */
  confirm?: ConfirmOptions;
  /** More tool middleware (outermost first): decide, change, time or log screen actions. */
  toolMiddleware?: ToolMiddleware[];
  /** Everything that happens (turns, tool calls, interruptions, why a session ended), for logs. */
  onEvent?: (event: AssistantEvent) => void;
  /**
   * Whether the user can cut the agent off by talking, for every kind of assistant. 'smart'
   * (default): talking over it stops it (its own voice doesn't). 'off': take turns; it always
   * finishes, and a tap still cuts it off. 'raw': speech-to-speech voices send the mic as is (only
   * with reliable echo cancellation). Read live, so a toggle applies mid-conversation.
   */
  voiceInterruptions?: VoiceInterruptions;
  /** Speech-to-speech voices: end the session if the user says nothing after the greeting. Default 8000ms. */
  noSpeechTimeoutMs?: number;
  /** Speech-to-speech voices, 'single' conversations: how long to wait for a reply to an answer. Default 4000ms. */
  followUpTimeoutMs?: number;
  /** Speech-to-speech voices, 'continuous' conversations: silence after an answer that ends the session. Default 12000ms. */
  idleTimeoutMs?: number;
} & ({ voice: VoiceIO; model: AgentModel } | { realtime: RealtimeVoiceModel });

export type AssistantState = 'idle' | 'greeting' | 'listening' | 'thinking' | 'speaking';

export interface AssistantStatus {
  state: AssistantState;
  /** Live transcript while listening, then the final one. */
  transcript: string;
  /** The conversation so far, oldest first (kept across resumed sessions). */
  log: AssistantMessage[];
  error?: string;
}

/** Voice-first assistant: greet → listen → act on the screen → speak → (listen again…) → idle. */
export class VoiceAssistant {
  private status: AssistantStatus = { state: 'idle', transcript: '', log: [] };
  /** The model whose history is a clean, finished exchange that a new session can continue. */
  /** The live conversation, and the screen as the model last saw it (to notice the user's own taps). */
  private conversation: { model: AgentModel; endedAt: number; lastScreen: string } | null = null;
  private abort: AbortController | null = null;
  private interruptHandler: (() => void) | null = null;
  /** A typed request waiting for the next listening turn, and the turn listening right now. */
  private pendingText: string | null = null;
  private typedHandler: ((text: string) => void) | null = null;
  /** A running speech-to-speech session's way to take a typed request. */
  private realtimeText: ((text: string) => void) | null = null;
  /** Spoken progress updates still playing while the agent works; answers wait for them. */
  private progressSpeech: Promise<void> = Promise.resolve();
  private listeners = new Set<(s: AssistantStatus) => void>();
  /** This session: its number, the user's turns and last words (for tool middleware), and why it ended. */
  private sessionId = 0;
  private userTurns = 0;
  private lastUserText = '';
  private endReason: SessionEndReason | undefined;

  constructor(
    private readonly controller: ScreenContextController,
    /**
     * A config, or a getter read at the start of every session (so it can change at runtime).
     * Undefined: the assistant is unavailable (e.g. turned off remotely); start() does nothing.
     */
    private readonly configSource: AssistantConfig | undefined | (() => AssistantConfig | undefined),
  ) {}

  private get config(): AssistantConfig | undefined {
    return typeof this.configSource === 'function' ? this.configSource() : this.configSource;
  }

  /** Whether there is an assistant to start (a config is set). */
  get available(): boolean {
    return !!this.config;
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

  private trace(event: AssistantEvent) {
    try {
      this.config?.onEvent?.(event);
    } catch {}
  }

  private set(patch: Partial<AssistantStatus>) {
    // Skip no-op updates: realtime models report state per audio chunk, and every notify re-renders subscribers.
    if ((Object.keys(patch) as (keyof AssistantStatus)[]).every(k => this.status[k] === patch[k])) return;
    if (patch.state && patch.state !== this.status.state) {
      this.controller.reportVoice(patch.state === 'greeting' ? 'speaking' : patch.state);
      this.trace({ type: 'state', state: patch.state });
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

  /**
   * A request typed instead of spoken. While listening it answers this turn; otherwise it waits
   * for the next one, starting a session (without the greeting) if none is running.
   */
  submitText(text: string): void {
    const request = text.trim();
    if (!request) return;
    if (this.typedHandler) return this.typedHandler(request);
    if (this.realtimeText) return this.realtimeText(request);
    this.pendingText = request;
    if (!this.abort) void this.start();
  }

  /** Stops the current spoken answer (the session continues and listens). */
  interrupt(): void {
    this.interruptHandler?.();
  }

  cancel(): void {
    this.endWith('user');
  }

  private endWith(reason: SessionEndReason) {
    if (!this.abort) return;
    this.endReason ??= reason;
    this.abort.abort();
  }

  /** The user's words, for the log, the trace and tool middleware ("was that a yes?"). */
  private userSaid(text: string) {
    this.userTurns++;
    this.lastUserText = text;
    this.addToLog('user', text);
    this.trace({ type: 'user', text });
  }

  /**
   * How every tool call runs, whatever the assistant: the app's middleware (confirmations first),
   * around the screen action, timed and traced.
   */
  private toolRunner(config: AssistantConfig): (name: string, input: unknown) => Promise<ToolCallResult> {
    const middleware = [...(config.confirm ? [confirmBefore(config.confirm)] : []), ...(config.toolMiddleware ?? [])];
    const run = composeTools((call, _ctx) => this.controller.executeToolCall(call.name, call.input), middleware);
    return async (name, input) => {
      const ctx: ToolContext = { sessionId: this.sessionId, userTurns: this.userTurns, lastUserText: this.lastUserText, controller: this.controller };
      const started = Date.now();
      const result = await run({ name, input }, ctx);
      this.trace({ type: 'tool', name, input, result, ms: Date.now() - started });
      return result;
    };
  }

  private voicePhase() {
    const s = this.status.state;
    return s === 'greeting' ? 'speaking' : s;
  }

  private addToLog(role: AssistantMessage['role'], text: string) {
    if (!text.trim()) return;
    if (role === 'assistant') this.trace({ type: 'agent', text: text.trim() });
    this.set({ log: [...this.status.log, { role, text: text.trim() }].slice(-MAX_LOG) });
  }

  /**
   * Speaks, but can be cut short with interrupt() (or by voice) without ending the session.
   * `onCut` hears how much was said when the user cut it off.
   */
  private async speak(voice: VoiceIO, text: string, signal: AbortSignal, onCut?: (heard?: string) => void): Promise<void> {
    this.addToLog('assistant', text);
    const offLevel = voice.onSpeakingLevel?.(level => this.controller.reportVoice('speaking', level));
    const speech = new AbortController();
    const onAbort = () => speech.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    this.interruptHandler = () => speech.abort();
    try {
      const interruptible = (this.config?.voiceInterruptions ?? 'smart') !== 'off';
      const result = (await voice.speak(text, speech.signal, { interruptible })) || undefined;
      const cut = result?.interrupted || (speech.signal.aborted && !signal.aborted);
      if (cut) {
        const chars = result?.spokenChars;
        const heard = chars === undefined ? undefined : chars >= text.length ? text : text.slice(0, chars).trim();
        this.trace({ type: 'interrupted', heard });
        onCut?.(heard);
      }
    } finally {
      offLevel?.();
      this.interruptHandler = null;
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Speaks a progress line ("Sure, finding autos to the airport") without holding up the agent.
   * Lines queue behind each other; the answer and the next listen wait for them to finish.
   */
  private sayProgress(voice: VoiceIO, text: string, signal: AbortSignal): void {
    this.progressSpeech = this.progressSpeech.then(async () => {
      if (signal.aborted) return;
      this.set({ state: 'speaking' });
      await this.speak(voice, text, signal).catch(() => {});
      if (this.abort && !signal.aborted && this.status.state === 'speaking') this.set({ state: 'thinking' });
    });
  }

  /** Listens for speech, unless a request is typed first (which stops the mic). */
  private listenOrType(voice: VoiceIO, signal: AbortSignal): Promise<HeardSpeech> {
    const mic = new AbortController();
    const onAbort = () => mic.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    return new Promise<HeardSpeech>((resolve, reject) => {
      this.typedHandler = text => {
        mic.abort();
        resolve({ text });
      };
      const endOfTurn = this.config?.endOfTurn;
      voice
        .listen(
          mic.signal,
          partial => this.set({ transcript: partial }),
          level => this.controller.reportVoice('listening', level),
          { endOfTurnDelay: t => endOfTurnDelay(t, endOfTurn) },
        )
        .then(heard => resolve(typeof heard === 'string' ? { text: heard } : heard), reject);
    }).finally(() => {
      this.typedHandler = null;
      signal.removeEventListener('abort', onAbort);
    });
  }

  async start(): Promise<void> {
    const config = this.config;
    if (this.abort || !config) return;
    const abort = new AbortController();
    this.abort = abort;
    const { signal } = abort;
    const model = 'model' in config ? config.model : undefined;
    const previous = this.conversation;
    const resumed =
      !!model?.followUp &&
      previous !== null &&
      previous.model === model &&
      Date.now() - previous.endedAt < (config.resumeWithinMs ?? 0);
    if (!resumed) this.conversation = null;
    this.sessionId++;
    this.userTurns = 0;
    this.lastUserText = '';
    this.endReason = undefined;
    const runTool = this.toolRunner(config);
    this.trace({ type: 'session-start', kind: 'realtime' in config ? 'realtime' : 'chat', resumed });
    this.controller.setActive(true);
    this.set({ state: 'greeting', transcript: '', error: undefined, ...(!resumed && { log: [] }) });
    this.interruptHandler = null;
    this.progressSpeech = Promise.resolve();
    try {
      // Capture before the user speaks: this is the screen they are asking about.
      const screen = await this.controller.describe();
      const userContext = config.userContext ? await Promise.resolve(config.userContext()).catch(() => undefined) : undefined;
      const greeting =
        typeof config.greeting === 'function' ? config.greeting({ screen, resumed }) : config.greeting ?? 'How can I help?';

      const conversation = config.conversation ?? 'continuous';
      const stop = (text: string) => isStopPhrase(text, config.stopPhrases);

      if ('realtime' in config) {
        await this.runRealtime(config, config.realtime, {
          greeting: greeting ?? 'How can I help?',
          screen,
          instructions: buildInstructions(config.app, config.systemPrompt, userContext),
          signal,
          runTool,
          stop,
        });
        return;
      }

      const { voice } = config;
      const agentModel = config.model;
      const opts = { signal, maxSteps: config.maxSteps, app: config.app, systemPrompt: config.systemPrompt, userContext, runTool };
      // The screen captured at the tap goes with the first model call; later ones capture afresh.
      let firstScreen: string | undefined = screen;
      // Continues the conversation when there is a clean one to continue, else starts one. A call
      // that fails or is cut off can leave the history mid-exchange, so it is only kept on success.
      const ask = async (request: UserRequest) => {
        const live = this.conversation?.model === agentModel && !!agentModel.followUp;
        const before = this.conversation?.lastScreen;
        this.conversation = null;
        const screenNow = firstScreen ?? (await this.controller.describe());
        const note = live && before ? screenChangeNote(before, screenNow) : '';
        if (note) request = typeof request === 'string' ? `${note}\n${request}` : { ...request, transcript: `${note}\n${request.transcript ?? ''}` };
        const callOpts = {
          ...opts,
          screen: screenNow,
          ...(config.speakProgress && { onProgress: (text: string) => this.sayProgress(voice, text, signal) }),
        };
        firstScreen = undefined;
        const answer = live
          ? await runAgentFollowUp(this.controller, agentModel, request, callOpts)
          : await runAgent(this.controller, agentModel, request, callOpts);
        this.conversation = { model: agentModel, endedAt: Date.now(), lastScreen: await this.controller.describe() };
        return answer;
      };
      const listen = async () => {
        await this.progressSpeech;
        this.set({ state: 'listening', transcript: '' });
        const typed = this.pendingText;
        this.pendingText = null;
        const heard = typed ? { text: typed } : await this.listenOrType(voice, signal);
        const text = heard.text.trim();
        this.set({ transcript: text });
        return { ...heard, text };
      };

      // No fixed greeting: the model opens, from the screen and the conversation so far. If that
      // fails the session still goes on; it just listens without an opening line.
      // A session started by typing goes straight to the request.
      const opening = this.pendingText
        ? ''
        : greeting ??
        (await ask(OPENING_REQUEST).catch(() => {
          if (signal.aborted) throw new Error('Aborted');
          return '';
        }));
      if (opening) {
        this.set({ state: 'greeting' });
        await this.speak(voice, opening, signal);
      }
      const keepOnSilence = conversation === 'continuous' && config.endOnSilence === false;
      let answer = '';
      let turn = 0;
      let failures = 0;
      while (!signal.aborted) {
        if (turn >= (config.maxTurns ?? 30)) {
          this.endReason ??= 'max-turns';
          break;
        }
        if (turn > 0) {
          const keepListening = conversation === 'continuous' || (answer.trim().endsWith('?') && turn <= (config.maxFollowUps ?? 3));
          if (!keepListening) {
            this.endReason ??= 'agent';
            break;
          }
        }
        const listenedAt = Date.now();
        const heard = await listen();
        const request = heard.text;
        if (!request) {
          if (signal.aborted) break;
          if (keepOnSilence) {
            // Straight back to listening (a gap is a chance to miss a short "yes"), unless the
            // recognizer returned at once, which would spin the loop.
            if (Date.now() - listenedAt < 300) await new Promise<void>(resolve => setTimeout(() => resolve(), 300));
            continue;
          }
          if (turn === 0 && config.noInputReply) await this.speak(voice, config.noInputReply, signal);
          this.endReason ??= 'silence';
          break;
        }
        turn++;
        this.userSaid(request);
        if (stop(request)) {
          this.endReason ??= 'stop-phrase';
          this.set({ state: 'speaking' });
          await this.speak(voice, config.farewell ?? 'Okay.', signal);
          break;
        }
        this.set({ state: 'thinking' });
        // Later turns continue the same conversation, so "and one more" or "yes" make sense.
        try {
          const text = requestWithAlternatives(heard);
          answer = await ask(heard.audio ? { audio: heard.audio.data, format: heard.audio.format, transcript: text } : text);
          failures = 0;
        } catch (e: any) {
          // A failed turn (the model unreachable, say) is told and the user can try again; only
          // repeated failures end the session.
          if (signal.aborted || ++failures >= 2) throw e;
          answer = config.errorReply ?? "Sorry, I couldn't do that. Please say it again.";
        }
        await this.progressSpeech;
        if (answer) {
          this.set({ state: 'speaking' });
          // Cut off: the model's history keeps only what the user heard.
          await this.speak(voice, answer, signal, heard => agentModel.interrupted?.(heard));
        }
      }
    } catch (e: any) {
      if (!signal.aborted) {
        this.endReason ??= 'error';
        this.set({ error: e?.message ?? String(e) });
      }
    } finally {
      if (this.conversation) this.conversation = { ...this.conversation, endedAt: Date.now() };
      this.abort = null;
      this.interruptHandler = null;
      this.controller.setActive(false);
      this.set({ state: 'idle' });
      this.trace({ type: 'session-end', reason: this.endReason ?? (signal.aborted ? 'user' : 'agent'), ...(this.status.error && { error: this.status.error }) });
    }
  }

  /**
   * A speech-to-speech session. The transport only speaks its protocol; the behaviour is here, the
   * same for every transport: turn timeouts, stop phrases, captions, taps, screen-change notes.
   */
  private async runRealtime(
    config: AssistantConfig,
    transport: RealtimeVoiceModel,
    session: {
      greeting: string;
      screen: string;
      instructions: string;
      signal: AbortSignal;
      runTool: (name: string, input: unknown) => Promise<ToolCallResult>;
      stop: (text: string) => boolean;
    },
  ): Promise<void> {
    const { signal } = session;
    const assistant = this;
    const conversation = config.conversation ?? 'continuous';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let endAfterReply = false;
    let toolsRunning = 0;
    let controls: RealtimeControls = {};
    let lastScreen = session.screen;
    let screenCheckedForTurn = -1;
    const clear = () => clearTimeout(timer);

    /** The user's turn: wait for them, up to the timeout that fits where the conversation is. */
    const awaitUser = () => {
      clear();
      const ms =
        this.userTurns === 0
          ? config.noSpeechTimeoutMs ?? 8000
          : conversation === 'single'
            ? config.followUpTimeoutMs ?? 4000
            : config.endOnSilence === false
              ? undefined
              : config.idleTimeoutMs ?? 12000;
      if (ms !== undefined) timer = setTimeout(() => this.endWith('silence'), ms);
    };

    /** Before the user's turn is answered: if the screen changed since the agent last acted, tell it. */
    const checkScreen = async () => {
      if (screenCheckedForTurn === this.userTurns || !controls.context) return;
      screenCheckedForTurn = this.userTurns;
      const now = await this.controller.describe();
      const note = screenChangeNote(lastScreen, now);
      lastScreen = now;
      if (!note || signal.aborted) return;
      const text = `${note}\nScreen now:\n${now}`;
      controls.context?.(text);
      this.trace({ type: 'context', text });
    };

    // What the user last typed: some transports repeat it back as the user's words (not a new turn).
    let lastTyped = '';
    /** A typed request: the same turn as a spoken one, sent as text. */
    const typed = (text: string) => {
      if (!controls.text || signal.aborted) return;
      lastTyped = text;
      clear();
      this.set({ state: 'thinking', transcript: text });
      this.userSaid(text);
      if (session.stop(text)) endAfterReply = true;
      controls.text(text);
    };
    this.realtimeText = typed;

    try {
      await transport.run({
        greeting: session.greeting,
        screen: session.screen,
        instructions: session.instructions,
        tools: SCREEN_TOOLS,
        signal,
        // Read live: the user can switch between interrupting and taking turns mid-conversation.
        get voiceInterruptions() {
          return assistant.config?.voiceInterruptions ?? 'smart';
        },
        runTool: async (name, input) => {
          clear();
          toolsRunning++;
          this.set({ state: 'thinking' });
          try {
            return await session.runTool(name, input);
          } finally {
            toolsRunning--;
            lastScreen = await this.controller.describe().catch(() => lastScreen);
          }
        },
        handle: c => {
          controls = { ...controls, ...c };
          if (c.interrupt) this.interruptHandler = () => controls.interrupt?.();
        },
        emit: event => {
          if (signal.aborted) return;
          switch (event.type) {
            case 'agent-audio':
              clear();
              this.set({ state: this.userTurns === 0 ? 'greeting' : 'speaking' });
              if (event.level !== undefined) this.controller.reportVoice('speaking', event.level);
              break;
            case 'agent-done': {
              if (endAfterReply) return this.endWith('stop-phrase');
              if (toolsRunning > 0) break;
              this.set({ state: 'listening', transcript: '' });
              awaitUser();
              // A session started by typing: the request goes in once the greeting has played.
              const pending = this.pendingText;
              this.pendingText = null;
              if (pending) typed(pending);
              break;
            }
            case 'agent-text':
              this.addToLog('assistant', event.text);
              break;
            case 'user-speaking':
              clear();
              if (this.status.state !== 'speaking' && this.status.state !== 'greeting') this.set({ state: 'listening' });
              void checkScreen();
              break;
            case 'user-text':
              clear();
              if (!event.final) {
                this.set({ state: 'listening', transcript: event.text });
                void checkScreen();
                break;
              }
              if (lastTyped && event.text.trim() === lastTyped.trim()) {
                lastTyped = '';
                break;
              }
              this.set({ state: 'thinking', transcript: event.text });
              this.userSaid(event.text);
              // Ends once the agent has answered (a goodbye), like the other assistants.
              if (session.stop(event.text) || this.userTurns >= (config.maxTurns ?? 30)) {
                endAfterReply = true;
                this.endReason ??= session.stop(event.text) ? 'stop-phrase' : 'max-turns';
              }
              break;
            case 'mic-level':
              if (this.status.state === 'listening') this.controller.reportVoice('listening', event.level);
              break;
            case 'interrupted':
              // The user's turn now (if it was a false alarm, silence still ends the session).
              this.trace({ type: 'interrupted', heard: event.heard });
              if (toolsRunning === 0) {
                this.set({ state: 'listening' });
                awaitUser();
              }
              break;
          }
        },
      });
      // The transport finished by itself: the agent hung up (end_call / end_conversation).
      this.endReason ??= 'agent';
    } finally {
      clear();
      this.realtimeText = null;
    }
  }
}
