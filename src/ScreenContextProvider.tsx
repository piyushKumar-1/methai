import { Component, createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { AgentGlow, type AgentGlowProps } from './AgentGlow';
import { VoiceAssistant, type AssistantConfig, type AssistantStatus } from './assistant';
import { performAction } from './actions';
import { extract, type Extraction } from './extract';
import { currentRootOf, fiberOfInstance, type Fiber } from './fiber';
import { formatSnapshot, parseArgs, toolCallToAction, WAIT_TOOL } from './llm';
import { measureEntries } from './measure';
import type { ActionResult, CaptureOptions, ScreenAction, ScreenSnapshot } from './types';

export interface ToolCallResult {
  isError: boolean;
  /** Text to send back as the tool result: outcome plus the screen as it is after the action. */
  content: string;
}

export interface ExecuteOptions {
  /**
   * After an action, the screen counts as settled once it has not changed for this long and no
   * spinner is showing. Default 350ms.
   */
  settleMs?: number;
  /** Longest to wait for the screen to settle after an action. Default 3000ms. */
  maxSettleMs?: number;
}

export interface SettleOptions {
  /** Unchanged for this long (and no spinner) = settled. Default 350ms. */
  quietMs?: number;
  /** Give up after this long. Default 3000ms. */
  maxMs?: number;
  /** Only settle once the screen differs from how it was when the wait began. */
  untilChanged?: boolean;
  /** A spinner that never stops (a "searching…" animation) stops counting after this long. Default 1500ms. */
  spinnerGraceMs?: number;
}

export interface SettleResult {
  changed: boolean;
  settled: boolean;
  loading: boolean;
  waitedMs: number;
}

export type ScreenContextEvent =
  | { type: 'active'; active: boolean }
  | { type: 'action'; action: ScreenAction; result: ActionResult }
  /** Voice activity for visuals: which side is talking and how loud (0–1). */
  | { type: 'voice'; phase: VoicePhase; level?: number };

export type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking';

const nextFrame = () => new Promise<void>(resolve => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => resolve()) : setTimeout(resolve, 16)));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class ScreenContextController {
  private listeners = new Set<(event: ScreenContextEvent) => void>();
  private activeCount = 0;

  constructor(
    private readonly getRoot: () => Fiber | null,
    private readonly getScreenName?: () => string | undefined,
  ) {}

  /** True while an agent session is running; drives the edge glow. */
  get active(): boolean {
    return this.activeCount > 0;
  }

  /** Marks an agent session as running or finished. Calls nest, so overlapping sessions are safe. */
  setActive(active: boolean): void {
    const was = this.active;
    this.activeCount = Math.max(0, this.activeCount + (active ? 1 : -1));
    if (was !== this.active) this.emit({ type: 'active', active: this.active });
  }

  subscribe(listener: (event: ScreenContextEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reports the voice phase and/or loudness (0–1); drives the voice-reactive glow. */
  reportVoice(phase: VoicePhase, level?: number): void {
    this.emit({ type: 'voice', phase, level });
  }

  private emit(event: ScreenContextEvent) {
    for (const l of [...this.listeners]) l(event);
  }

  private extract(opts?: CaptureOptions): Extraction {
    return extract(this.getRoot(), opts, this.getScreenName);
  }

  /** Synchronous capture from the fiber tree, without layout measurement. */
  captureSync(opts?: CaptureOptions): ScreenSnapshot {
    return this.extract(opts).snapshot;
  }

  /** Capture with layout measurement: drops off-screen/zero-size elements and adds bounds. */
  async capture(opts: CaptureOptions = {}): Promise<ScreenSnapshot> {
    const { snapshot, entries } = this.extract(opts);
    if (opts.measure === false) return snapshot;
    const hidden = await measureEntries(entries.values());
    return { ...snapshot, elements: snapshot.elements.filter(el => !hidden.has(el.id)) };
  }

  private signature(): { sig: string; loading: boolean } {
    const s = this.captureSync();
    return { sig: JSON.stringify([s.screen, s.texts, s.elements]), loading: !!s.loading };
  }

  /**
   * Waits for the screen to stop changing: React re-rendered, navigation finished animating, data
   * that loads after a tap arrived and spinners went away. Resolves early once it is quiet.
   */
  async waitForSettle({ quietMs = 350, maxMs = 3000, untilChanged = false, spinnerGraceMs = 1500 }: SettleOptions = {}): Promise<SettleResult> {
    const start = Date.now();
    const first = this.signature().sig;
    let last = first;
    let quietSince = start;
    let changed = false;
    for (;;) {
      await sleep(100);
      const now = Date.now();
      const { sig, loading } = this.signature();
      if (sig !== last) {
        last = sig;
        quietSince = now;
      }
      if (sig !== first) changed = true;
      const spinnerBlocks = loading && now - start < spinnerGraceMs;
      if (now - quietSince >= quietMs && !spinnerBlocks && (changed || !untilChanged)) {
        return { changed, settled: true, loading, waitedMs: now - start };
      }
      if (now - start >= maxMs) return { changed, settled: false, loading, waitedMs: now - start };
    }
  }

  /** Text rendering of the current screen for an LLM prompt. */
  async describe(opts?: CaptureOptions): Promise<string> {
    return formatSnapshot(await this.capture(opts));
  }

  /**
   * Performs an action. The tree is re-read first, so the element is resolved against what is on
   * screen *now* and the handler is the current one (not a stale closure from an old snapshot).
   */
  async execute(action: ScreenAction, opts: ExecuteOptions = {}): Promise<ActionResult> {
    if (action.type === 'type' && action.submit) {
      // Submit as a separate step after re-rendering, so onSubmitEditing sees the typed value.
      const typed = await this.execute({ ...action, submit: false }, opts);
      if (!typed.ok) return typed;
      return this.execute({ type: 'submit', elementId: action.elementId }, opts);
    }
    const { entries } = this.extract();
    const entry = entries.get(action.elementId);
    if (!entry) {
      const ids = [...entries.keys()];
      return { ok: false, error: `No element "${action.elementId}" on screen. Available: ${ids.length ? ids.join(', ') : 'none'}.` };
    }
    await measureEntries([entry]); // gives press events a realistic location
    const result = await performAction(entry, action);
    this.emit({ type: 'action', action, result });
    await nextFrame();
    // Wait for what the action set off (navigation, a request, a spinner) instead of a fixed delay,
    // so the next step sees the result rather than a half-loaded screen.
    await this.waitForSettle({ quietMs: opts.settleMs ?? 350, maxMs: opts.maxSettleMs ?? 3000 });
    return result;
  }

  /** Runs an LLM tool call end to end and returns a ready-to-send tool result. */
  async executeToolCall(name: string, input: unknown, opts?: ExecuteOptions & CaptureOptions): Promise<ToolCallResult> {
    if (name === WAIT_TOOL) {
      const seconds = Number(parseArgs(input)?.seconds);
      const maxMs = Math.min(10, Math.max(1, Number.isFinite(seconds) ? seconds : 5)) * 1000;
      const r = await this.waitForSettle({ quietMs: 600, maxMs, untilChanged: true });
      const secs = (r.waitedMs / 1000).toFixed(1);
      const head = r.settled ? `Screen updated (${secs}s).` : r.loading ? `Still loading after ${secs}s.` : r.changed ? `Still changing after ${secs}s.` : `Nothing changed in ${secs}s.`;
      return { isError: false, content: `${head}\n\nScreen now:\n${await this.describe(opts)}` };
    }
    const action = toolCallToAction(name, input);
    if ('error' in action) return { isError: true, content: action.error };
    const result = await this.execute(action, opts);
    const screen = await this.describe(opts);
    const head = result.ok ? `OK: ${action.type} on ${action.elementId}.${result.error ? ` Note: ${result.error}` : ''}` : `Failed: ${result.error}`;
    return { isError: !result.ok, content: `${head}\n\nScreen now:\n${screen}` };
  }
}

let defaultController: ScreenContextController | null = null;

/** The controller of the most recently mounted provider, for use outside React components. */
export function getScreenContext(): ScreenContextController {
  if (!defaultController) throw new Error('ScreenContextProvider is not mounted.');
  return defaultController;
}

const Ctx = createContext<ScreenContextController | null>(null);
const AssistantCtx = createContext<VoiceAssistant | null>(null);

export interface ScreenContextProviderProps {
  children?: ReactNode;
  /** Overrides the auto-detected react-navigation route name. */
  getScreenName?: () => string | undefined;
  /** Voice assistant setup. Read at the start of each session, so it can change at runtime. */
  assistant?: AssistantConfig;
  /** Edge glow shown while an agent session runs. `false` turns it off. */
  glow?: false | Omit<AgentGlowProps, 'controller'>;
}

/**
 * Mount once near the app root. It only needs to be mounted; extraction walks the whole React
 * tree it belongs to (modals and navigation included), not just its children.
 */
export class ScreenContextProvider extends Component<ScreenContextProviderProps> {
  readonly controller = new ScreenContextController(
    () => currentRootOf(fiberOfInstance(this)),
    () => this.props.getScreenName?.(),
  );
  readonly assistant = this.props.assistant ? new VoiceAssistant(this.controller, () => this.props.assistant!) : null;

  componentDidMount() {
    defaultController = this.controller;
  }

  componentWillUnmount() {
    this.assistant?.cancel();
    if (defaultController === this.controller) defaultController = null;
  }

  render() {
    const { glow } = this.props;
    return (
      <Ctx.Provider value={this.controller}>
        <AssistantCtx.Provider value={this.assistant}>
          {this.props.children}
          {glow !== false && <AgentGlow controller={this.controller} {...glow} />}
        </AssistantCtx.Provider>
      </Ctx.Provider>
    );
  }
}

export function useScreenContext(): ScreenContextController {
  const controller = useContext(Ctx);
  if (!controller) throw new Error('useScreenContext must be used inside <ScreenContextProvider>.');
  return controller;
}

export interface UseAssistant extends AssistantStatus {
  /** Start; while speaking, interrupt; otherwise end the session. Wire it to any button. */
  toggle: () => void;
  /** Cut the current spoken answer short and listen again. */
  interrupt: () => void;
  start: () => Promise<void>;
  cancel: () => void;
  /** A request typed instead of spoken; starts a session if none is running. */
  submitText: (text: string) => void;
}

export function useAssistant(): UseAssistant {
  const assistant = useContext(AssistantCtx);
  if (!assistant) throw new Error('useAssistant needs <ScreenContextProvider assistant={...}>.');
  const status = useSyncExternalStore(
    cb => assistant.subscribe(cb),
    () => assistant.getStatus(),
  );
  return {
    ...status,
    toggle: () => assistant.toggle(),
    interrupt: () => assistant.interrupt(),
    start: () => assistant.start(),
    cancel: () => assistant.cancel(),
    submitText: (text: string) => assistant.submitText(text),
  };
}
