import type { AgentModel, ModelTurn } from './agent';
import { openAITools } from './llm';

export interface OpenAIChatModelOptions {
  /**
   * Your backend route that forwards an OpenAI chat-completions body to the provider (adding the
   * API key) and returns its JSON. Works with any OpenAI-compatible gateway (LiteLLM, vLLM, …).
   */
  endpoint: string;
  model: string;
  headers?: Record<string, string>;
  /** Overrides the system prompt the agent passes in (agent rules + app context). */
  system?: string;
  /** Extra request fields, e.g. { temperature: 0 } or { reasoning_effort: 'low' }. */
  extraBody?: Record<string, unknown>;
}

type ChatMessage = Record<string, unknown> & { role: string };

/** AgentModel over OpenAI-style chat completions with function calling. */
export function openAIChatModel(opts: OpenAIChatModelOptions): AgentModel {
  const tools = openAITools();
  let messages: ChatMessage[] = [];

  async function send(signal: AbortSignal): Promise<ModelTurn> {
    const res = await fetch(opts.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: JSON.stringify({ model: opts.model, messages, tools, tool_choice: 'auto', ...opts.extraBody }),
      signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.choices?.[0]) {
      throw new Error(`Model request failed (${res.status}): ${json?.error?.message ?? JSON.stringify(json)?.slice(0, 200)}`);
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
        { role: 'user', content: `${request}\n\nCurrent screen:\n${screen}` },
      ];
      return send(signal);
    },
    continue(results, signal) {
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      return send(signal);
    },
    followUp(reply, screen, signal) {
      messages.push({ role: 'user', content: `${reply}\n\nCurrent screen:\n${screen}` });
      return send(signal);
    },
  };
}
