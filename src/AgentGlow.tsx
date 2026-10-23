import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, useWindowDimensions, View } from 'react-native';
import { AIIgnore } from './annotations';
import { background, rgba } from './style';
import type { ScreenContextController, VoicePhase } from './ScreenContextProvider';

export interface AgentGlowProps {
  controller: ScreenContextController;
  /**
   * 'aura' (default): fluid colour blobs along the bottom that swell with the voice and climb the
   * sides as it gets louder. 'edge': a gradient flowing around the whole border.
   */
  variant?: 'aura' | 'edge';
  /** Gradient colours. */
  colors?: string[];
  /** 'edge' only: width of the bright edge line. Default 3. */
  thickness?: number;
  /**
   * Clip the glow to rounded corners. Default 0: the glow runs to the edges and the display's own
   * rounded corners shape it; a radius that doesn't match the device leaves gaps in the corners.
   */
  cornerRadius?: number;
  /** Speed of the flow: time for one full cycle. Default 4000ms (edge) / 7000ms (aura). */
  durationMs?: number;
}

const DEFAULT_COLORS = ['#7C5CFF', '#3D8BFF', '#22D3EE', '#FF5CA8', '#FF9F43'];

/**
 * Touch-transparent overlay shown while an agent session runs. Rendered by <ScreenContextProvider>;
 * unmounted when idle. Everything animates on the native thread: voice levels update an
 * Animated.Value, never React state, so the app never re-renders because of it.
 */
export function AgentGlow({ variant = 'aura', ...props }: AgentGlowProps) {
  const { mounted, fade, reduceMotion } = useGlowVisibility(props.controller);
  if (!mounted) return null;
  return (
    <AIIgnore>
      <Animated.View style={[StyleSheet.absoluteFill, styles.root, { borderRadius: props.cornerRadius ?? 0, opacity: fade }]}>
        {variant === 'edge' ? <EdgeGlow {...props} reduceMotion={reduceMotion} /> : <AuraGlow {...props} reduceMotion={reduceMotion} />}
      </Animated.View>
    </AIIgnore>
  );
}

function useGlowVisibility(controller: ScreenContextController) {
  const [active, setActive] = useState(controller.active);
  const [mounted, setMounted] = useState(controller.active);
  const [reduceMotion, setReduceMotion] = useState(false);
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => controller.subscribe(e => e.type === 'active' && setActive(e.active)), [controller]);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled?.().then(setReduceMotion, () => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', setReduceMotion);
    return () => sub?.remove();
  }, []);

  useEffect(() => {
    if (active) setMounted(true);
    const anim = Animated.timing(fade, { toValue: active ? 1 : 0, duration: active ? 350 : 600, useNativeDriver: true });
    anim.start(({ finished }) => finished && !active && setMounted(false));
    return () => anim.stop();
  }, [active, fade]);

  return { mounted, fade, reduceMotion };
}

/** A looping 0→1 value (native driver). */
function useLoop(durationMs: number, enabled: boolean) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!enabled) return;
    value.setValue(0);
    const loop = Animated.loop(Animated.timing(value, { toValue: 1, duration: durationMs, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [durationMs, enabled, value]);
  return value;
}

type InnerProps = Omit<AgentGlowProps, 'variant'> & { reduceMotion: boolean };

// ─── Aura ────────────────────────────────────────────────────────────────────────────────────

const TICK_MS = 80;

/**
 * Voice level, smoothed with a spring. Real levels come from the mic / model audio; when the
 * engine reports none (e.g. on-device text-to-speech), a speech-like level is synthesised from
 * the phase so the aura still "talks".
 */
function useVoiceLevel(controller: ScreenContextController) {
  const level = useRef(new Animated.Value(0.15)).current;
  useEffect(() => {
    let phase: VoicePhase = 'thinking';
    let lastReal = 0;
    let real = 0;
    let boost = 0;
    let current = 0.15;
    const springTo = (target: number) => {
      if (Math.abs(target - current) < 0.01) return;
      current = target;
      Animated.spring(level, { toValue: target, stiffness: 140, damping: 13, mass: 0.6, useNativeDriver: true }).start();
    };
    const unsubscribe = controller.subscribe(e => {
      if (e.type === 'voice') {
        phase = e.phase;
        if (e.level !== undefined) {
          real = e.level;
          lastReal = Date.now();
        }
      } else if (e.type === 'action') {
        boost = 0.35; // flash on every tap/keystroke the agent makes
      }
    });
    const timer = setInterval(() => {
      const t = Date.now() / 1000;
      const fresh = Date.now() - lastReal < 300;
      let target: number;
      if (fresh && (phase === 'listening' || phase === 'speaking')) {
        target = 0.14 + real * 0.86;
      } else if (phase === 'speaking') {
        const wobble = (Math.sin(t * 7.3) + Math.sin(t * 11.7 + 1) + Math.sin(t * 3.1 + 2)) / 6 + 0.5;
        target = 0.32 + wobble * 0.45 + Math.random() * 0.08;
      } else if (phase === 'listening') {
        target = 0.13 + Math.sin(t * 2.2) * 0.03;
      } else {
        target = 0.22 + Math.sin(t * 4.5) * 0.07; // thinking: steady pulse
      }
      springTo(Math.min(1, target + boost));
      boost *= 0.6;
    }, TICK_MS);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [controller, level]);
  return level;
}

/** Eight-point sine table for a looping horizontal drift. */
function drift(loop: Animated.Value, amplitude: number, offset: number) {
  const steps = 8;
  const inputRange = Array.from({ length: steps + 1 }, (_, i) => i / steps);
  const outputRange = inputRange.map(x => Math.sin(2 * Math.PI * x + offset) * amplitude);
  return loop.interpolate({ inputRange, outputRange });
}

function AuraGlow({ controller, colors = DEFAULT_COLORS, durationMs = 7000, reduceMotion }: InnerProps) {
  const { width: W, height: H } = useWindowDimensions();
  const level = useVoiceLevel(controller);
  const loop = useLoop(durationMs, !reduceMotion);
  const c = (i: number) => colors[i % colors.length];

  // Blobs: wide soft ellipses half below the bottom edge, drifting sideways at different phases.
  const blobs = [0.08, 0.36, 0.64, 0.92].map((x, i) => {
    const bw = W * 0.95;
    const bh = H * 0.3;
    return (
      <Animated.View
        key={i}
        style={{
          position: 'absolute',
          width: bw,
          height: bh,
          left: W * x - bw / 2,
          // Anchored to the overlay's bottom, not the window height: with edge-to-edge layouts the
          // two differ, and a top offset would float the glow above the bottom edge.
          bottom: -bh * 0.5,
          opacity: 0.85,
          ...background(`radial-gradient(closest-side, ${rgba(c(i), 0.85)} 0%, ${rgba(c(i), 0.35)} 45%, ${rgba(c(i), 0)} 100%)`),
          transformOrigin: 'bottom',
          transform: [
            { translateX: reduceMotion ? 0 : drift(loop, W * 0.12, i * 1.7) },
            // At rest a thin band at the bottom edge; loud speech lifts it to about a quarter of the screen.
            { scaleY: Animated.add(0.28 + (i % 2) * 0.06, Animated.multiply(level, 0.95 + (i % 3) * 0.15)) },
            { scaleX: Animated.add(0.85, Animated.multiply(level, 0.3)) },
          ],
        }}
      />
    );
  });

  // Sides: glows anchored in the bottom corners that climb the edges as the level rises.
  const side = (left: boolean, color: string, widthFactor: number, alpha: number, reach: number) => (
    <Animated.View
      style={{
        position: 'absolute',
        bottom: 0,
        [left ? 'left' : 'right']: 0,
        width: W * widthFactor,
        height: H,
        ...background(`radial-gradient(farthest-side at ${left ? '0%' : '100%'} 100%, ${rgba(color, alpha)} 0%, ${rgba(color, alpha * 0.45)} 40%, ${rgba(color, 0)} 100%)`),
        transformOrigin: 'bottom',
        transform: [{ scaleY: Animated.add(0.1, Animated.multiply(level, reach)) }],
      }}
    />
  );

  return (
    <View style={StyleSheet.absoluteFill}>
      {side(true, c(0), 0.28, 0.45, 0.9)}
      {side(false, c(3), 0.28, 0.45, 0.9)}
      {side(true, c(2), 0.05, 0.9, 1)}
      {side(false, c(1), 0.05, 0.9, 1)}
      {blobs}
      <Animated.View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 3,
          ...background(`linear-gradient(90deg, ${[...colors, colors[0]].join(', ')})`),
          opacity: Animated.add(0.35, Animated.multiply(level, 0.65)),
        }}
      />
    </View>
  );
}

// ─── Edge ────────────────────────────────────────────────────────────────────────────────────

// Bright line + two progressively wider, fainter layers fake an inward falloff without a blur filter.
const LAYERS = [
  { scale: 1, opacity: 1 },
  { scale: 3.5, opacity: 0.4 },
  { scale: 8, opacity: 0.15 },
];

type Edge = 'top' | 'bottom' | 'left' | 'right';
const EDGES: Edge[] = ['top', 'bottom', 'left', 'right'];

function EdgeGlow({ controller, colors = DEFAULT_COLORS, thickness = 3, durationMs = 4000, reduceMotion }: InnerProps) {
  const { width: W, height: H } = useWindowDimensions();
  const spin = useLoop(durationMs, !reduceMotion);
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(
    () =>
      controller.subscribe(event => {
        if (event.type !== 'action') return;
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1, duration: 120, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 0, duration: 450, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        ]).start();
      }),
    [controller, pulse],
  );

  // A square covering the screen at any rotation, centred on the screen. Each edge strip clips its
  // own copy at screen coordinates, so the four copies read as one gradient spinning behind a mask.
  const D = Math.ceil(Math.hypot(W, H));
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const gradient = `linear-gradient(90deg, ${[...colors, colors[0]].join(', ')})`;
  const intensity = Animated.add(1, pulse);

  return (
    <>
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
                      ...background(gradient),
                      transform: [{ rotate }],
                    }}
                  />
                </View>
              );
            })}
          </Animated.View>
        );
      })}
    </>
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
