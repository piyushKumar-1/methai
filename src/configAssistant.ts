// Turns a MethaiConfig (plain JSON) into a working AssistantConfig. The app adds only what needs
// code: the audio, the phone's voice, the language, who the user is.
import type { AssistantConfig, VoiceIO } from './assistant';
import type { MethaiConfig } from './config';
import { deepgramAgentModel } from './deepgram';
import { elevenLabsAgentModel } from './elevenlabs';
import { withHostedListening } from './hostedListening';
import { withHostedSpeech } from './hostedSpeech';
import { withModelTimeout } from './modelWrappers';
import { openAIChatModel } from './openai';
import { openAIRealtimeModel, type PcmAudioIO } from './realtime';
import type { VoiceInterruptions } from './voiceAudio';

export interface AssistantRuntime {
  /** The phone's speech recognition and voice ('device' configs). */
  deviceVoice?: VoiceIO;
  /** Streaming mic + speaker (speech-to-speech voices, hosted voices). */
  audio?: PcmAudioIO;
  /** The conversation's language (BCP-47), read when a session starts. */
  language?: () => string | undefined;
  /** Who the user is, read when a session starts. */
  userContext?: AssistantConfig['userContext'];
  /** The user's choice between interrupting and taking turns, over the config's default. */
  voiceInterruptions?: () => VoiceInterruptions | undefined;
  /** Model-call tracing (requests, tool calls, timings). */
  log?: (message: string) => void;
  /** Anything else, over the config (event tracing, a greeting function…). */
  overrides?: Partial<AssistantConfig>;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: any;
}

const base = (code?: string) => code?.toLowerCase().split(/[-_]/)[0];

/** Fetches `url` and returns `field` of its JSON (signed URLs from your backend). */
const fetchUrl = (url: string, field: string, fetchImpl?: typeof fetch) => async () => {
  const res = await (fetchImpl ?? fetch)(url);
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body[field]) throw new Error(body.error?.message ?? body.detail?.message ?? `HTTP ${res.status} from ${url}`);
  return { url: String(body[field]) };
};

/**
 * The assistant described by `config`, or undefined when it is turned off (or has no voice). Rebuild
 * it when the config changes (methai.subscribe).
 */
export function toAssistantConfig(config: MethaiConfig, runtime: AssistantRuntime = {}): AssistantConfig | undefined {
  if (config.enabled === false || !config.voice) return undefined;
  const a = config.assistant ?? {};
  const language = () => runtime.language?.();
  const labelPatterns = (config.confirm?.labelPatterns ?? []).map(p => new RegExp(p, 'i'));
  const ids = new Set(config.confirm?.ids ?? []);
  const greetingFor = () => {
    const lang = base(language());
    return (lang && a.greetings?.[lang]) ?? (a.greeting === null ? undefined : a.greeting);
  };

  const behaviour: Omit<AssistantConfig, 'voice' | 'model' | 'realtime'> = {
    // Only when the config has one: otherwise the app's own (runtime.overrides) or the default.
    ...((a.greeting !== undefined || a.greetings) && { greeting: () => greetingFor() }),
    ...(a.farewell && { farewell: a.farewell }),
    ...(a.noInputReply && { noInputReply: a.noInputReply }),
    ...(a.errorReply && { errorReply: a.errorReply }),
    ...(a.conversation && { conversation: a.conversation }),
    ...(a.endOnSilence !== undefined && { endOnSilence: a.endOnSilence }),
    ...(a.stopPhrases && { stopPhrases: a.stopPhrases }),
    ...(a.speakProgress !== undefined && { speakProgress: a.speakProgress }),
    ...(a.resumeWithinMs !== undefined && { resumeWithinMs: a.resumeWithinMs }),
    ...(a.maxSteps !== undefined && { maxSteps: a.maxSteps }),
    ...(a.maxTurns !== undefined && { maxTurns: a.maxTurns }),
    ...(a.noSpeechTimeoutMs !== undefined && { noSpeechTimeoutMs: a.noSpeechTimeoutMs }),
    ...(a.followUpTimeoutMs !== undefined && { followUpTimeoutMs: a.followUpTimeoutMs }),
    ...(a.idleTimeoutMs !== undefined && { idleTimeoutMs: a.idleTimeoutMs }),
    ...(a.systemPrompt && { systemPrompt: a.systemPrompt }),
    ...(config.app && { app: config.app }),
    ...(runtime.userContext && { userContext: runtime.userContext }),
    ...((ids.size || labelPatterns.length) && {
      confirm: { isSensitive: (id: string, label: string | undefined) => ids.has(id) || labelPatterns.some(p => p.test(label ?? '')) },
    }),
  };

  const v = config.voice;
  const needAudio = () => {
    if (!runtime.audio) throw new Error(`methai: a '${v.type}' voice needs runtime.audio`);
    return runtime.audio;
  };
  const common = { WebSocketImpl: runtime.WebSocketImpl };
  let voicePart: Pick<AssistantConfig, never> & ({ voice: VoiceIO; model: any } | { realtime: any });
  switch (v.type) {
    case 'device': {
      if (!runtime.deviceVoice) throw new Error("methai: a 'device' voice needs runtime.deviceVoice");
      const { timeoutMs, ...modelOpts } = v.model;
      const model = openAIChatModel({ ...modelOpts, ...(runtime.log && { log: runtime.log }) });
      const speaking = v.speech
        ? withHostedSpeech(runtime.deviceVoice, {
            endpoint: v.speech.endpoint,
            model: v.speech.model,
            voice: v.speech.voice,
            language: () => v.speech!.language ?? language(),
            audio: needAudio(),
            ...(runtime.fetchImpl && { fetchImpl: runtime.fetchImpl }),
            ...(runtime.log && { onError: e => runtime.log!(`hosted voice failed, using the phone's: ${e.message}`) }),
          })
        : runtime.deviceVoice;
      const voice = v.listen
        ? withHostedListening(speaking, {
            endpoint: v.listen.endpoint,
            model: v.listen.model,
            ...(v.listen.language && { language: v.listen.language }),
            ...(v.listen.endSilenceMs !== undefined && { endSilenceMs: v.listen.endSilenceMs }),
            audio: needAudio(),
            ...(runtime.fetchImpl && { fetchImpl: runtime.fetchImpl }),
            ...(runtime.log && {
              log: (m: string) => runtime.log!(`[listen] ${m}`),
              onError: (e: Error) => runtime.log!(`hosted listening failed, using the phone's: ${e.message}`),
            }),
          })
        : speaking;
      voicePart = { voice, model: timeoutMs ? withModelTimeout(model, timeoutMs) : model };
      break;
    }
    case 'deepgram':
      voicePart = {
        realtime: deepgramAgentModel({
          ...common,
          connect: async () => ({ url: v.url }),
          audio: needAudio(),
          language: () => v.language ?? language(),
          ...(v.listen && { listen: v.listen }),
          ...(v.think && { think: v.think }),
          ...(v.speak && { speak: v.speak }),
        }),
      };
      break;
    case 'elevenlabs':
      voicePart = {
        realtime: elevenLabsAgentModel({
          ...common,
          connect: fetchUrl(v.url, 'signed_url', runtime.fetchImpl),
          ...(v.captionsUrl && { liveTranscript: fetchUrl(v.captionsUrl, 'url', runtime.fetchImpl) }),
          audio: needAudio(),
          ...(v.voiceId && { voiceId: v.voiceId }),
          ...((v.language || language()) && { language: v.language ?? base(language()) }),
        }),
      };
      break;
    case 'openai-realtime':
      voicePart = {
        realtime: openAIRealtimeModel({
          ...common,
          connect: async () => ({ url: v.url }),
          audio: needAudio(),
          ...(v.voice && { voice: v.voice }),
          ...(v.turnDetection && { turnDetection: v.turnDetection }),
          ...(v.eagerness && { eagerness: v.eagerness }),
        }),
      };
      break;
  }
  const assistant = { ...behaviour, ...voicePart } as AssistantConfig;
  // Read live, so the user's switch between interrupting and taking turns applies at once.
  Object.defineProperty(assistant, 'voiceInterruptions', {
    get: () => runtime.voiceInterruptions?.() ?? a.voiceInterruptions ?? 'smart',
    enumerable: true,
    configurable: true,
  });
  return Object.assign(assistant, runtime.overrides);
}
