// PCM16 little-endian <-> Float32 and base64, without relying on atob/btoa or Buffer.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Uint8Array(128);
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i;

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[n >> 18] + B64[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64_INDEX[clean.charCodeAt(i)] << 18) |
      (B64_INDEX[clean.charCodeAt(i + 1)] << 12) |
      ((B64_INDEX[clean.charCodeAt(i + 2)] ?? 0) << 6) |
      (B64_INDEX[clean.charCodeAt(i + 3)] ?? 0);
    if (o < bytes.length) bytes[o++] = n >> 16;
    if (o < bytes.length) bytes[o++] = (n >> 8) & 255;
    if (o < bytes.length) bytes[o++] = n & 255;
  }
  return bytes;
}

export function floatToPcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const v = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    bytes[2 * i] = v & 255;
    bytes[2 * i + 1] = (v >> 8) & 255;
  }
  return bytesToBase64(bytes);
}

export function pcm16Base64ToFloat(b64: string): Float32Array<ArrayBuffer> {
  const bytes = base64ToBytes(b64);
  const out = new Float32Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) {
    let v = bytes[2 * i] | (bytes[2 * i + 1] << 8);
    if (v >= 0x8000) v -= 0x10000;
    out[i] = v / 0x8000;
  }
  return out;
}

/** Linear resampling; good enough for speech. */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const out = new Float32Array(Math.round((samples.length * toRate) / fromRate));
  const step = fromRate / toRate;
  for (let i = 0; i < out.length; i++) {
    const pos = i * step;
    const j = Math.floor(pos);
    const a = samples[j] ?? 0;
    const b = samples[j + 1] ?? a;
    out[i] = a + (b - a) * (pos - j);
  }
  return out;
}
