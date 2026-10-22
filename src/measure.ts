import { Dimensions } from 'react-native';
import type { ElementEntry } from './extract';
import { firstHostFiber, publicInstanceOf } from './fiber';
import type { Bounds } from './types';

const MEASURE_TIMEOUT_MS = 250;

function measureInWindow(instance: any): Promise<Bounds | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), MEASURE_TIMEOUT_MS);
    try {
      instance.measureInWindow((x: number, y: number, width: number, height: number) => {
        clearTimeout(timer);
        resolve(Number.isFinite(x) ? { x, y, width, height } : null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/**
 * Attaches window bounds to each entry and returns the ids that are definitely not visible
 * (zero-sized or entirely outside the window). Entries that can't be measured are kept.
 */
export async function measureEntries(entries: Iterable<ElementEntry>): Promise<Set<string>> {
  const { width: W, height: H } = Dimensions.get('window');
  const hidden = new Set<string>();
  await Promise.all(
    [...entries].map(async entry => {
      if (entry.element.kind === 'custom_action') return;
      const instance = publicInstanceOf(firstHostFiber(entry.fiber));
      if (typeof instance?.measureInWindow !== 'function') return;
      const b = await measureInWindow(instance);
      if (!b) return;
      entry.element.bounds = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
      const offscreen = b.x + b.width <= 0 || b.y + b.height <= 0 || b.x >= W || b.y >= H;
      if (b.width <= 0 || b.height <= 0 || offscreen) hidden.add(entry.element.id);
    }),
  );
  return hidden;
}
