import type { ElementEntry } from './extract';
import { firstHostFiber, publicInstanceOf } from './fiber';
import type { ActionResult, ScreenAction } from './types';

/** Just enough of a GestureResponderEvent for handlers that read or persist the event. */
function syntheticPressEvent(entry: ElementEntry): any {
  const b = entry.element.bounds;
  const x = b ? b.x + b.width / 2 : 0;
  const y = b ? b.y + b.height / 2 : 0;
  const nativeEvent = { locationX: b ? b.width / 2 : 0, locationY: b ? b.height / 2 : 0, pageX: x, pageY: y, timestamp: Date.now(), target: 0, identifier: 0, touches: [], changedTouches: [] };
  return {
    nativeEvent,
    currentTarget: 0,
    target: 0,
    bubbles: false,
    cancelable: false,
    defaultPrevented: false,
    isTrusted: false,
    timeStamp: Date.now(),
    type: 'press',
    persist() {},
    preventDefault() {},
    stopPropagation() {},
    isDefaultPrevented: () => false,
    isPropagationStopped: () => false,
    isPersistent: () => true,
  };
}

const textEvent = (text: string) => ({ nativeEvent: { text, eventCount: 0, target: 0 }, persist() {}, preventDefault() {} });

/**
 * Performs `action` on `entry`, using the props of the *current* fiber so handlers see fresh
 * state. Returns once the handler (and any promise it returns) has settled.
 */
export async function performAction(entry: ElementEntry, action: ScreenAction): Promise<ActionResult> {
  const { element, fiber } = entry;
  const p = fiber.memoizedProps ?? {};
  if (element.disabled) return { ok: false, error: `Element "${element.id}" is disabled.` };
  if (!element.actions.includes(action.type)) {
    return { ok: false, error: `Element "${element.id}" (${element.kind}) does not support "${action.type}". Supported: ${element.actions.join(', ')}.` };
  }

  try {
    switch (action.type) {
      case 'press':
        return { ok: true, result: await p.onPress(syntheticPressEvent(entry)) };
      case 'long_press':
        return { ok: true, result: await p.onLongPress(syntheticPressEvent(entry)) };
      case 'type': {
        const text = element.maxLength !== undefined ? action.text.slice(0, element.maxLength) : action.text;
        p.onChangeText?.(text);
        p.onChange?.(textEvent(text));
        if (p.value === undefined) {
          // Uncontrolled input: nothing in JS owns the value, so push it to the native view.
          publicInstanceOf(firstHostFiber(fiber))?.setNativeProps?.({ text });
        }
        return { ok: true };
      }
      case 'submit':
        return { ok: true, result: await p.onSubmitEditing(textEvent(typeof p.value === 'string' ? p.value : '')) };
      case 'toggle': {
        const next = action.value ?? !p.value;
        return { ok: true, result: await p.onValueChange(next) };
      }
      case 'run':
        return { ok: true, result: await p.onRun(action.args ?? {}) };
    }
  } catch (e: any) {
    return { ok: false, error: `Handler threw: ${e?.message ?? String(e)}` };
  }
}
