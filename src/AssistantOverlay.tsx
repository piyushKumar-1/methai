import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { AIIgnore } from './annotations';
import { toCaptionText, typedSoFar } from './captions';
import { useAssistant } from './ScreenContextProvider';
import { background } from './style';

export interface AssistantTheme {
  /** Button fill. Two colours make a diagonal gradient. Default '#111'. */
  background?: string | [string, string];
  /** Icon colour on the button. Default '#fff'. */
  foreground?: string;
  /** Listening ring and the edge of the reply bubble. Default '#7C5CFF'. */
  accent?: string;
  /** Speech bubble. Defaults: white with near-black text. */
  bubbleBackground?: string;
  bubbleText?: string;
  fontFamily?: string;
}

export interface AssistantPosition {
  /** Screen edge the button docks to. Default 'right'. */
  side?: 'right' | 'left';
  /** Centre of the button, as a fraction of the window height. Default 0.42. */
  vertical?: number;
  /** Button height. Default 52. */
  size?: number;
}

export interface AssistantOverlayProps {
  theme?: AssistantTheme;
  position?: AssistantPosition;
  /** Idle icon. Default: a mic drawn in `theme.foreground`. */
  icon?: ReactNode;
  /** Long-press the button to type a request instead of speaking (handy on emulators). */
  typeToAsk?: boolean;
  /** Show what is being said in a bubble next to the button. Default true. */
  captions?: boolean;
  /** Typing pace of the reply in the bubble, in characters a second. Default 15. */
  captionCharsPerSecond?: number;
  accessibilityLabel?: string;
}

/**
 * The voice assistant's on-screen UI: a button docked to the screen edge (tap to start, tap while it
 * talks to skip, tap while it listens to end) and a bubble beside it with what is being said —
 * the user's words while listening, the reply typed out while it is spoken. Mount it anywhere
 * inside <ScreenContextProvider assistant={…}>; the agent never sees or presses it.
 */
export function AssistantOverlay({
  theme = {},
  position = {},
  icon,
  typeToAsk = false,
  captions = true,
  captionCharsPerSecond = 15,
  accessibilityLabel = 'Voice assistant',
}: AssistantOverlayProps) {
  const { state, transcript, log, toggle, submitText } = useAssistant();
  const { height } = useWindowDimensions();
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');

  const size = position.size ?? 52;
  const left = position.side === 'left';
  const fg = theme.foreground ?? '#fff';
  const accent = theme.accent ?? '#7C5CFF';
  const fill = theme.background ?? '#111';
  const speaking = state === 'speaking' || state === 'greeting';
  const thinking = state === 'thinking';

  const reply = speaking ? toCaptionText([...log].reverse().find(m => m.role === 'assistant')?.text) : '';
  const shownReply = useTypewriter(reply, captionCharsPerSecond);
  const heard = state === 'listening' || thinking ? transcript.trim() : '';
  const caption = speaking ? shownReply : heard;

  const submit = () => {
    setTyping(false);
    setTyped('');
    submitText(typed);
  };

  return (
    <AIIgnore>
      <View
        pointerEvents="box-none"
        style={[styles.dock, left ? { left: 0, flexDirection: 'row' } : { right: 0, flexDirection: 'row-reverse' }, { top: Math.round(height * (position.vertical ?? 0.42) - size / 2) }]}
      >
        <Pressable
          onPress={toggle}
          onLongPress={typeToAsk ? () => setTyping(t => !t) : undefined}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={state === 'idle' ? 'Starts the voice assistant' : speaking ? 'Skips the rest of the answer' : 'Ends the conversation'}
          accessibilityState={{ busy: thinking }}
          hitSlop={8}
          style={({ pressed }) => [
            styles.button,
            {
              width: size + 6,
              height: size,
              ...(left
                ? { paddingLeft: 6, borderTopRightRadius: size / 2, borderBottomRightRadius: size / 2 }
                : { paddingRight: 6, borderTopLeftRadius: size / 2, borderBottomLeftRadius: size / 2 }),
            },
            typeof fill === 'string' ? { backgroundColor: fill } : background(`linear-gradient(135deg, ${fill[0]}, ${fill[1]})`),
            pressed && styles.pressed,
          ]}
        >
          {state === 'listening' && <Pulse color={accent} size={size} />}
          {thinking ? <Dots color={fg} /> : speaking ? <View style={[styles.stop, { backgroundColor: fg }]} /> : icon ?? <MicGlyph color={fg} />}
        </Pressable>
        {typing ? (
          <View style={[styles.bubble, bubbleSide(left), { backgroundColor: theme.bubbleBackground ?? '#fff' }]}>
            <TextInput
              value={typed}
              onChangeText={setTyped}
              onSubmitEditing={submit}
              placeholder="Type a request…"
              returnKeyType="send"
              autoFocus
              style={[styles.input, { color: theme.bubbleText ?? '#111', fontFamily: theme.fontFamily }]}
              accessibilityLabel="Type a request for the assistant"
            />
          </View>
        ) : (
          captions &&
          caption.length > 0 && (
            <View
              pointerEvents="none"
              accessibilityLiveRegion="polite"
              style={[
                styles.bubble,
                bubbleSide(left),
                { backgroundColor: theme.bubbleBackground ?? '#fff' },
                speaking && (left ? { borderRightWidth: 3, borderRightColor: accent } : { borderLeftWidth: 3, borderLeftColor: accent }),
              ]}
            >
              <Text numberOfLines={speaking ? 5 : 2} style={[styles.caption, { color: theme.bubbleText ?? '#111', fontFamily: theme.fontFamily }]}>
                {caption}
              </Text>
            </View>
          )
        )}
      </View>
    </AIIgnore>
  );
}

/** `text` revealed word by word from when it changes; '' when it is empty. */
function useTypewriter(text: string, charsPerSecond: number): string {
  const [shown, setShown] = useState('');
  useEffect(() => {
    setShown('');
    if (!text) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const next = typedSoFar(text, Date.now() - startedAt, charsPerSecond);
      setShown(next);
      if (next === text) clearInterval(timer);
    }, 60);
    return () => clearInterval(timer);
  }, [text, charsPerSecond]);
  return shown;
}

const bubbleSide = (left: boolean) => (left ? { marginLeft: 8 } : { marginRight: 8 });

function useLoop(make: (value: Animated.Value) => Animated.CompositeAnimation): Animated.Value {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(make(value));
    loop.start();
    return () => loop.stop();
    // Runs once per mount; `make` is a fresh closure every render.
  }, [value]);
  return value;
}

function Pulse({ color, size }: { color: string; size: number }) {
  const t = useLoop(v => Animated.timing(v, { toValue: 1, duration: 1300, easing: Easing.out(Easing.quad), useNativeDriver: true }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.ring,
        { width: size, height: size, borderRadius: size / 2, borderColor: color },
        { opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }), transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] }) }] },
      ]}
    />
  );
}

function Dots({ color }: { color: string }) {
  const t = useLoop(v => Animated.timing(v, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }));
  return (
    <View style={styles.dots}>
      {[0, 1, 2].map(i => (
        <Animated.View
          key={i}
          style={[
            styles.dot,
            { backgroundColor: color },
            // Each dot peaks a third of a cycle after the previous one.
            { opacity: t.interpolate({ inputRange: [0, 0.33, 0.66, 1], outputRange: [i === 0 ? 1 : 0.25, i === 1 ? 1 : 0.25, i === 2 ? 1 : 0.25, i === 0 ? 1 : 0.25] }) },
          ]}
        />
      ))}
    </View>
  );
}

/** A microphone made of views, so the library needs no icon or SVG dependency. */
function MicGlyph({ color }: { color: string }) {
  return (
    <View style={styles.mic}>
      <View style={[styles.micHead, { backgroundColor: color }]} />
      <View style={[styles.micCup, { borderColor: color }]} />
      <View style={[styles.micStem, { backgroundColor: color }]} />
      <View style={[styles.micBase, { backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { position: 'absolute', alignItems: 'center', zIndex: 2147483646 },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  pressed: { opacity: 0.85 },
  ring: { position: 'absolute', borderWidth: 3 },
  dots: { flexDirection: 'row', gap: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  stop: { width: 14, height: 14, borderRadius: 3 },
  mic: { width: 20, height: 26 },
  micHead: { position: 'absolute', left: 5, top: 0, width: 10, height: 15, borderRadius: 5 },
  micCup: { position: 'absolute', left: 1, top: 7, width: 18, height: 12, borderWidth: 2, borderTopWidth: 0, borderBottomLeftRadius: 9, borderBottomRightRadius: 9 },
  micStem: { position: 'absolute', left: 9, top: 19, width: 2, height: 5 },
  micBase: { position: 'absolute', left: 5, top: 24, width: 10, height: 2, borderRadius: 1 },
  bubble: {
    maxWidth: 260,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
  caption: { fontSize: 15, lineHeight: 21 },
  input: { minWidth: 200, paddingVertical: 4, fontSize: 15 },
});
