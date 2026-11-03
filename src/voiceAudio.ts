// Mic and speaker plumbing shared by the voice transports: the echo-aware barge-in, the playback
// clock, speech detection from loudness, and live captions from a speech-to-text side stream.
import { floatToPcm16Base64, pcm16Base64ToFloat, pcmLevel } from './pcm';
import type { PcmAudioIO, RealtimeConnection } from './realtime';
import { isInterruption } from './speech';

const RATE = 24000; // PcmAudioIO's rate
/** Mic loudness (pcmLevel) that counts as the user talking, for this many 100 ms chunks in a row. */
const SPEECH_LEVEL = 0.3;
const SPEECH_CHUNKS = 3;
/** Echo in the room outlasts the audio by a moment. */
const ECHO_TAIL_MS = 300;
/** Mic audio kept while the agent talks, handed over when the user cuts in (their first words). */
const HELD_MS = 1500;
/** The user's voice must be this much louder than the agent's echo usually is. */
const BARGE_IN_LOUDNESS = 2.5;
/** New words (not the agent's, garbled or not) in the captions that mean the user is talking over it. */
const BARGE_IN_WORDS = 2;

/**
 * How the user can cut the agent off by talking:
 * - 'smart' (default): the mic is held back from the agent while it talks, so it never hears its
 *   own voice, and checked here: words in the live captions that the agent isn't saying, or a voice
 *   clearly louder than its echo, cut it off and pass the user's words on.
 * - 'raw': the mic always goes to the agent (only where echo cancellation is reliable).
 * - 'off': only a tap cuts it off.
 */
export type VoiceInterruptions = 'smart' | 'raw' | 'off';

export interface VoiceAudioOptions {
  voiceInterruptions: VoiceInterruptions;
  /**
   * Live captions: a Scribe realtime speech-to-text URL (single-use token included), fed the same
   * mic audio. Its partial transcripts reach `onCaption` while the user talks; they also let
   * 'smart' interruptions tell the user's words from the agent's echo.
   */
  liveTranscript?: () => Promise<RealtimeConnection>;
  onCaption?: (text: string, final: boolean) => void;
  onMicLevel?: (level: number) => void;
  /** The user is talking (sustained loudness), before any transcript exists. */
  onSpeech?: () => void;
  /** The user talked over the agent ('smart'): its voice has been stopped. */
  onBargeIn?: () => void;
  WebSocketImpl?: any;
}

export interface VoiceAudio {
  /** Opens the mic (once). `send` gets 24 kHz PCM16 base64 chunks for the agent. */
  startMic(send: (chunk: string) => void): Promise<void>;
  /** Queues the agent's audio (24 kHz PCM16 base64); returns its loudness. */
  play(chunk: string): number;
  /** What the agent is saying (so its echo in the captions can be recognised). */
  agentSays(text: string): void;
  /** Stops the agent's voice now. */
  flush(): void;
  /** The agent's voice is playing (or just stopped, while the room still echoes it). */
  speaking(): boolean;
  drained(): Promise<void>;
  /** Stops the mic and captions; lets queued audio finish unless `abrupt`. */
  close(abrupt: boolean): Promise<void>;
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 45 → "forty five": the agent's text has digits, its echo in a transcript has words. */
function spellNumber(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${spellNumber(n % 100)}` : ''}`;
  if (n < 100000) return `${spellNumber(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${spellNumber(n % 1000)}` : ''}`;
  return String(n);
}

const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/\d+/g, d => ` ${spellNumber(Number(d))} ${d} `)
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(' ')
    .filter(Boolean);

/** Too common to tell the user from the agent. */
const FILLER = new Set(['the', 'and', 'for', 'you', 'your', 'are', 'was', 'with', 'that', 'this', 'its', "it's", 'yes', 'okay', 'can', 'will', 'have', 'has', 'not', 'but', 'from', 'what', 'all']);

/** Words in `heard` that don't sound like any word of `spoken` (echo comes back garbled, not new). */
export function newWords(heard: string, spoken: string): string[] {
  const said = words(spoken);
  const soundsSaid = (w: string) => said.some(s => s === w || (w.length >= 3 && s.length >= 3 && (s.startsWith(w.slice(0, 3)) || w.startsWith(s.slice(0, 3)))));
  return words(heard).filter(w => w.length >= 3 && !FILLER.has(w) && !soundsSaid(w));
}

export function voiceAudio(audio: PcmAudioIO, opts: VoiceAudioOptions): VoiceAudio {
  let playingUntil = 0;
  let capturing = false;
  let closed = false;
  let loudChunks = 0;
  let captions: any = null;
  let send: ((chunk: string) => void) | null = null;
  // While the agent talks: what it's saying, the loudness of its voice, and how loud its echo is
  // at the mic relative to that (learned while the user is quiet).
  let agentText = '';
  let agentLevel = 0;
  let echoRatio = 0;
  let echoSamples = 0;
  let held: string[] = [];
  const speaking = () => Date.now() < playingUntil + ECHO_TAIL_MS;
  const smart = opts.voiceInterruptions === 'smart';

  const stopAgent = () => {
    audio.flush();
    playingUntil = 0;
    loudChunks = 0;
  };

  /** The user cut in: stop the agent and pass on what they said while it was talking. */
  const bargeIn = () => {
    if (!speaking()) return;
    stopAgent();
    opts.onBargeIn?.();
    const said = held;
    held = [];
    for (const chunk of said) send?.(chunk);
  };

  // Captions are a nicety: if the speech-to-text stream can't open, the conversation goes on without it.
  const openCaptions = () => {
    if (!opts.liveTranscript) return;
    const WS = opts.WebSocketImpl ?? (globalThis as any).WebSocket;
    void opts
      .liveTranscript()
      .then(conn => {
        if (closed) return;
        captions = new WS(conn.url, conn.protocols ?? [], conn.headers ? { headers: conn.headers } : undefined);
        captions.onmessage = (msg: { data: string }) => {
          let event: any;
          try {
            event = JSON.parse(msg.data);
          } catch {
            return;
          }
          const text = String(event.text ?? '').trim();
          if (!text || closed) return;
          if (speaking()) {
            // The mic hears the agent too: only words it isn't saying (or "wait", "stop"…) are the user's.
            const isUser = isInterruption(text, agentText) || newWords(text, agentText).length >= BARGE_IN_WORDS;
            if (smart && isUser) bargeIn();
            if (!isUser || speaking()) return;
          }
          if (event.message_type === 'partial_transcript') opts.onCaption?.(text, false);
          else if (event.message_type === 'committed_transcript') opts.onCaption?.(text, true);
        };
        captions.onerror = () => {};
      })
      .catch(() => {});
  };

  return {
    speaking,

    async startMic(sendChunk) {
      if (capturing) return;
      capturing = true;
      send = sendChunk;
      openCaptions();
      await audio.startCapture(chunk => {
        if (closed) return;
        const level = pcmLevel(chunk);
        const talking = speaking();
        if (captions?.readyState === 1 && (smart || !talking)) captions.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: chunk, sample_rate: RATE }));

        if (talking && opts.voiceInterruptions !== 'raw') {
          // Held back so the agent never hears itself; silence keeps its stream in time.
          sendChunk(floatToPcm16Base64(new Float32Array(pcm16Base64ToFloat(chunk).length)));
          if (!smart) return;
          held.push(chunk);
          if (held.length > HELD_MS / 100) held.shift();
          // Louder than its echo could be, for a moment: the user is talking over it.
          const expected = echoRatio * agentLevel;
          if (echoSamples >= 10 && level >= SPEECH_LEVEL && level > expected * BARGE_IN_LOUDNESS) loudChunks++;
          else {
            loudChunks = 0;
            if (agentLevel > 0.05) {
              echoRatio = (echoRatio * echoSamples + level / agentLevel) / (echoSamples + 1);
              echoSamples = Math.min(echoSamples + 1, 50);
            }
          }
          if (loudChunks >= SPEECH_CHUNKS) bargeIn();
          return;
        }
        held = [];
        sendChunk(chunk);
        opts.onMicLevel?.(level);
        loudChunks = level >= SPEECH_LEVEL ? loudChunks + 1 : 0;
        if (loudChunks === SPEECH_CHUNKS) opts.onSpeech?.();
      });
    },

    play(chunk) {
      audio.play(chunk);
      // PCM16 mono 24 kHz: 48 bytes per ms, 4 base64 characters per 3 bytes.
      playingUntil = Math.max(playingUntil, Date.now()) + (chunk.length * 3) / 4 / 48;
      const level = pcmLevel(chunk);
      agentLevel = agentLevel ? agentLevel * 0.8 + level * 0.2 : level;
      return level;
    },

    agentSays(text) {
      // The last few replies: echo can lag behind, and more of its words only makes the check stricter.
      agentText = `${agentText} ${text}`.trim().slice(-600);
    },

    flush: stopAgent,

    drained: () => audio.drained(),

    async close(abrupt) {
      if (closed) return;
      closed = true;
      try {
        captions?.close();
      } catch {}
      try {
        if (abrupt) audio.flush();
        if (capturing) await audio.stopCapture();
        if (!abrupt) await audio.drained();
      } catch {}
    },
  };
}
