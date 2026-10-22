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
  start(request: string, screen: string, signal: AbortSignal): Promise<ModelTurn>;
  continue(results: ModelToolResult[], signal: AbortSignal): Promise<ModelTurn>;
}

export interface RunAgentOptions {
  maxSteps?: number;
  signal?: AbortSignal;
  /** Screen description captured when the request was made. Captured now if omitted. */
  screen?: string;
  onToolCall?: (call: ModelToolCall, result: ModelToolResult) => void;
}

/** Runs request → tool calls → actions → … until the model answers without tools. Returns its answer. */
export async function runAgent(controller: ScreenContextController, model: AgentModel, request: string, opts: RunAgentOptions = {}): Promise<string> {
  const signal = opts.signal ?? new AbortController().signal;
  controller.setActive(true);
  try {
    let turn = await model.start(request, opts.screen ?? (await controller.describe()), signal);
    for (let step = 0; step < (opts.maxSteps ?? 20); step++) {
      if (turn.toolCalls.length === 0) return turn.text ?? '';
      // UI actions depend on each other, so they run in order.
      const results: ModelToolResult[] = [];
      for (const call of turn.toolCalls) {
        signal.throwIfAborted();
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
