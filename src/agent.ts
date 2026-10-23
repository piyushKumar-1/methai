import { buildInstructions, type AppContext } from './llm';
import type { ScreenContextController } from './ScreenContextProvider';

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelToolResult {
  id: string;
  content: string;
  isError: boolean;
}

export interface ModelTurn {
  /** What the model said this turn (spoken to the user when the session ends). */
  text?: string;
  toolCalls: ModelToolCall[];
}

/**
 * Provider adapter for text models with tool calling. It owns the conversation history and the
 * transport (normally your backend); the agent loop only exchanges tool calls and results.
 */
export interface AgentModel {
  /** `instructions` is the system prompt (agent rules + app context) for this session. */
  start(request: string, screen: string, signal: AbortSignal, instructions: string): Promise<ModelTurn>;
  continue(results: ModelToolResult[], signal: AbortSignal): Promise<ModelTurn>;
  /** The user's reply to the model's last answer, in the same conversation (e.g. "yes, check out"). */
  followUp?(reply: string, screen: string, signal: AbortSignal): Promise<ModelTurn>;
}

export interface RunAgentOptions {
  maxSteps?: number;
  signal?: AbortSignal;
  /** Screen description captured when the request was made. Captured now if omitted. */
  screen?: string;
  /** Describes the app (screens, flows) for the system prompt. */
  app?: AppContext;
  /** Replaces the built-in agent rules (the app context is still appended). */
  systemPrompt?: string;
  /** Who the user is (saved places, history…), added to the system prompt. */
  userContext?: string;
  onToolCall?: (call: ModelToolCall, result: ModelToolResult) => void;
  /** Text the model sends along with tool calls ("Sure, finding autos…"), while it keeps working. */
  onProgress?: (text: string) => void;
}

/** Runs request → tool calls → actions → … until the model answers without tools. Returns its answer. */
export function runAgent(controller: ScreenContextController, model: AgentModel, request: string, opts: RunAgentOptions = {}): Promise<string> {
  const instructions = buildInstructions(opts.app, opts.systemPrompt, opts.userContext);
  return drive(controller, model, opts, async (signal, screen) => model.start(request, screen, signal, instructions));
}

/** Continues the conversation of the last runAgent call with the user's reply. Needs `model.followUp`. */
export function runAgentFollowUp(controller: ScreenContextController, model: AgentModel, reply: string, opts: RunAgentOptions = {}): Promise<string> {
  if (!model.followUp) throw new Error('This model does not support follow-ups.');
  return drive(controller, model, opts, (signal, screen) => model.followUp!(reply, screen, signal));
}

async function drive(
  controller: ScreenContextController,
  model: AgentModel,
  opts: RunAgentOptions,
  first: (signal: AbortSignal, screen: string) => Promise<ModelTurn>,
): Promise<string> {
  const signal = opts.signal ?? new AbortController().signal;
  controller.setActive(true);
  try {
    let turn = await first(signal, opts.screen ?? (await controller.describe()));
    for (let step = 0; step < (opts.maxSteps ?? 20); step++) {
      if (turn.toolCalls.length === 0) return turn.text ?? '';
      if (turn.text?.trim()) opts.onProgress?.(turn.text.trim());
      // UI actions depend on each other, so they run in order.
      const results: ModelToolResult[] = [];
      for (const call of turn.toolCalls) {
        // Not signal.throwIfAborted(): React Native's AbortSignal polyfill (abort-controller) lacks it.
        if (signal.aborted) throw new Error('Aborted');
        const { isError, content } = await controller.executeToolCall(call.name, call.input);
        const result = { id: call.id, content, isError };
        opts.onToolCall?.(call, result);
        results.push(result);
      }
      turn = await model.continue(results, signal);
    }
    return turn.toolCalls.length === 0 ? turn.text ?? '' : "I had to stop before finishing; it's taking too many steps.";
  } finally {
    controller.setActive(false);
  }
}
