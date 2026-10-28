import { ActivityIndicator, StyleSheet, Switch, TextInput } from 'react-native';
import { AIAction, AIIgnore, AIScreenAction } from './annotations';
import { displayNameOf, Fiber, FiberTag } from './fiber';
import type { ActionType, CaptureOptions, ElementKind, ScreenElement, ScreenSnapshot } from './types';

/** An extracted element plus the live fiber it came from, so actions can call its current props. */
export interface ElementEntry {
  element: ScreenElement;
  fiber: Fiber;
}

export interface Extraction {
  snapshot: ScreenSnapshot;
  entries: Map<string, ElementEntry>;
}

interface Annotation {
  name?: string;
  description?: string;
  used: boolean;
}

interface TextPiece {
  text: string;
  fiber: Fiber;
  /** The native text view the string belongs to. */
  host: Fiber | null;
}

/**
 * The outermost native text view above a raw string. Nested <Text> renders as (virtual) text views
 * inside the outer one, and the whole thing reads as one string.
 */
function textHostOf(fiber: Fiber): Fiber | null {
  let outer: Fiber | null = null;
  for (let n = fiber.return; n; n = n.return) {
    if (n.tag !== FiberTag.HostComponent) continue;
    const type = String(n.type);
    if (/text/i.test(type) && !/input/i.test(type)) outer = n;
    else break;
  }
  return outer;
}

interface Draft {
  kind: ElementKind;
  fiber: Fiber;
  props: any;
  text: TextPiece[];
  iconName?: string;
  annotation?: Annotation;
  /** `label` prop on a wrapping component (react-native-paper style). */
  wrapperLabel?: string;
  /** Static text rendered just before the control in the same container. */
  precedingText?: string;
}

interface WalkState {
  drafts: Draft[];
  texts: TextPiece[];
  annotations: Annotation[];
  route?: { name: string; depth: number };
  /** A spinner or busy element is on screen. */
  loading?: boolean;
}

const isFn = (v: unknown): v is Function => typeof v === 'function';
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

// A tab or drawer item is a few dozen fibers; a screen is far more.
const NAV_ITEM_MAX_FIBERS = 150;

const marksNavItem = (p: any) =>
  !!p &&
  typeof p === 'object' &&
  (p.role === 'tab' || p.accessibilityRole === 'tab' || typeof p['aria-selected'] === 'boolean' || typeof p.accessibilityState?.selected === 'boolean');

/**
 * Whether an unfocused navigation context wraps a navigation item rather than a screen: React
 * Navigation wraps each bottom-tab (and drawer) item in its route's context too, so the buttons for
 * other tabs sit under unfocused contexts while being on screen. Such an item is small and marked
 * as a tab / selectable.
 */
function isNavigationItem(provider: Fiber): boolean {
  let count = 0;
  let marked = false;
  const stack: Fiber[] = provider.child ? [provider.child] : [];
  while (stack.length) {
    const f = stack.pop()!;
    if (++count > NAV_ITEM_MAX_FIBERS) return false;
    if (!marked && marksNavItem(f.memoizedProps)) marked = true;
    if (f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
  }
  return marked;
}

/** Subtrees that are mounted but not visible / not reachable by the user. */
export function isHidden(fiber: Fiber): boolean {
  const p = fiber.memoizedProps;
  if (fiber.tag === FiberTag.OffscreenComponent) return p?.mode === 'hidden';
  if (fiber.tag === FiberTag.ContextProvider) {
    // react-navigation's NavigationContext: unfocused screens stay mounted under a
    // navigation object whose isFocused() is false. Tab bar items share that wrapper.
    const nav = p?.value;
    if (nav && isFn(nav.isFocused) && isFn(nav.navigate)) {
      try {
        return nav.isFocused() === false && !isNavigationItem(fiber);
      } catch {
        return false;
      }
    }
    return false;
  }
  if (!p || typeof p !== 'object') return false;
  if (p.accessibilityElementsHidden === true) return true;
  if (p.importantForAccessibility === 'no-hide-descendants') return true;
  if (p['aria-hidden'] === true) return true;
  if (fiber.tag === FiberTag.HostComponent && p.style) {
    const style = StyleSheet.flatten(p.style);
    if (style?.display === 'none') return true;
  }
  return false;
}

const SPINNER_HOSTS = /^(RCTActivityIndicatorView|AndroidProgressBar)$/;

/** Spinners and elements that say they are busy: the screen is still loading. */
function isLoadingIndicator(fiber: Fiber): boolean {
  if (fiber.elementType === ActivityIndicator) return fiber.memoizedProps?.animating !== false;
  if (fiber.tag === FiberTag.HostComponent && SPINNER_HOSTS.test(String(fiber.type))) return fiber.memoizedProps?.animating !== false;
  const p = fiber.memoizedProps;
  return !!p && typeof p === 'object' && (p.accessibilityState?.busy === true || p['aria-busy'] === true || p.accessibilityRole === 'progressbar');
}

/** react-navigation's NavigationRouteContext value. */
function routeName(fiber: Fiber): string | undefined {
  if (fiber.tag !== FiberTag.ContextProvider) return undefined;
  const v = fiber.memoizedProps?.value;
  if (v && typeof v === 'object' && typeof v.key === 'string' && typeof v.name === 'string' && !isFn(v.navigate)) {
    return v.name;
  }
  return undefined;
}

function interactiveKind(fiber: Fiber): ElementKind | null {
  if (fiber.tag === FiberTag.HostComponent || fiber.tag === FiberTag.HostText) return null;
  const t = fiber.elementType;
  if (t === TextInput) return 'text_input';
  const p = fiber.memoizedProps;
  if (!p || typeof p !== 'object') return null;
  if (t === Switch || (isFn(p.onValueChange) && typeof p.value === 'boolean')) return 'switch';
  if (isFn(p.onPress) || isFn(p.onLongPress)) return 'button';
  return null;
}

function isAncestor(maybeAncestor: Fiber, node: Fiber, maxDepth = 30): boolean {
  let n: Fiber | null = node;
  for (let i = 0; n && i < maxDepth; i++, n = n.return) {
    if (n === maybeAncestor || n === (maybeAncestor as any).alternate) return true;
  }
  return false;
}

function wrapperLabel(fiber: Fiber): string | undefined {
  let n = fiber.return;
  for (let i = 0; n && i < 6; i++, n = n.return) {
    const label = str(n.memoizedProps?.label);
    if (label) return label;
  }
  return undefined;
}

function precedingText(fiber: Fiber, state: WalkState): string | undefined {
  const last = state.texts[state.texts.length - 1];
  if (!last || !str(last.text)) return undefined;
  let scope: Fiber | null = fiber;
  // A few levels up; composite wrappers (Animated, forwardRef…) count as levels too.
  for (let i = 0; scope && i < 8; i++) scope = scope.return;
  return scope && isAncestor(scope, last.fiber) ? str(last.text) : undefined;
}

function walk(fiber: Fiber | null, state: WalkState, owner: Draft | null, onChain: boolean, depth: number) {
  for (let node = fiber; node; node = node.sibling) {
    visit(node, state, owner, onChain && !node.sibling && node === fiber, depth);
  }
}

/**
 * `owner` is the innermost interactive element being built; text found below it becomes its label.
 * `onChain` is true while we're on its single-child wrapper chain (Button -> TouchableOpacity ->
 * Animated.View …): a nested onPress there is the same control, not a new one.
 */
function visit(fiber: Fiber, state: WalkState, owner: Draft | null, onChain: boolean, depth: number) {
  if (isHidden(fiber)) return;
  const t = fiber.elementType;
  if (t === AIIgnore) return;

  if (!state.loading && isLoadingIndicator(fiber)) state.loading = true;

  const name = routeName(fiber);
  if (name && (!state.route || depth >= state.route.depth)) state.route = { name, depth };

  if (fiber.tag === FiberTag.HostText) {
    // `<Text>₹{price}</Text>` renders two raw strings in one native text: join them, keeping
    // their own spacing, instead of listing "₹" and "120" separately.
    const raw = String(fiber.memoizedProps ?? '');
    const host = textHostOf(fiber);
    const list = owner ? owner.text : state.texts;
    const last = list[list.length - 1];
    if (last && host && last.host === host) last.text += raw;
    else list.push({ text: raw, fiber, host });
    return;
  }

  if (t === AIScreenAction) {
    const p = fiber.memoizedProps;
    if (str(p?.name) && isFn(p?.onRun)) {
      state.drafts.push({ kind: 'custom_action', fiber, props: p, text: [] });
    }
    return;
  }

  let pushedAnnotation = false;
  if (t === AIAction) {
    state.annotations.push({ name: str(fiber.memoizedProps?.name), description: str(fiber.memoizedProps?.description), used: false });
    pushedAnnotation = true;
  }

  if (owner && !owner.iconName) {
    const iconName = str(fiber.memoizedProps?.name);
    if (iconName && /icon/i.test(displayNameOf(fiber) ?? '')) owner.iconName = iconName;
  }

  let current = owner;
  let chain = onChain;
  const kind = interactiveKind(fiber);
  if (kind && !(owner && onChain)) {
    const annotation = [...state.annotations].reverse().find(a => !a.used);
    if (annotation) annotation.used = true;
    const draft: Draft = { kind, fiber, props: fiber.memoizedProps, text: [], annotation };
    if (kind === 'text_input' || kind === 'switch') {
      draft.wrapperLabel = wrapperLabel(fiber);
      draft.precedingText = precedingText(fiber, state);
    }
    state.drafts.push(draft);
    current = draft;
    chain = true;
  } else if (kind && owner && onChain) {
    // The same control further down its wrapper chain (a Card component with onPress rendering
    // a Pressable): the inner one often carries the real label ("Mini, ₹120, capacity 4") while
    // the outer only has a title. Its explicit label and hint win over the outer's fallbacks.
    adoptLabel(owner, fiber.memoizedProps);
  }

  walk(fiber.child, state, current, chain, depth + 1);
  if (pushedAnnotation) state.annotations.pop();
}

function adoptLabel(owner: Draft, inner: any) {
  const outer = owner.props ?? {};
  const label = str(inner?.accessibilityLabel) ?? str(inner?.['aria-label']);
  const hint = str(inner?.accessibilityHint);
  const hasLabel = str(outer.accessibilityLabel) ?? str(outer['aria-label']);
  if ((label && !hasLabel) || (hint && !str(outer.accessibilityHint))) {
    owner.props = {
      ...outer,
      ...(label && !hasLabel && { accessibilityLabel: label }),
      ...(hint && !str(outer.accessibilityHint) && { accessibilityHint: hint }),
    };
  }
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

const KIND_PREFIX: Record<ElementKind, string> = {
  button: 'btn',
  text_input: 'input',
  switch: 'switch',
  custom_action: 'action',
};

function truncate(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function toElement(d: Draft, maxLen: number): ScreenElement {
  const p = d.props ?? {};
  const a11yLabel = str(p.accessibilityLabel) ?? str(p['aria-label']);
  const testID = str(p.testID);
  const description =
    d.annotation?.description ?? str(p.accessibilityHint) ?? str(p['aria-description']) ?? (d.kind === 'custom_action' ? str(p.description) : undefined);
  const disabled =
    p.disabled === true || p.accessibilityState?.disabled === true || p['aria-disabled'] === true || (d.kind === 'text_input' && p.editable === false);

  const base = {
    kind: d.kind,
    description: truncate(description, maxLen),
    disabled,
    testID,
  };

  switch (d.kind) {
    case 'text_input': {
      const secure = p.secureTextEntry === true;
      const raw = typeof p.value === 'string' ? p.value : typeof p.defaultValue === 'string' ? p.defaultValue : undefined;
      const actions: ActionType[] = ['type'];
      if (isFn(p.onSubmitEditing)) actions.push('submit');
      return {
        ...base,
        id: '',
        label: truncate(a11yLabel ?? d.wrapperLabel ?? str(p.placeholder) ?? d.precedingText ?? testID ?? 'text input', maxLen)!,
        actions,
        placeholder: str(p.placeholder),
        value: secure ? undefined : truncate(raw, maxLen),
        secure: secure || undefined,
        multiline: p.multiline === true || undefined,
        keyboardType: str(p.keyboardType),
        maxLength: typeof p.maxLength === 'number' ? p.maxLength : undefined,
        handlerName: str(p.onChangeText?.name),
      };
    }
    case 'switch':
      return {
        ...base,
        id: '',
        label: truncate(a11yLabel ?? d.wrapperLabel ?? d.precedingText ?? testID ?? 'switch', maxLen)!,
        actions: ['toggle'],
        checked: typeof p.value === 'boolean' ? p.value : undefined,
        handlerName: str(p.onValueChange?.name),
      };
    case 'custom_action':
      return {
        ...base,
        id: '',
        label: p.name,
        actions: ['run'],
        parameters: p.parameters,
      };
    case 'button': {
      const actions: ActionType[] = [];
      if (isFn(p.onPress)) actions.push('press');
      if (isFn(p.onLongPress)) actions.push('long_press');
      const label = a11yLabel ?? str(d.text.map(t => t.text.trim()).filter(Boolean).join(' ')) ?? str(p.title) ?? d.iconName ?? testID ?? str(p.onPress?.name) ?? 'unlabeled button';
      return {
        ...base,
        id: '',
        label: truncate(label, maxLen)!,
        actions,
        handlerName: str(p.onPress?.name) ?? str(p.onLongPress?.name),
      };
    }
  }
}

/** Synchronously walks the current fiber tree from `root` and extracts the interactive surface. */
export function extract(root: Fiber | null, opts: CaptureOptions = {}, getScreenName?: () => string | undefined): Extraction {
  const maxLen = opts.maxTextLength ?? 200;
  const maxTexts = opts.maxTexts ?? 80;
  const state: WalkState = { drafts: [], texts: [], annotations: [] };
  if (root) walk(root.child, state, null, false, 0);

  const entries = new Map<string, ElementEntry>();
  const used = new Map<string, number>();
  const elements: ScreenElement[] = [];
  for (const d of state.drafts) {
    const el = toElement(d, maxLen);
    if (el.disabled && opts.includeDisabled === false) continue;
    const baseId = d.kind === 'custom_action'
      ? `action_${slug(el.label)}`
      : el.testID
        ? slug(el.testID)
        : `${KIND_PREFIX[d.kind]}_${slug(d.annotation?.name ?? el.label) || 'unlabeled'}`;
    const n = (used.get(baseId) ?? 0) + 1;
    used.set(baseId, n);
    el.id = n === 1 ? baseId : `${baseId}_${n}`;
    elements.push(el);
    entries.set(el.id, { element: el, fiber: d.fiber });
  }

  // Keep repeats ("0" for each product's quantity carries meaning); drop only immediate duplicates.
  const texts: string[] = [];
  for (const piece of state.texts) {
    const text = str(piece.text.replace(/\s+/g, ' '));
    if (!text || text === texts[texts.length - 1]) continue;
    texts.push(truncate(text, maxLen)!);
    if (texts.length >= maxTexts) break;
  }

  let screen: string | undefined;
  try {
    screen = getScreenName?.() ?? state.route?.name;
  } catch {
    screen = state.route?.name;
  }

  return { snapshot: { screen, capturedAt: Date.now(), elements, texts, ...(state.loading && { loading: true }) }, entries };
}
