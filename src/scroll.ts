import { Dimensions } from 'react-native';
import { Fiber, FiberTag, firstHostFiber, publicInstanceOf } from './fiber';
import { measureInWindow } from './measure';
import type { Bounds } from './types';

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/** How far one scroll goes, as a share of the visible length (keeps some overlap for context). */
const PAGE = 0.8;

/**
 * Where a scroll in `direction` should land: one page on from `offset`, clamped to the content.
 * Returns null when it is already at that end.
 */
export function nextScrollOffset(offset: number, viewport: number, content: number, direction: ScrollDirection): number | null {
  const max = Math.max(0, content - viewport);
  const forward = direction === 'down' || direction === 'right';
  const next = Math.min(max, Math.max(0, offset + (forward ? 1 : -1) * viewport * PAGE));
  return Math.abs(next - offset) < 1 ? null : Math.round(next);
}

export interface Scrollable {
  fiber: Fiber;
  /** The ScrollView component instance (has scrollTo). */
  instance: { scrollTo: (o: { x?: number; y?: number; animated?: boolean }) => void };
  horizontal: boolean;
}

const isScrollView = (fiber: Fiber) =>
  fiber.tag === FiberTag.ClassComponent && typeof fiber.stateNode?.scrollTo === 'function' && typeof fiber.stateNode?.getScrollResponder === 'function';

/** Hidden subtrees: unfocused navigation screens and views hidden from accessibility. */
function isHiddenSubtree(fiber: Fiber): boolean {
  const p = fiber.memoizedProps;
  if (fiber.tag === FiberTag.OffscreenComponent) return p?.mode === 'hidden';
  if (fiber.tag === FiberTag.ContextProvider) {
    const nav = p?.value;
    if (nav && typeof nav.isFocused === 'function' && typeof nav.navigate === 'function') {
      try {
        return nav.isFocused() === false;
      } catch {
        return false;
      }
    }
  }
  return !!p && typeof p === 'object' && (p.importantForAccessibility === 'no-hide-descendants' || p.accessibilityElementsHidden === true);
}

/** Every mounted ScrollView (FlatList, SectionList and gesture-handler lists render one too), outermost first. */
export function findScrollables(root: Fiber | null): Scrollable[] {
  const found: Scrollable[] = [];
  const visit = (fiber: Fiber | null) => {
    for (let n = fiber; n; n = n.sibling) {
      if (isHiddenSubtree(n)) continue;
      if (isScrollView(n)) found.push({ fiber: n, instance: n.stateNode, horizontal: n.memoizedProps?.horizontal === true });
      visit(n.child);
    }
  };
  visit(root?.child ?? null);
  return found;
}

function contains(ancestor: Fiber, node: Fiber): boolean {
  for (let n: Fiber | null = node; n; n = n.return) if (n === ancestor || n === (ancestor as any).alternate) return true;
  return false;
}

/** The scroll view's frame and its content's frame, in window coordinates. */
async function geometry(s: Scrollable): Promise<{ frame: Bounds; content: Bounds } | null> {
  const host = firstHostFiber(s.fiber);
  const contentHost = host?.child ? firstHostFiber(host.child) : null;
  const frameOf = publicInstanceOf(host);
  const contentOf = publicInstanceOf(contentHost);
  if (!frameOf || !contentOf) return null;
  const [frame, content] = await Promise.all([measureInWindow(frameOf), measureInWindow(contentOf)]);
  return frame && content ? { frame, content } : null;
}

const area = (b: Bounds) => Math.max(0, b.width) * Math.max(0, b.height);

/**
 * Scrolls one page in `direction`: in the list that contains `inside` when given, otherwise in the
 * largest visible list that scrolls that way. Returns what happened, for the model.
 */
export async function scrollScreen(
  root: Fiber | null,
  direction: ScrollDirection,
  inside?: Fiber,
  measure: (s: Scrollable) => Promise<{ frame: Bounds; content: Bounds } | null> = geometry,
): Promise<{ ok: boolean; message: string }> {
  const horizontal = direction === 'left' || direction === 'right';
  const { width: W, height: H } = Dimensions.get('window');
  const candidates = findScrollables(root).filter(s => s.horizontal === horizontal && (!inside || contains(s.fiber, inside)));
  const measured = (await Promise.all(candidates.map(async s => ({ s, g: await measure(s) })))).filter(
    (m): m is { s: Scrollable; g: { frame: Bounds; content: Bounds } } =>
      !!m.g && m.g.frame.width > 0 && m.g.frame.height > 0 && m.g.frame.y < H && m.g.frame.y + m.g.frame.height > 0 && m.g.frame.x < W && m.g.frame.x + m.g.frame.width > 0,
  );
  // With an element: the innermost list around it. Otherwise: the biggest one on screen.
  const target = inside ? measured[measured.length - 1] : [...measured].sort((a, b) => area(b.g.frame) - area(a.g.frame))[0];
  if (!target) return { ok: false, message: `Nothing on screen scrolls ${horizontal ? 'sideways' : 'up or down'}${inside ? ' around that element' : ''}.` };

  const { frame, content } = target.g;
  const offset = horizontal ? frame.x - content.x : frame.y - content.y;
  const viewport = horizontal ? frame.width : frame.height;
  const length = horizontal ? content.width : content.height;
  const next = nextScrollOffset(offset, viewport, length, direction);
  if (next === null) return { ok: true, message: `Already at the ${direction === 'down' || direction === 'right' ? 'end' : 'start'} of the list.` };
  target.s.instance.scrollTo(horizontal ? { x: next, animated: true } : { y: next, animated: true });
  return { ok: true, message: `Scrolled ${direction}.` };
}
