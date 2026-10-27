import { runAgent, runAgentFollowUp, type AgentModel, type UserRequest } from './agent';
import { buildInstructions, SCREEN_TOOLS, type AppContext, type ToolSpec } from './llm';
import type { ScreenContextController, ToolCallResult } from './ScreenContextProvider';
import { endOfTurnDelay, type EndOfTurnOptions } from './speech';

export interface ListenOptions {
  /** Silence (ms) after `transcript` that ends the user's turn: short when it sounds finished. */
  endOfTurnDelay?: (transcript: string) => number;
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
  speak(text: string, signal: AbortSignal): Promise<void | SpeakResult>;
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
 * Tells the model the screen changed while it wasn't acting, i.e. the user tapped around
 * themselves, so it goes by the current screen instead of carrying on with the old task.
 */
export function screenChangeNote(lastSeen: string, now: string): string {
  const was = screenTitle(lastSeen);
  const is = screenTitle(now);
  if (!was || !is || was === is) return '';
  return (
    `(The user changed the screen themselves since you last acted: it was "${was}", now it is "${is}". ` +
    'Whatever you were doing may be done or dropped; go by the current screen.)'
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
  /** Spoken progress updates still playing while the agent works; answers wait for them. */
  private progressSpeech: Promise<void> = Promise.resolve();
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

  /**
   * A request typed instead of spoken. While listening it answers this turn; otherwise it waits
   * for the next one, starting a session (without the greeting) if none is running.
   */
  submitText(text: string): void {
    const request = text.trim();
    if (!request) return;
    if (this.typedHandler) return this.typedHandler(request);
    this.pendingText = request;
    if (!this.abort) void this.start();
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

  private addToLog(role: AssistantMessage['role'], text: string) {
    if (text.trim()) this.set({ log: [...this.status.log, { role, text: text.trim() }].slice(-MAX_LOG) });
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
      const result = (await voice.speak(text, speech.signal)) || undefined;
      const cut = result?.interrupted || (speech.signal.aborted && !signal.aborted);
      if (cut && onCut) {
        const chars = result?.spokenChars;
        onCut(chars === undefined ? undefined : chars >= text.length ? text : text.slice(0, chars).trim());
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
      const endOfTurn = this.config.endOfTurn;
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
    if (this.abort) return;
    const abort = new AbortController();
    this.abort = abort;
    const { signal } = abort;
    const config = this.config;
    const model = 'model' in config ? config.model : undefined;
    const previous = this.conversation;
    const resumed =
      !!model?.followUp &&
      previous !== null &&
      previous.model === model &&
      Date.now() - previous.endedAt < (config.resumeWithinMs ?? 0);
    if (!resumed) this.conversation = null;
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
        this.set({ state: 'listening' });
        await config.realtime.run({
          greeting: greeting ?? 'How can I help?',
          screen,
          instructions: buildInstructions(config.app, config.systemPrompt, userContext),
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

      const { voice } = config;
      const agentModel = config.model;
      const opts = { signal, maxSteps: config.maxSteps, app: config.app, systemPrompt: config.systemPrompt, userContext };
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
      while (turn < (config.maxTurns ?? 30) && !signal.aborted) {
        if (turn > 0) {
          const keepListening = conversation === 'continuous' || (answer.trim().endsWith('?') && turn <= (config.maxFollowUps ?? 3));
          if (!keepListening) break;
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
          break;
        }
        turn++;
        this.addToLog('user', request);
        if (stop(request)) {
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
      if (!signal.aborted) this.set({ error: e?.message ?? String(e) });
    } finally {
      if (this.conversation) this.conversation = { ...this.conversation, endedAt: Date.now() };
      this.abort = null;
      this.controller.setActive(false);
      this.set({ state: 'idle' });
    }
  }
}
