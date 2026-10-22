// Backend side: holds the API key and calls the model. The app never talks to the provider directly.
// Mount `screenAgentTurn` behind any HTTP framework, e.g. POST /screen-agent/turn.
import Anthropic from '@anthropic-ai/sdk';
// The llm module has no react-native imports, so it is safe to load in Node
// (from the published package: 'react-native-screen-context/src/llm', run through tsx or your bundler).
import { anthropicTools } from '../src/llm';

const client = new Anthropic();

const SYSTEM = `You are a voice assistant that operates a mobile app on the user's behalf by calling tools.
The user spoke their request; your final reply is read aloud, so keep it to one or two short sentences of plain speech: no markdown, lists, ids or emoji.
Each user turn and each tool result contains the current screen: visible text and the interactive elements with their ids.
Only use ids from the most recent screen; ids from earlier screens may no longer exist.
Act one step at a time and check the new screen after every action.
Never type passwords, payment details or other secrets unless the user gave them in this conversation.
Before an irreversible action (payment, deletion, sending a message) ask the user to confirm unless they already asked for exactly that.
When the goal is done, or you are blocked, stop calling tools and say so briefly.`;

const tools = anthropicTools();

export async function screenAgentTurn(messages: Anthropic.Beta.BetaMessageParam[]): Promise<Anthropic.Beta.BetaMessage> {
  return client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    // Tapping through UI is latency-sensitive; try "low" if quality holds for your flows.
    output_config: { effort: 'medium' },
    // If a safety classifier declines, re-run the request on Anthropic's recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    tools,
    messages,
  });
}
