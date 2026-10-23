import type { ScreenAction, ScreenElement, ScreenSnapshot } from './types';

const q = (s: string) => JSON.stringify(s);

/** System prompt for a voice agent that drives the app through the screen tools. */
export const AGENT_INSTRUCTIONS = `You are a voice assistant that operates a mobile app on the user's behalf by calling tools.
You see the app's current screen as text: visible text plus interactive elements with ids in brackets.
Tool results include the screen after the action; only use ids from the most recent screen.

Think before acting:
- Requests come from speech recognition, which often mishears names and places ("to know my three office" may be "Namma Yatri office"). Work out what the user most likely meant from the other readings given, what you know about the user, and the screen; don't act on a reading that makes no sense.
- Know exactly what the user wants before you touch anything. If a key detail is missing or unclear (which place, which option, which item), ask one short question instead of guessing.
- Do only what was asked. No extra steps, no "helpful" detours.
- Act one step at a time and check each result on the new screen before the next step. If it is still loading, or what you need is not listed yet, call wait_for_screen rather than assuming.
- If something did not work, say so plainly instead of pretending it did.
- Never enter passwords, payment details or secrets the user did not say. Ask before irreversible actions (payments, deletions, sending messages) unless the user asked for exactly that.

Talk little. Replies are spoken aloud:
- Usually one short sentence (about 15 words). Up to three options when the user has to choose.
- Don't narrate your steps, repeat the user's request back, describe the screen, or offer more help at the end.
- Plain speech: no markdown, lists, emoji or ids.`;

function describeElement(el: ScreenElement): string {
  const parts: string[] = [`[${el.id}]`];
  switch (el.kind) {
    case 'button':
      parts.push(`button ${q(el.label)}`);
      if (el.actions.includes('long_press')) parts.push(el.actions.includes('press') ? '(press or long-press)' : '(long-press only)');
      break;
    case 'text_input':
      parts.push(`text input ${q(el.label)}`);
      if (el.placeholder && el.placeholder !== el.label) parts.push(`placeholder=${q(el.placeholder)}`);
      if (el.secure) parts.push('(secure, value hidden)');
      else parts.push(`value=${q(el.value ?? '')}`);
      if (el.keyboardType && el.keyboardType !== 'default') parts.push(`keyboard=${el.keyboardType}`);
      if (el.multiline) parts.push('multiline');
      if (el.maxLength !== undefined) parts.push(`maxLength=${el.maxLength}`);
      if (el.actions.includes('submit')) parts.push('(submittable)');
      break;
    case 'switch':
      parts.push(`switch ${q(el.label)} = ${el.checked === undefined ? 'unknown' : el.checked ? 'on' : 'off'}`);
      break;
    case 'custom_action':
      parts.push(`action ${q(el.label)}`);
      if (el.parameters) parts.push(`args schema: ${JSON.stringify(el.parameters)}`);
      break;
  }
  let line = parts.join(' ');
  if (el.description) line += ` — ${el.description}`;
  if (el.disabled) line += ' [disabled]';
  return line;
}

/** Compact, token-cheap text rendering of a snapshot, meant for the LLM's user/system message. */
export function formatSnapshot(snapshot: ScreenSnapshot): string {
  const lines: string[] = [];
  lines.push(`Screen: ${snapshot.screen ?? 'unknown'}`);
  if (snapshot.loading) lines.push('(Still loading: a spinner is showing. Call wait_for_screen before relying on what is listed.)');
  if (snapshot.texts.length) {
    lines.push('Visible text:');
    for (const t of snapshot.texts) lines.push(`- ${t}`);
  }
  lines.push(snapshot.elements.length ? 'Interactive elements (refer to them by the id in brackets):' : 'No interactive elements on screen.');
  for (const el of snapshot.elements) lines.push(`- ${describeElement(el)}`);
  return lines.join('\n');
}

export interface JSONSchemaObject {
  type: 'object';
  [key: string]: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  schema: JSONSchemaObject;
}

export interface AppScreenInfo {
  name: string;
  /** What the user does on this screen. */
  description?: string;
  /** How to get there, e.g. "Shop tab in the bottom bar". */
  howToReach?: string;
}

export interface AppFlow {
  name: string;
  /** The steps, in order, e.g. "Shop tab → add items → enter coupon → Checkout". */
  steps: string;
}

/** What the agent should know about the app before it looks at any screen. */
export interface AppContext {
  name?: string;
  /** What the app is and who it is for. */
  description?: string;
  screens?: AppScreenInfo[];
  /** Common tasks and how they are done. */
  flows?: AppFlow[];
  /** Extra rules, tone, domain terms, things to never do… */
  instructions?: string;
}

/** Builds the system prompt: base agent rules plus the app description. */
export function buildInstructions(app?: AppContext, base: string = AGENT_INSTRUCTIONS, userContext?: string): string {
  const user = userContext?.trim()
    ? `\n\nAbout the user (use it to understand what they mean, and to fix names the speech recognizer misheard):\n${userContext.trim()}`
    : '';
  if (!app) return base + user;
  const parts = [base, '', `About the app${app.name ? `: ${app.name}` : ''}`];
  if (app.description) parts.push(app.description.trim());
  if (app.screens?.length) {
    parts.push('', 'Screens:');
    for (const s of app.screens) {
      parts.push(`- ${s.name}${s.description ? `: ${s.description}` : ''}${s.howToReach ? ` (reach it via ${s.howToReach})` : ''}`);
    }
  }
  if (app.flows?.length) {
    parts.push('', 'Common flows:');
    for (const f of app.flows) parts.push(`- ${f.name}: ${f.steps}`);
  }
  if (app.instructions) parts.push('', app.instructions.trim());
  parts.push('', 'The screen description in each message is the source of truth for what is visible right now; use the app notes above to plan how to get where the user wants.');
  return parts.join('\n') + user;
}

export const WAIT_TOOL = 'wait_for_screen';

/** Tool input as an object; `input` may be an object or a JSON string. */
export function parseArgs(input: unknown): Record<string, any> | undefined {
  if (typeof input !== 'string') return input && typeof input === 'object' ? (input as Record<string, any>) : undefined;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const elementId = { type: 'string', description: 'The id shown in brackets in the screen context, e.g. "btn_log_in".' };

/**
 * The tool set is deliberately static (element ids are validated at execution time rather than
 * baked into an enum) so it stays byte-identical between turns and keeps prompt caches warm.
 */
export const SCREEN_TOOLS: ToolSpec[] = [
  {
    name: 'press_element',
    description: 'Press a button on the current screen. Use long_press only for elements that support it.',
    schema: {
      type: 'object',
      properties: { element_id: elementId, long_press: { type: 'boolean', description: 'Long-press instead of a normal press.' } },
      required: ['element_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'type_text',
    description: 'Replace the text of a text input on the current screen. Set submit to true to also submit it (like pressing the keyboard return key).',
    schema: {
      type: 'object',
      properties: {
        element_id: elementId,
        text: { type: 'string', description: 'The full new value of the input.' },
        submit: { type: 'boolean', description: 'Submit after typing.' },
      },
      required: ['element_id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'toggle_switch',
    description: 'Turn a switch on the current screen on or off.',
    schema: {
      type: 'object',
      properties: { element_id: elementId, value: { type: 'boolean', description: 'true = on, false = off.' } },
      required: ['element_id', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: WAIT_TOOL,
    description:
      'Wait for the screen to finish loading after an action (search results, prices, a new page) and see it again. Returns as soon as it settles. Use it instead of guessing when what you need is not on screen yet or a spinner is showing.',
    schema: {
      type: 'object',
      properties: { seconds: { type: 'number', description: 'Longest to wait, 1–10. Default 5.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'run_screen_action',
    description: 'Run one of the "action" entries listed in the screen context, with its documented arguments.',
    schema: {
      type: 'object',
      properties: { element_id: elementId, args: { type: 'object', description: 'Arguments for the action, if it takes any.' } },
      required: ['element_id'],
      additionalProperties: false,
    },
  },
];

/** Tool definitions in Anthropic Messages API shape ({ name, description, input_schema }). */
export function anthropicTools(): { name: string; description: string; input_schema: JSONSchemaObject }[] {
  return SCREEN_TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.schema }));
}

/** Tool definitions in OpenAI-compatible function-calling shape. */
export function openAITools(): { type: 'function'; function: { name: string; description: string; parameters: JSONSchemaObject } }[] {
  return SCREEN_TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
}

export const isScreenTool = (name: string) => SCREEN_TOOLS.some(t => t.name === name);

/** Maps a tool call from the LLM to a ScreenAction. `input` may be an object or a JSON string. */
export function toolCallToAction(name: string, input: unknown): ScreenAction | { error: string } {
  let args: any = input;
  if (typeof input === 'string') {
    try {
      args = JSON.parse(input);
    } catch {
      return { error: 'Tool input is not valid JSON.' };
    }
  }
  if (!args || typeof args !== 'object' || typeof args.element_id !== 'string') return { error: 'element_id (string) is required.' };
  const elementId: string = args.element_id;
  switch (name) {
    case 'press_element':
      return { type: args.long_press ? 'long_press' : 'press', elementId };
    case 'type_text':
      if (typeof args.text !== 'string') return { error: 'text (string) is required.' };
      return { type: 'type', elementId, text: args.text, submit: args.submit === true };
    case 'toggle_switch':
      return { type: 'toggle', elementId, value: typeof args.value === 'boolean' ? args.value : undefined };
    case 'run_screen_action':
      return { type: 'run', elementId, args: args.args && typeof args.args === 'object' ? args.args : {} };
    default:
      return { error: `Unknown tool "${name}".` };
  }
}
