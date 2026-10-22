import { useState } from 'react';
import { Button, TextInput, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { AgentGlow, AssistantButton, isStopPhrase, ScreenContextProvider, type AgentModel, type AssistantConfig, type VoiceIO } from '../src';

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
      seen.push(request, screen);
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
      followUps.push(reply);
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
    start: async request => (requests.push(request), { toolCalls: [{ id: 'a', name: 'type_text', input: { element_id: 'input_email', text: 'a@b.co' } }] }),
    continue: async () => ({ text: step++ === 0 ? 'Email entered.' : 'Logged in.', toolCalls: [] }),
    followUp: async reply => (requests.push(reply), { toolCalls: [{ id: 'b', name: 'press_element', input: { element_id: 'btn_log_in' } }] }),
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
