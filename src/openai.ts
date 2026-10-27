import { requestText, type AgentModel, type ModelTurn, type UserRequest } from './agent';
import { openAITools } from './llm';

export interface OpenAIChatModelOptions {
  /**
   * Your backend route that forwards an OpenAI chat-completions body to the provider (adding the
   * API key) and returns its JSON. Works with any OpenAI-compatible gateway (LiteLLM, vLLM, …).
   */
  endpoint: string;
  model: string;
  /**
   * Models to try, in order, when a call fails with a rate limit, a server error or a network
   * error. The conversation carries over. A model that failed is skipped for `cooldownMs`.
   */
  fallbackModels?: string[];
  /** How long a failing model is skipped. Default 30s. */
  cooldownMs?: number;
  /**
   * Gives up on one model after this long and tries the next (an overloaded gateway can take a
   * minute to answer). Only applies while there is a fallback left. Default: no limit.
   */
  attemptTimeoutMs?: number;
  /** Told when a call moves on to a fallback model, for debugging. */
  log?: (message: string) => void;
  headers?: Record<string, string>;
  /** Overrides the system prompt the agent passes in (agent rules + app context). */
  system?: string;
  /** Extra request fields, e.g. { temperature: 0 } or { reasoning_effort: 'low' }. */
  extraBody?: Record<string, unknown>;
}

type ChatMessage = Record<string, unknown> & { role: string };

/** A user message: plain text, or the recorded audio (input_audio) plus the screen as text. */
function userMessage(request: UserRequest, screen: string): ChatMessage {
  const context = `Current screen:\n${screen}`;
  if (typeof request === 'string') return { role: 'user', content: `${request}\n\n${context}` };
  const reading = request.transcript ? `\nOn-device speech recognition read it as (may be wrong; trust the audio): ${request.transcript}` : '';
  return {
    role: 'user',
    content: [
      { type: 'input_audio', input_audio: { data: request.audio, format: request.format } },
      { type: 'text', text: `(The request is the audio above.)${reading}\n\n${context}` },
    ],
    // Kept locally (not sent) to replace the audio in later requests.
    textOnly: `${requestText(request) || '(spoken request)'}\n\n${context}`,
  };
}

/** Earlier spoken turns are resent as their transcripts, so the history doesn't carry every recording. */
const withoutOldAudio = (messages: ChatMessage[]) =>
  messages.map(({ textOnly, ...m }) => (typeof textOnly === 'string' ? { ...m, content: textOnly } : m));

const forWire = (messages: ChatMessage[]) => messages.map(({ textOnly, ...m }) => m);

/** A failure another model (or a moment later) may not have: rate limits, overload, server errors. */
class RetryableModelError extends Error {}

const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

/** AgentModel over OpenAI-style chat completions with function calling. */
export function openAIChatModel(opts: OpenAIChatModelOptions): AgentModel {
  const tools = openAITools();
  let messages: ChatMessage[] = [];
  const models = [opts.model, ...(opts.fallbackModels ?? []).filter(m => m !== opts.model)];
  const cooldownMs = opts.cooldownMs ?? 30_000;
  // When each model may be tried again after failing.
  const coolingUntil = new Map<string, number>();

  async function request(model: string, signal: AbortSignal, timeoutMs: number | undefined) {
    // Its own abort, so a slow attempt can be dropped without ending the whole call.
    const attempt = new AbortController();
    const cancel = () => attempt.abort();
    signal.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            attempt.abort();
          }, timeoutMs);
    let res: Response;
    let json: any;
    try {
      res = await fetch(opts.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        body: JSON.stringify({ model, messages: forWire(messages), tools, tool_choice: 'auto', ...opts.extraBody }),
        signal: attempt.signal,
      });
      json = await res.json().catch(() => null);
    } catch (err) {
      if (signal.aborted) throw err;
      throw new RetryableModelError(timedOut ? `Model request failed: ${model} gave no answer in ${timeoutMs! / 1000}s` : `Model request failed: ${String(err)}`);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
    if (!res.ok || !json?.choices?.[0]) {
      const message = `Model request failed (${res.status}): ${json?.error?.message ?? JSON.stringify(json)?.slice(0, 200)}`;
      throw isRetryableStatus(res.status) ? new RetryableModelError(message) : new Error(message);
    }
    return json;
  }

  async function send(signal: AbortSignal): Promise<ModelTurn> {
    const now = Date.now();
    const ready = models.filter(m => (coolingUntil.get(m) ?? 0) <= now);
    // If every model is cooling down, try them all anyway rather than fail without asking.
    const order = ready.length ? ready : models;
    let json: any;
    for (let i = 0; ; i++) {
      try {
        json = await request(order[i]!, signal, i < order.length - 1 ? opts.attemptTimeoutMs : undefined);
        coolingUntil.delete(order[i]!);
        break;
      } catch (err) {
        if (!(err instanceof RetryableModelError) || i === order.length - 1) throw err;
        coolingUntil.set(order[i]!, Date.now() + cooldownMs);
        opts.log?.(`${order[i]} failed (${(err as Error).message.slice(0, 80)}); trying ${order[i + 1]}`);
      }
    }
    const message = json.choices[0].message ?? {};
    const toolCalls: { id: string; function: { name: string; arguments: string } }[] = message.tool_calls ?? [];
    messages.push({ role: 'assistant', content: message.content ?? '', ...(toolCalls.length && { tool_calls: toolCalls }) });
    return {
      text: typeof message.content === 'string' ? message.content.trim() : undefined,
      toolCalls: toolCalls.map(c => ({ id: c.id, name: c.function.name, input: c.function.arguments })),
    };
  }

  return {
    start(request, screen, signal, instructions) {
      messages = [
        { role: 'system', content: opts.system ?? instructions },
        userMessage(request, screen),
      ];
      return send(signal);
    },
    continue(results, signal) {
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      return send(signal);
    },
    followUp(reply, screen, signal) {
      messages = [...withoutOldAudio(messages), userMessage(reply, screen)];
      return send(signal);
    },
    interrupted(heard) {
      const last = [...messages].reverse().find(m => m.role === 'assistant' && !m.tool_calls);
      if (last) last.content = heard ? `${heard}… (interrupted by the user; they heard only this much)` : `${last.content} (interrupted by the user; they may not have heard all of it)`;
    },
  };
}
