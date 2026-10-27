import { useState } from 'react';
import { Button, TextInput, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { AgentGlow, AssistantButton, buildInstructions, openAIChatModel, requestText, isStopPhrase, OPENING_REQUEST, requestWithAlternatives, screenChangeNote, ScreenContextProvider, type AgentModel, type AssistantConfig, type SessionStart, type VoiceIO } from '../src';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const log: string[] = [];

function Screen() {
  const [email, setEmail] = useState('');
  return (
    <View>
      <TextInput placeholder="Email" value={email} onChangeText={setEmail} />
      <Button title="Log in" onPress={() => log.push(`login:${email}`)} />
    </View>
  );
}

function fakeVoice(heard: string): VoiceIO & { spoken: string[] } {
  const spoken: string[] = [];
  return {
    spoken,
    async speak(text) {
      spoken.push(text);
    },
    async listen(_signal, onPartial) {
      onPartial?.(heard.slice(0, 3));
      return heard;
    },
  };
}

function scriptedModel(seen: string[]): AgentModel {
  let step = 0;
  return {
    async start(request, screen, _signal, instructions) {
      seen.push(requestText(request), screen);
      expect(instructions).toContain('You are a voice assistant');
      return { toolCalls: [{ id: 't1', name: 'type_text', input: { element_id: 'input_email', text: 'a@b.co' } }] };
    },
    async continue(results) {
      seen.push(...results.map(r => r.content.split('\n')[0]));
      step++;
      return step === 1 ? { toolCalls: [{ id: 't2', name: 'press_element', input: { element_id: 'btn_log_in' } }] } : { text: 'You are logged in.', toolCalls: [] };
    },
  };
}

async function mount(assistant: AssistantConfig) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ScreenContextProvider assistant={assistant}>
        <Screen />
        <AssistantButton />
      </ScreenContextProvider>,
    );
  });
  return { renderer, provider: renderer.root.findByType(ScreenContextProvider).instance as ScreenContextProvider };
}

beforeEach(() => {
  log.length = 0;
});

test('greets, listens, acts on the screen and speaks the answer', async () => {
  const voice = fakeVoice('log me in as a@b.co');
  const seen: string[] = [];
  const { renderer, provider } = await mount({ greeting: 'Yes?', voice, model: scriptedModel(seen), conversation: 'single' });
  const states: string[] = [];
  provider.assistant!.subscribe(s => states.push(s.state));
  const glowActive: boolean[] = [];
  provider.controller.subscribe(e => e.type === 'active' && glowActive.push(e.active));

  // The assistant's own button is not part of the screen the model sees.
  expect(provider.controller.captureSync().elements.map(e => e.id)).toEqual(['input_email', 'btn_log_in']);

  await act(async () => {
    await provider.assistant!.start();
  });

  expect(voice.spoken).toEqual(['Yes?', 'You are logged in.']);
  expect(seen[0]).toBe('log me in as a@b.co');
  expect(seen[1]).toContain('[btn_log_in] button "Log in"');
  expect(seen.slice(2)).toEqual(['OK: type on input_email.', 'OK: press on btn_log_in.']);
  expect(log).toEqual(['login:a@b.co']);
  expect([...new Set(states)]).toEqual(['greeting', 'listening', 'thinking', 'speaking', 'idle']);
  expect(glowActive).toEqual([true, false]);
  expect(provider.assistant!.getStatus()).toMatchObject({ state: 'idle', transcript: 'log me in as a@b.co' });
  await act(async () => renderer.unmount());
});

test('nothing heard: goes idle without calling the model', async () => {
  const voice = fakeVoice('  ');
  const model = { start: jest.fn(), continue: jest.fn() };
  const { renderer, provider } = await mount({ voice, model, noInputReply: "I didn't catch that." });
  await act(async () => {
    await provider.assistant!.start();
  });
  expect(voice.spoken).toEqual(['How can I help?', "I didn't catch that."]);
  expect(model.start).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});

test('the glow mounts only while active', async () => {
  let release!: () => void;
  const voice: VoiceIO = { speak: async () => {}, listen: () => new Promise(r => (release = () => r(''))) };
  const { renderer, provider } = await mount({ voice, model: { start: jest.fn(), continue: jest.fn() } });
  const glow = () => renderer.root.findByType(AgentGlow).children.length;
  expect(glow()).toBe(0);

  let run!: Promise<void>;
  await act(async () => {
    run = provider.assistant!.start();
  });
  expect(provider.assistant!.getStatus().state).toBe('listening');
  expect(glow()).toBe(1);

  await act(async () => {
    release();
    await run;
  });
  expect(provider.controller.active).toBe(false);
  await act(async () => renderer.unmount());
});

test('a question from the model gets a spoken follow-up in the same conversation', async () => {
  const heard = ['log me in', 'yes please'];
  const spoken: string[] = [];
  const voice: VoiceIO = { speak: async t => void spoken.push(t), listen: async () => heard.shift() ?? '' };
  const followUps: string[] = [];
  const model: AgentModel = {
    start: async () => ({ text: 'Should I log you in with a@b.co?', toolCalls: [] }),
    continue: async () => ({ text: 'You are logged in.', toolCalls: [] }),
    followUp: async reply => {
      followUps.push(requestText(reply));
      return { toolCalls: [{ id: 'f1', name: 'press_element', input: { element_id: 'btn_log_in' } }] };
    },
  };
  const { renderer, provider } = await mount({ voice, model, conversation: 'single' });
  await act(async () => {
    await provider.assistant!.start();
  });
  expect(followUps).toEqual(['yes please']);
  expect(log).toEqual(['login:']);
  expect(spoken).toEqual(['How can I help?', 'Should I log you in with a@b.co?', 'You are logged in.']);
  await act(async () => renderer.unmount());
});

test('continuous: keeps listening after every answer until a stop phrase', async () => {
  const heard = ['type a@b.co as my email', 'now log in', "ok that's all"];
  const spoken: string[] = [];
  const voice: VoiceIO = { speak: async t => void spoken.push(t), listen: async () => heard.shift() ?? '' };
  const requests: string[] = [];
  let step = 0;
  const model: AgentModel = {
    start: async request => (requests.push(requestText(request)), { toolCalls: [{ id: 'a', name: 'type_text', input: { element_id: 'input_email', text: 'a@b.co' } }] }),
    continue: async () => ({ text: step++ === 0 ? 'Email entered.' : 'Logged in.', toolCalls: [] }),
    followUp: async reply => (requests.push(requestText(reply)), { toolCalls: [{ id: 'b', name: 'press_element', input: { element_id: 'btn_log_in' } }] }),
  };
  const { renderer, provider } = await mount({ voice, model, farewell: 'Bye!' });
  await act(async () => {
    await provider.assistant!.start();
  });
  expect(requests).toEqual(['type a@b.co as my email', 'now log in']);
  expect(log).toEqual(['login:a@b.co']);
  expect(spoken).toEqual(['How can I help?', 'Email entered.', 'Logged in.', 'Bye!']);
  expect(provider.assistant!.getStatus().state).toBe('idle');
  await act(async () => renderer.unmount());
});

test('continuous: silence ends the session', async () => {
  const heard = ['log me in'];
  const voice: VoiceIO = { speak: async () => {}, listen: async () => heard.shift() ?? '' };
  const model: AgentModel = { start: jest.fn(async () => ({ text: 'Which email?', toolCalls: [] })), continue: jest.fn() };
  const { renderer, provider } = await mount({ voice, model });
  await act(async () => {
    await provider.assistant!.start();
  });
  expect(model.start).toHaveBeenCalledTimes(1);
  expect(provider.controller.active).toBe(false);
  await act(async () => renderer.unmount());
});

test('tapping while it speaks cuts the answer short and listens again', async () => {
  const heard = ['tell me everything', 'thanks'];
  const voice: VoiceIO = {
    speak: (text, signal) =>
      text.startsWith('A very long')
        ? new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()))
        : Promise.resolve(),
    listen: async () => heard.shift() ?? '',
  };
  const model: AgentModel = { start: async () => ({ text: 'A very long answer…', toolCalls: [] }), continue: jest.fn() };
  const { renderer, provider } = await mount({ voice, model });
  const assistant = provider.assistant!;
  let run!: Promise<void>;
  await act(async () => {
    run = assistant.start();
  });
  await act(async () => new Promise(r => setTimeout(r, 400)));
  expect(assistant.getStatus().state).toBe('speaking');
  await act(async () => {
    assistant.toggle(); // interrupt, not cancel
    await run;
  });
  expect(heard).toEqual([]); // it listened again and heard "thanks"
  await act(async () => renderer.unmount());
});

test('stop phrases only match short closing utterances', () => {
  for (const t of ['stop', 'Thanks!', "ok that's all", 'thank you so much', 'bye bye', 'Never mind.']) expect(isStopPhrase(t)).toBe(true);
  for (const t of ['stop the timer', 'cancel my order please', 'add one apple', 'thanks, now add bananas to the cart']) expect(isStopPhrase(t)).toBe(false);
});

test('endOnSilence: false keeps listening through silence until a stop phrase', async () => {
  const heard = ['', '', 'log me in', '', 'thanks'];
  const voice: VoiceIO = { speak: async () => {}, listen: async () => heard.shift() ?? 'thanks' };
  const model: AgentModel = { start: jest.fn(async () => ({ text: 'Which email?', toolCalls: [] })), continue: jest.fn() };
  const { renderer, provider } = await mount({ voice, model, endOnSilence: false });
  await act(async () => {
    await provider.assistant!.start();
  });
  expect(model.start).toHaveBeenCalledTimes(1);
  expect(heard).toEqual([]);
  expect(provider.assistant!.getStatus().log).toEqual([
    { role: 'assistant', text: 'How can I help?' },
    { role: 'user', text: 'log me in' },
    { role: 'assistant', text: 'Which email?' },
    { role: 'user', text: 'thanks' },
    { role: 'assistant', text: 'Okay.' },
  ]);
  await act(async () => renderer.unmount());
});

test('a greeting function can hand the opening to the model, which continues a resumed conversation', async () => {
  const heard = ['book a cab', 'thanks', 'yes'];
  const spoken: string[] = [];
  const voice: VoiceIO = { speak: async t => void spoken.push(t), listen: async () => heard.shift() ?? '' };
  const starts: string[] = [];
  const followUps: string[] = [];
  const model: AgentModel = {
    start: async request => (starts.push(requestText(request)), { text: 'Where to?', toolCalls: [] }),
    continue: jest.fn(),
    followUp: async reply => (followUps.push(requestText(reply)), { text: reply === OPENING_REQUEST ? 'Still want that cab?' : 'Booked.', toolCalls: [] }),
  };
  const sessions: SessionStart[] = [];
  const greeting = (session: SessionStart) => (sessions.push(session), session.resumed ? undefined : 'Hi!');
  const { renderer, provider } = await mount({ voice, model, greeting, resumeWithinMs: 60_000 });

  await act(async () => {
    await provider.assistant!.start(); // "Hi!" → "book a cab" → "Where to?" → "thanks" ends it
  });
  await act(async () => {
    await provider.assistant!.start(); // reopened: the model opens and the conversation goes on
  });

  expect(sessions.map(s => s.resumed)).toEqual([false, true]);
  expect(starts).toEqual(['book a cab']);
  expect(followUps).toEqual([OPENING_REQUEST, 'yes']);
  expect(spoken).toEqual(['Hi!', 'Where to?', 'Okay.', 'Still want that cab?', 'Booked.']);
  // The resumed session keeps the earlier lines.
  expect(provider.assistant!.getStatus().log.map(m => m.text)).toEqual(['Hi!', 'book a cab', 'Where to?', 'thanks', 'Okay.', 'Still want that cab?', 'yes', 'Booked.']);
  await act(async () => renderer.unmount());
});

test('screenChangeNote tells the model when the user moved on by themselves', () => {
  const choose = 'Screen: Home (ChooseRide stage)\nVisible text:\n- Choose a ride';
  const tracking = 'Screen: RideTracking\nVisible text:\n- Driver is on the way';
  expect(screenChangeNote(choose, tracking)).toBe(
    '(The user changed the screen themselves since you last acted: it was "Home (ChooseRide stage)", now it is "RideTracking". ' +
      'Whatever you were doing may be done or dropped; go by the current screen.)',
  );
  expect(screenChangeNote(choose, `${choose}\n- 4 mins`)).toBe(''); // same screen, new details
  expect(screenChangeNote('', tracking)).toBe('');
});

test('a failed turn is told and the user can say it again; only repeated failures end the session', async () => {
  const heard = ['book a cab', 'book a cab'];
  const spoken: string[] = [];
  const voice: VoiceIO = { speak: async t => void spoken.push(t), listen: async () => heard.shift() ?? '' };
  const model: AgentModel = {
    start: jest.fn().mockRejectedValueOnce(new Error('Model request failed (429)')).mockResolvedValue({ text: 'Where to?', toolCalls: [] }),
    continue: jest.fn(),
  };
  const { renderer, provider } = await mount({ voice, model, greeting: 'Hi!' });
  await act(async () => {
    await provider.assistant!.start();
  });
  expect(spoken).toEqual(['Hi!', "Sorry, I couldn't do that. Please say it again.", 'Where to?']);
  expect(provider.assistant!.getStatus().error).toBeUndefined();
  await act(async () => renderer.unmount());
});

test('a failed model call is not continued by the next session', async () => {
  const heard = ['book a cab', 'book a cab', 'book a cab'];
  const voice: VoiceIO = { speak: async () => {}, listen: async () => heard.shift() ?? '' };
  const model: AgentModel = {
    start: jest.fn().mockRejectedValueOnce(new Error('network')).mockRejectedValueOnce(new Error('network')).mockResolvedValue({ text: 'Where to?', toolCalls: [] }),
    continue: jest.fn(),
    followUp: jest.fn(),
  };
  const { renderer, provider } = await mount({ voice, model, resumeWithinMs: 60_000, greeting: () => 'Hi!' });
  await act(async () => {
    await provider.assistant!.start();
  });
  expect(provider.assistant!.getStatus().error).toBe('network');
  await act(async () => {
    await provider.assistant!.start();
  });
  expect(model.start).toHaveBeenCalledTimes(3);
  expect(model.followUp).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});

test('text sent with tool calls is spoken as progress while the agent keeps working', async () => {
  const heard = ['log me in', 'thanks'];
  const spoken: string[] = [];
  const voice: VoiceIO = { speak: async t => void spoken.push(t), listen: async () => heard.shift() ?? '' };
  const model: AgentModel = {
    start: async () => ({ text: 'Sure, logging you in.', toolCalls: [{ id: 'p', name: 'press_element', input: { element_id: 'btn_log_in' } }] }),
    continue: async () => ({ text: 'Done.', toolCalls: [] }),
    followUp: jest.fn(),
  };
  const { renderer, provider } = await mount({ voice, model, speakProgress: true });
  await act(async () => {
    await provider.assistant!.start();
  });
  expect(log).toEqual(['login:']);
  expect(spoken).toEqual(['How can I help?', 'Sure, logging you in.', 'Done.', 'Okay.']);
  await act(async () => renderer.unmount());
});

test('user context goes into the system prompt and recognizer alternatives into the request', async () => {
  const voice: VoiceIO = {
    speak: async () => {},
    listen: jest
      .fn()
      .mockResolvedValueOnce({ text: 'to know my three office', alternatives: ['to know my office', 'to know Atri office'] })
      .mockResolvedValue('thanks'),
  };
  const seen: { request: string; instructions: string }[] = [];
  const model: AgentModel = {
    start: async (request, _screen, _signal, instructions) => (seen.push({ request: requestText(request), instructions }), { text: 'Namma Yatri office?', toolCalls: [] }),
    continue: jest.fn(),
    followUp: async () => ({ text: 'Okay.', toolCalls: [] }),
  };
  const { renderer, provider } = await mount({ voice, model, userContext: async () => 'Saved places: Work: Namma Yatri office, Koramangala' });
  await act(async () => {
    await provider.assistant!.start();
  });
  expect(seen[0].instructions).toContain('About the user');
  expect(seen[0].instructions).toContain('Work: Namma Yatri office');
  expect(seen[0].request).toBe('to know my three office\n(Speech recognition, other possible readings: "to know my office", "to know Atri office")');
  expect(provider.assistant!.getStatus().log[1]).toEqual({ role: 'user', text: 'to know my three office' });
  await act(async () => renderer.unmount());
});

test('requestWithAlternatives skips duplicates and empty guesses', () => {
  expect(requestWithAlternatives({ text: 'yes' })).toBe('yes');
  expect(requestWithAlternatives({ text: 'yes', alternatives: ['Yes', ' ', 'yeah'] })).toBe('yes\n(Speech recognition, other possible readings: "yeah")');
  expect(buildInstructions(undefined, 'Base.', '  ')).toBe('Base.');
});

test('recorded speech reaches the model as audio, and later turns resend it as text', async () => {
  const heard = [
    { text: 'type a@b.co', audio: { data: 'UklGRg==', format: 'wav' as const } },
    { text: 'log in', audio: { data: 'UklGRh==', format: 'wav' as const } },
    'bye',
  ];
  const voice: VoiceIO = { speak: async () => {}, listen: async () => heard.shift() ?? '' };
  const bodies: any[] = [];
  const replies = [
    { tool_calls: [{ id: 'a', type: 'function', function: { name: 'type_text', arguments: '{"element_id":"input_email","text":"a@b.co"}' } }] },
    { content: 'Typed it.' },
    { tool_calls: [{ id: 'b', type: 'function', function: { name: 'press_element', arguments: '{"element_id":"btn_log_in"}' } }] },
    { content: 'Logged in.' },
  ];
  const realFetch = global.fetch;
  global.fetch = jest.fn(async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: replies.shift() }] }) };
  }) as any;
  try {
    const { renderer, provider } = await mount({ voice, model: openAIChatModel({ endpoint: '/chat', model: 'xor-latest-custom' }) });
    await act(async () => {
      await provider.assistant!.start();
    });
    expect(log).toEqual(['login:a@b.co']);
    const first = bodies[0].messages[1];
    expect(first.content[0]).toEqual({ type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } });
    expect(first.content[1].text).toContain('type a@b.co');
    expect(first.textOnly).toBeUndefined();
    const followUp = bodies[2].messages;
    expect(followUp[1].content).toMatch(/^type a@b\.co\n\nCurrent screen:/);
    expect(followUp.at(-1).content[0].input_audio.data).toBe('UklGRh==');
    await act(async () => renderer.unmount());
  } finally {
    global.fetch = realFetch;
  }
});

test('a cut-off answer is trimmed in the model history to what was heard', async () => {
  const answer = 'Your cart has two apples and one banana, the total is 300 rupees.';
  const heard = ["what's in my cart", 'thanks'];
  const interrupted: (string | undefined)[] = [];
  const listenOptions: any[] = [];
  const voice: VoiceIO = {
    // The voice stops itself on "wait", having said 25 characters.
    speak: async text => (text === answer ? { interrupted: true, spokenChars: 25 } : undefined),
    listen: async (_signal, _partial, _level, options) => (listenOptions.push(options), heard.shift() ?? ''),
  };
  const model: AgentModel = {
    start: async () => ({ text: answer, toolCalls: [] }),
    continue: jest.fn(),
    followUp: async () => ({ text: '', toolCalls: [] }),
    interrupted: h => void interrupted.push(h),
  };
  const { renderer, provider } = await mount({ voice, model });
  await act(async () => {
    await provider.assistant!.start();
  });
  expect(interrupted).toEqual([answer.slice(0, 25).trim()]);
  // Listening uses the word-aware end of turn.
  expect(listenOptions[0].endOfTurnDelay('add apples and')).toBe(2200);
  expect(listenOptions[0].endOfTurnDelay('add two apples please now')).toBe(650);
  await act(async () => renderer.unmount());
});
