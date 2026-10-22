import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, useWindowDimensions, View } from 'react-native';
import { AIIgnore } from './annotations';
import type { ScreenContextController } from './ScreenContextProvider';

export interface AgentGlowProps {
  controller: ScreenContextController;
  /** Gradient colors, cycled around the border. */
  colors?: string[];
  /** Width of the bright edge line; the soft glow extends ~8x further inward. Default 3. */
  thickness?: number;
  /** Match the device's screen corners. Default 44. */
  cornerRadius?: number;
  /** Time for the colors to travel once around the screen. Default 4000ms. */
  durationMs?: number;
}

const DEFAULT_COLORS = ['#7C5CFF', '#3D8BFF', '#22D3EE', '#FF5CA8', '#FF9F43'];

// Bright line + two progressively wider, fainter layers fake an inward falloff without a blur filter.
const LAYERS = [
  { scale: 1, opacity: 1 },
  { scale: 3.5, opacity: 0.4 },
  { scale: 8, opacity: 0.15 },
];

type Edge = 'top' | 'bottom' | 'left' | 'right';
const EDGES: Edge[] = ['top', 'bottom', 'left', 'right'];

/**
 * Full-screen, touch-transparent glow that flows around the screen edges while the agent is
 * active. Rendered by <ScreenContextProvider> by default; it unmounts its animation when idle.
 */
export function AgentGlow({ controller, colors = DEFAULT_COLORS, thickness = 3, cornerRadius = 44, durationMs = 4000 }: AgentGlowProps) {
  const { width: W, height: H } = useWindowDimensions();
  const [active, setActive] = useState(controller.active);
  const [mounted, setMounted] = useState(controller.active);
  const [reduceMotion, setReduceMotion] = useState(false);
  const fade = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(
    () =>
      controller.subscribe(event => {
        if (event.type === 'active') setActive(event.active);
        if (event.type === 'action') {
          Animated.sequence([
            Animated.timing(pulse, { toValue: 1, duration: 120, useNativeDriver: true }),
            Animated.timing(pulse, { toValue: 0, duration: 450, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          ]).start();
        }
      }),
    [controller, pulse],
  );

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled?.().then(setReduceMotion, () => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', setReduceMotion);
    return () => sub?.remove();
  }, []);

  useEffect(() => {
    if (active) setMounted(true);
    const anim = Animated.timing(fade, { toValue: active ? 1 : 0, duration: active ? 350 : 500, useNativeDriver: true });
    anim.start(({ finished }) => finished && !active && setMounted(false));
    return () => anim.stop();
  }, [active, fade]);

  useEffect(() => {
    if (!mounted || reduceMotion) return;
    spin.setValue(0);
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: durationMs, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [mounted, reduceMotion, durationMs, spin]);

  if (!mounted) return null;

  // A square covering the screen at any rotation, centred on the screen. Each edge strip clips its
  // own copy at screen coordinates, so the four copies read as one gradient spinning behind a mask.
  const D = Math.ceil(Math.hypot(W, H));
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const stops = [...colors, colors[0]].join(', ');
  const gradient = `linear-gradient(90deg, ${stops})`;
  const intensity = Animated.add(1, pulse);

  return (
    <AIIgnore>
      <Animated.View style={[StyleSheet.absoluteFill, styles.root, { borderRadius: cornerRadius, opacity: fade }]}>
        {LAYERS.map((layer, i) => {
          const t = thickness * layer.scale;
          return (
            <Animated.View key={i} style={[StyleSheet.absoluteFill, { opacity: Animated.multiply(intensity, layer.opacity) }]}>
              {EDGES.map(edge => {
                const frame = edgeFrame(edge, t, W, H);
                return (
                  <View key={edge} style={[styles.strip, frame]}>
                    <Animated.View
                      style={{
                        position: 'absolute',
                        width: D,
                        height: D,
                        left: (W - D) / 2 - frame.left,
                        top: (H - D) / 2 - frame.top,
                        backgroundImage: gradient,
                        transform: [{ rotate }],
                      }}
                    />
                  </View>
                );
              })}
            </Animated.View>
          );
        })}
      </Animated.View>
    </AIIgnore>
  );
}

function edgeFrame(edge: Edge, t: number, W: number, H: number) {
  switch (edge) {
    case 'top':
      return { left: 0, top: 0, width: W, height: t };
    case 'bottom':
      return { left: 0, top: H - t, width: W, height: t };
    // Side strips skip the corners the top/bottom strips already cover, so layers don't double up.
    case 'left':
      return { left: 0, top: t, width: t, height: H - 2 * t };
    case 'right':
      return { left: W - t, top: t, width: t, height: H - 2 * t };
  }
}

const styles = StyleSheet.create({
  root: { overflow: 'hidden', zIndex: 2147483647, pointerEvents: 'none' },
  strip: { position: 'absolute', overflow: 'hidden' },
});
