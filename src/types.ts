export type ElementKind = 'button' | 'text_input' | 'switch' | 'custom_action';

export type ActionType = 'press' | 'long_press' | 'type' | 'submit' | 'toggle' | 'run';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenElement {
  /** Deterministic id (testID-based when available). Stable across captures of the same UI. */
  id: string;
  kind: ElementKind;
  /** Human readable name: accessibility label, visible text, icon name, placeholder… */
  label: string;
  /** What the element does, from <AIAction description>, accessibilityHint or aria-description. */
  description?: string;
  /** Actions the element supports. */
  actions: ActionType[];
  disabled: boolean;
  testID?: string;
  /** Name of the bound handler function (e.g. "handleLogin"); usually useless in minified release builds. */
  handlerName?: string;

  // text_input
  placeholder?: string;
  /** Current value. Always redacted for secureTextEntry inputs. */
  value?: string;
  secure?: boolean;
  multiline?: boolean;
  keyboardType?: string;
  maxLength?: number;

  // switch
  checked?: boolean;

  // custom_action
  /** JSON schema of the action's args. */
  parameters?: Record<string, unknown>;

  /** Window coordinates, present when the capture measured layout. */
  bounds?: Bounds;
}

export interface ScreenSnapshot {
  /** Screen name, from the focused react-navigation route or the provider's getScreenName option. */
  screen?: string;
  capturedAt: number;
  elements: ScreenElement[];
  /** Visible non-interactive text (headings, messages, errors), in tree order. */
  texts: string[];
  /** True when a spinner or busy element is showing: the screen is still loading. */
  loading?: boolean;
}

export interface CaptureOptions {
  /**
   * Measure every element with measureInWindow, drop the ones that are off-screen or zero-sized
   * and attach bounds. Default true for capture(); captureSync() never measures.
   */
  measure?: boolean;
  /** Include disabled elements (marked disabled: true). Default true. */
  includeDisabled?: boolean;
  /** Max number of static texts to return. Default 80. */
  maxTexts?: number;
  /** Max characters per text/label. Default 200. */
  maxTextLength?: number;
}

export type ScreenAction =
  | { type: 'press'; elementId: string }
  | { type: 'long_press'; elementId: string }
  | { type: 'type'; elementId: string; text: string; submit?: boolean }
  | { type: 'submit'; elementId: string }
  | { type: 'toggle'; elementId: string; value?: boolean }
  | { type: 'run'; elementId: string; args?: Record<string, unknown> };

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Return value of a custom action's handler, if any. */
  result?: unknown;
}
