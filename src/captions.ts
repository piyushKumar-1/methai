/** Makes a model reply readable as a caption: drops element ids like [btn_book_ride], markdown and emoji. */
export function toCaptionText(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/\[[a-z0-9_]+\]/gi, '')
    .replace(/[*_#`>]/g, '')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/ ([.,!?])/g, '$1')
    .trim();
}

/**
 * How much of `text` to show `elapsedMs` after it started being spoken, typed out at roughly
 * speaking pace. Cuts at word boundaries so half-words never flash on screen.
 */
export function typedSoFar(text: string, elapsedMs: number, charsPerSecond = 15): string {
  const chars = Math.floor((Math.max(0, elapsedMs) / 1000) * charsPerSecond);
  if (chars >= text.length) return text;
  const cut = text.lastIndexOf(' ', chars);
  return cut <= 0 ? '' : text.slice(0, cut);
}
