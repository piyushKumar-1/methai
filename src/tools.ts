// The one place tool calls run, for every kind of assistant (chat model, realtime voice, ElevenLabs
// agent): the screen action itself, wrapped in middleware such as "ask before paying".
import { parseArgs } from './llm';
import type { ScreenContextController, ToolCallResult } from './ScreenContextProvider';

export interface ToolCall {
  name: string;
  input: unknown;
}

/** What a tool middleware knows about the conversation when a call comes in. */
export interface ToolContext {
  /** Changes for every assistant session. */
  sessionId: number;
  /** How many times the user has spoken (or typed) this session, and their last words. */
  userTurns: number;
  lastUserText: string;
  controller: ScreenContextController;
}

export type RunTool = (call: ToolCall, ctx: ToolContext) => Promise<ToolCallResult>;
/** Wraps how tool calls run: decide, change, time or log them, then call `next` (or not). */
export type ToolMiddleware = (next: RunTool) => RunTool;

/** The first middleware is the outermost. */
export const composeTools = (run: RunTool, middleware: ToolMiddleware[]): RunTool => middleware.reduceRight((next, mw) => mw(next), run);

export interface ConfirmOptions {
  /** Controls that need a yes first, by element id and label. */
  isSensitive: (elementId: string, label: string | undefined) => boolean;
  /** Whether the user's reply agrees. Default: anything that doesn't start with no / don't / wait / stop. */
  isConfirming?: (reply: string) => boolean;
}

const NEGATIVE = /^\s*(no|nope|nah|don'?t|do not|wait|stop|not now|never ?mind|cancel that)\b/i;

/**
 * Presses on controls matching `isSensitive` are refused unless the user's latest reply agreed
 * (one yes allows one press); the refusal tells the model to ask. Prompts can ask a model to
 * confirm; only this guarantees it, for any kind of assistant.
 */
export function confirmBefore(opts: ConfirmOptions): ToolMiddleware {
  const isConfirming = opts.isConfirming ?? ((reply: string) => reply.trim().length > 0 && !NEGATIVE.test(reply));
  let usedYes = ''; // the reply that already allowed a press, as session:turn
  return next => async (call, ctx) => {
    const id = parseArgs(call.input)?.element_id;
    if (typeof id !== 'string') return next(call, ctx);
    let label: string | undefined;
    try {
      label = ctx.controller.captureSync().elements.find(e => e.id === id)?.label;
    } catch {}
    if (!opts.isSensitive(id, label)) return next(call, ctx);
    // The request that started the session is not a yes: the model hasn't asked anything yet.
    const reply = `${ctx.sessionId}:${ctx.userTurns}`;
    if (ctx.userTurns > 1 && reply !== usedYes && isConfirming(ctx.lastUserText)) {
      usedYes = reply;
      return next(call, ctx);
    }
    return {
      isError: true,
      content: `Not done: "${label ?? id}" needs the user's explicit yes first. Ask them in one short question with the key detail (what and how much), and wait for the answer.`,
    };
  };
}

/** Fails a tool call that takes longer than `ms`, so a stuck screen doesn't stall the conversation. */
export function toolTimeout(ms: number): ToolMiddleware {
  return next => (call, ctx) =>
    new Promise(resolve => {
      const timer = setTimeout(() => resolve({ isError: true, content: `Not finished after ${ms / 1000}s; check the screen before trying again.` }), ms);
      next(call, ctx).then(
        result => {
          clearTimeout(timer);
          resolve(result);
        },
        err => {
          clearTimeout(timer);
          resolve({ isError: true, content: `Failed: ${err?.message ?? String(err)}` });
        },
      );
    });
}
