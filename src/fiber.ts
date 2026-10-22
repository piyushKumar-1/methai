// Minimal, defensive access to React's internal fiber tree. These are private React internals:
// everything here duck-types and tolerates missing fields so a React upgrade degrades the
// extraction instead of crashing the app.

export interface Fiber {
  tag: number;
  type: any;
  elementType: any;
  memoizedProps: any;
  memoizedState: any;
  stateNode: any;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
}

export const FiberTag = {
  ClassComponent: 1,
  HostRoot: 3,
  HostComponent: 5,
  HostText: 6,
  ContextProvider: 10,
  ForwardRef: 11,
  MemoComponent: 14,
  SimpleMemoComponent: 15,
  OffscreenComponent: 22,
} as const;

/** Fiber of a mounted class component instance (React 17+ `_reactInternals`, older `_reactInternalFiber`). */
export function fiberOfInstance(instance: any): Fiber | null {
  return instance?._reactInternals ?? instance?._reactInternalFiber ?? null;
}

/**
 * React keeps two fibers per component (current + alternate). Props/handlers on the alternate can
 * be stale closures, so always walk from the FiberRoot's `current` HostRoot.
 */
export function currentRootOf(fiber: Fiber | null): Fiber | null {
  let node = fiber;
  while (node?.return) node = node.return;
  if (!node || node.tag !== FiberTag.HostRoot) return null;
  return node.stateNode?.current ?? node;
}

export function displayNameOf(fiber: Fiber): string | undefined {
  const t = fiber.elementType ?? fiber.type;
  if (!t) return undefined;
  if (typeof t === 'string') return t;
  return t.displayName ?? t.name ?? t.render?.displayName ?? t.render?.name ?? t.type?.displayName ?? t.type?.name;
}

/** Depth-first search for the first host (native view) fiber at or below `fiber`. */
export function firstHostFiber(fiber: Fiber): Fiber | null {
  if (fiber.tag === FiberTag.HostComponent) return fiber;
  for (let c = fiber.child; c; c = c.sibling) {
    const found = firstHostFiber(c);
    if (found) return found;
  }
  return null;
}

/** Public instance (the thing a `ref` would give you) of a host fiber, on both Paper and Fabric. */
export function publicInstanceOf(hostFiber: Fiber | null): any {
  const node = hostFiber?.stateNode;
  if (!node) return null;
  if (typeof node.measureInWindow === 'function') return node; // Paper
  const canonical = node.canonical;
  if (canonical?.publicInstance) return canonical.publicInstance; // Fabric (RN >= 0.72)
  if (typeof canonical?.measureInWindow === 'function') return canonical; // older Fabric
  return null;
}
