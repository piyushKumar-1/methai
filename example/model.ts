// AgentModel over your backend (see server.ts). The app keeps the conversation history and the
// backend holds the API key, so no key ships in the app.
import type { BetaMessage, BetaMessageParam, BetaToolResultBlockParam, BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages';
import type { AgentModel, ModelTurn } from '../src';

export interface BackendModelOptions {
  /** POST endpoint that forwards { system, messages } to screenAgentTurn() and returns the message. */
  endpoint: string;
  headers?: Record<string, string>;
}

export function backendModel({ endpoint, headers }: BackendModelOptions): AgentModel {
  let messages: BetaMessageParam[] = [];
  let system = '';

  async function send(signal: AbortSignal): Promise<ModelTurn> {
    for (;;) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ system, messages }),
        signal,
      });
      if (!res.ok) throw new Error(`Assistant backend returned ${res.status}`);
      const response: BetaMessage = await res.json();
      // Echo the full content back unchanged (reasoning blocks included).
      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'refusal') return { text: "Sorry, I can't help with that.", toolCalls: [] };
      if (response.stop_reason === 'pause_turn') continue;

      const text = response.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join(' ').trim();
      const toolCalls = response.stop_reason === 'tool_use'
        ? response.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input }))
        : [];
      return { text, toolCalls };
    }
  }

  return {
    start(request, screen, signal, instructions) {
      system = instructions;
      messages = [{ role: 'user', content: `${request}\n\nCurrent screen:\n${screen}` }];
      return send(signal);
    },
    continue(results, signal) {
      // All results of one turn go back in a single message.
      const content: BetaToolResultBlockParam[] = results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: r.isError }));
      messages.push({ role: 'user', content });
      return send(signal);
    },
  };
}
