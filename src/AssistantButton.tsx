import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { AIIgnore } from './annotations';
import type { AssistantState } from './assistant';
import { useAssistant } from './ScreenContextProvider';

export interface AssistantButtonProps {
  style?: StyleProp<ViewStyle>;
  /** Custom content; gets the current state. Default: mic when idle, skip while speaking, stop otherwise. */
  children?: (state: AssistantState) => ReactNode;
  accessibilityLabel?: string;
}

/**
 * Floating button for the voice assistant: tap to start, tap while it talks to cut it short, tap
 * while it listens to end. Excluded from the screen context so the agent can't press it. Any other
 * button can call useAssistant().toggle instead.
 */
export function AssistantButton({ style, children, accessibilityLabel = 'Voice assistant' }: AssistantButtonProps) {
  const { state, toggle } = useAssistant();
  const running = state !== 'idle';
  return (
    <AIIgnore>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={state === 'idle' ? 'Starts the voice assistant' : state === 'speaking' ? 'Interrupts the answer' : 'Ends the conversation'}
        accessibilityState={{ busy: running }}
        style={({ pressed }) => [styles.fab, pressed && styles.pressed, style]}
      >
        {children ? children(state) : <Text style={styles.glyph}>{state === 'idle' ? '🎙' : state === 'speaking' ? '⏭' : '■'}</Text>}
      </Pressable>
    </AIIgnore>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 40,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111',
    boxShadow: '0 4px 14px rgba(124, 92, 255, 0.45)',
    zIndex: 2147483646,
  },
  pressed: { transform: [{ scale: 0.94 }] },
  glyph: { color: '#fff', fontSize: 22 },
});
