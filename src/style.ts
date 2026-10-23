/**
 * CSS gradient as a background. React Native ≤0.8x only reads it from `experimental_backgroundImage`
 * (an unknown `backgroundImage` key is dropped silently); newer versions read `backgroundImage`.
 */
export function background(image: string): Record<string, string> {
  return { backgroundImage: image, experimental_backgroundImage: image };
}

/** `#rgb` / `#rrggbb` (alpha ignored) with the given alpha. Other colour strings pass through. */
export function rgba(color: string, alpha: number): string {
  if (!color.startsWith('#')) return color;
  const h = color.slice(1);
  const n = parseInt(h.length === 3 ? h.replace(/./g, c => c + c) : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
