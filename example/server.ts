// Backend side: holds the API key and calls the model. The app never talks to the provider directly.
// Mount `screenAgentTurn` behind any HTTP framework, e.g. POST /screen-agent/turn.
import Anthropic from '@anthropic-ai/sdk';
// The llm module has no react-native imports, so it is safe to load in Node
// (from the published package: 'react-native-screen-context/src/llm', run through tsx or your bundler).
import { anthropicTools } from '../src/llm';

const client = new Anthropic();

const tools = anthropicTools();

// `system` comes from the app: the library's agent rules plus your AppContext (buildInstructions).
export async function screenAgentTurn(system: string, messages: Anthropic.Beta.BetaMessageParam[]): Promise<Anthropic.Beta.BetaMessage> {
  return client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    // Tapping through UI is latency-sensitive; try "low" if quality holds for your flows.
    output_config: { effort: 'medium' },
    // If a safety classifier declines, re-run the request on Anthropic's recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    tools,
    messages,
  });
}
