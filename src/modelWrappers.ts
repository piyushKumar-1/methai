// Wrappers around any AgentModel: a time limit, a debug trace, and an optional hard rule that some
// controls are only pressed after the user said yes.
import { requestText, type AgentModel, type ModelToolCall, type ModelTurn, type UserRequest } from './agent';
import { parseArgs } from './llm';
import { getScreenContext } from './ScreenContextProvider';

/** Passes `interrupted` through to the wrapped model, when it has one. */
const forwardInterrupted = (model: AgentModel) => model.interrupted && { interrupted: (heard?: string) => model.interrupted!(heard) };

/** A request for the log: the text, and the size of a recording rather than its bytes. */
const describeRequest = (r: UserRequest) =>
  typeof r === 'string' ? JSON.stringify(r) : `(audio ${r.format}, ${Math.round((r.audio.length * 3) / 4 / 1024)} KB) ${JSON.stringify(r.transcript ?? '')}`;

/** Fails a model call that takes longer than `ms`, so a stuck backend ends in an error, not silence. */
export function withModelTimeout(model: AgentModel, ms: number): AgentModel {
  const timed = (turn: Promise<ModelTurn>) =>
    new Promise<ModelTurn>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Model request failed: no answer in ${ms / 1000}s`)), ms);
      turn.then(
        result => {
          clearTimeout(timer);
          resolve(result);
        },
        err => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  const { followUp } = model;
  return {
    start: (request, screen, signal, instructions) => timed(model.start(request, screen, signal, instructions)),
    continue: (results, signal) => timed(model.continue(results, signal)),
    ...(followUp && { followUp: (reply: UserRequest, screen: string, signal: AbortSignal) => timed(followUp.call(model, reply, screen, signal)) }),
    ...forwardInterrupted(model),
  };
}

const describeTurn = (turn: ModelTurn) =>
  turn.toolCalls.length
    ? `tools: ${turn.toolCalls.map(c => `${c.name}(${typeof c.input === 'string' ? c.input : JSON.stringify(c.input)})`).join(', ')}${turn.text ? ` + text ${JSON.stringify(turn.text)}` : ''}`
    : `reply: ${JSON.stringify(turn.text ?? '')}`;

/**
 * Logs what goes to the model and what comes back (requests, screens, tool calls, tool results,
 * replies, timings), so "it heard me but did nothing" can be told apart from "the model didn't act".
 */
export function withModelLogging(model: AgentModel, log: (message: string) => void): AgentModel {
  const logged = async (label: string, turn: Promise<ModelTurn>) => {
    const started = Date.now();
    try {
      const result = await turn;
      log(`${label} (${Date.now() - started}ms) → ${describeTurn(result)}`);
      return result;
    } catch (err) {
      log(`${label} failed after ${Date.now() - started}ms: ${String(err)}`);
      throw err;
    }
  };
  const { followUp } = model;
  return {
    start: (request, screen, signal, instructions) => {
      log(`request ${describeRequest(request)}; screen:\n${screen}`);
      return logged('start', model.start(request, screen, signal, instructions));
    },
    continue: (results, signal) => {
      results.forEach(r => log(`${r.isError ? 'tool failed' : 'tool result'}: ${r.content}`));
      return logged('continue', model.continue(results, signal));
    },
    ...(followUp && {
      followUp: (reply: UserRequest, screen: string, signal: AbortSignal) => {
        log(`follow-up ${describeRequest(reply)}`);
        return logged('follow-up', followUp.call(model, reply, screen, signal));
      },
    }),
    ...(model.interrupted && {
      interrupted: (heard?: string) => {
        log(`interrupted; heard ${JSON.stringify(heard ?? '?')}`);
        model.interrupted!(heard);
      },
    }),
  };
}

export interface ConfirmationGuardOptions {
  /** Controls that need a yes first, by element id and label. */
  isSensitive: (elementId: string, label: string | undefined) => boolean;
  /** Whether the user's reply agrees. Default: anything that doesn't start with no / don't / wait / stop. */
  isConfirming?: (reply: string) => boolean;
  /** Asked when the model keeps pressing without asking. Default `Should I go ahead with ${label}?`. */
  question?: (label: string) => string;
}

const NEGATIVE = /^\s*(no|nope|nah|don'?t|do not|wait|stop|not now|never ?mind|cancel that)\b/i;
const MAX_BLOCKED = 2;

/**
 * Opt-in hard rule for apps that need it: presses on controls matching `isSensitive` are blocked
 * unless the user's latest reply agreed to the assistant's question (one yes allows one press). A
 * blocked call goes back to the model as a failed tool result telling it to ask first. Prompts can
 * ask a model to confirm; only this guarantees it.
 */
export function withConfirmationGuard(model: AgentModel, opts: ConfirmationGuardOptions): AgentModel {
  const isConfirming = opts.isConfirming ?? ((reply: string) => reply.trim().length > 0 && !NEGATIVE.test(reply));
  const question = opts.question ?? ((label: string) => `Should I go ahead with ${label}?`);
  let granted = false;

  const labelOf = (id: string) => {
    try {
      return getScreenContext().captureSync().elements.find(e => e.id === id)?.label;
    } catch {
      return undefined;
    }
  };
  const sensitiveIn = (turn: ModelTurn): { call: ModelToolCall; label: string } | undefined => {
    for (const call of turn.toolCalls) {
      const id = parseArgs(call.input)?.element_id;
      if (typeof id !== 'string') continue;
      const label = labelOf(id);
      if (opts.isSensitive(id, label)) return { call, label: label ?? id };
    }
    return undefined;
  };

  const guard = async (turn: ModelTurn, signal: AbortSignal, retries = 0): Promise<ModelTurn> => {
    const sensitive = sensitiveIn(turn);
    if (!sensitive) return turn;
    if (granted) {
      granted = false;
      return turn;
    }
    if (retries >= MAX_BLOCKED) return { text: question(sensitive.label), toolCalls: [] };
    const results = turn.toolCalls.map(call => ({
      id: call.id,
      isError: true,
      content:
        call === sensitive.call
          ? `Not done: "${sensitive.label}" needs the user's explicit yes first. Ask them in one short question with the key detail, and stop.`
          : 'Not done: skipped because another action in this step needs the user to confirm first.',
    }));
    return guard(await model.continue(results, signal), signal, retries + 1);
  };

  const { followUp } = model;
  return {
    start: async (request, screen, signal, instructions) => {
      granted = false;
      return guard(await model.start(request, screen, signal, instructions), signal);
    },
    continue: async (results, signal) => guard(await model.continue(results, signal), signal),
    ...(followUp && {
      followUp: async (reply: UserRequest, screen: string, signal: AbortSignal) => {
        granted = isConfirming(requestText(reply));
        return guard(await followUp.call(model, reply, screen, signal), signal);
      },
    }),
    ...forwardInterrupted(model),
  };
}
