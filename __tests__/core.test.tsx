import { useState } from 'react';
import { Button, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { describeEvent, newWords, ScreenContextProvider, type AgentModel, type AssistantEvent, type RealtimeSession, type RealtimeVoiceModel, type VoiceIO } from '../src';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Ride() {
  const [booked, setBooked] = useState(false);
  return (
    <View>
      <Text>{booked ? 'Ride booked' : 'Auto 45 rupees'}</Text>
      <Button title="Book ride" onPress={() => setBooked(true)} />
    </View>
  );
}

const confirm = { isSensitive: (_id: string, label?: string) => /book/i.test(label ?? '') };

/** A transport driven by the test: it exposes the session the core hands it. */
function scriptedTransport() {
  let session!: RealtimeSession;
  let done!: () => void;
  const transport: RealtimeVoiceModel = {
    run: s =>
      new Promise<void>(resolve => {
        session = s;
        done = resolve;
        s.signal.addEventListener('abort', () => resolve());
      }),
  };
  return { transport, session: () => session, hangUp: () => done() };
}

async function mount(assistant: any) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      <ScreenContextProvider assistant={assistant}>
        <Ride />
      </ScreenContextProvider>,
    );
  });
  const provider = r.root.findByType(ScreenContextProvider).instance as ScreenContextProvider;
  return { r, provider, assistant: provider.assistant! };
}

const settle = () => act(async () => new Promise(r => setTimeout(r, 900)));

test('confirm: a realtime agent cannot book before the user says yes', async () => {
  const t = scriptedTransport();
  const events: AssistantEvent[] = [];
  const { r, provider, assistant } = await mount({ greeting: 'Hi', realtime: t.transport, confirm, onEvent: (e: AssistantEvent) => events.push(e) });
  let run!: Promise<void>;
  await act(async () => {
    run = assistant.start();
  });
  await act(async () => new Promise(res => setTimeout(res, 10)));
  const s = t.session();

  await act(async () => s.emit({ type: 'user-text', text: 'book an auto to Cubbon Park', final: true }));
  const refused = await s.runTool('press_element', { element_id: 'btn_book_ride' });
  expect(refused.isError).toBe(true);
  expect(refused.content).toMatch(/needs the user's explicit yes/);
  expect(provider.controller.captureSync().elements.some(e => e.label === 'Book ride')).toBe(true);

  await act(async () => s.emit({ type: 'user-text', text: 'yes please', final: true }));
  let booked!: Awaited<ReturnType<RealtimeSession['runTool']>>;
  await act(async () => {
    booked = await s.runTool('press_element', { element_id: 'btn_book_ride' });
  });
  await settle();
  expect(booked.isError).toBe(false);
  expect(provider.controller.captureSync().texts.join(' ')).toContain('Ride booked');
  // One yes, one press.
  expect((await s.runTool('press_element', { element_id: 'btn_book_ride' })).isError).toBe(true);

  await act(async () => {
    t.hangUp();
    await run;
  });
  expect(events.filter(e => e.type === 'tool').map(e => (e as any).result.isError)).toEqual([true, false, true]);
  expect(events.at(-1)).toEqual({ type: 'session-end', reason: 'agent' });
  await act(async () => r.unmount());
});

test('confirm: the same rule holds for a chat model', async () => {
  const voice: VoiceIO = {
    speak: async () => {},
    listen: (() => {
      const said = ['book a ride', 'yes', ''];
      return async () => said.shift() ?? '';
    })(),
  };
  const results: string[] = [];
  let step = 0;
  const model: AgentModel = {
    start: async () => ({ toolCalls: [{ id: 'a', name: 'press_element', input: { element_id: 'btn_book_ride' } }] }),
    continue: async res => {
      results.push(res[0].content.split('\n')[0]);
      return step++ === 0 ? { text: 'Book the Auto for 45 rupees?', toolCalls: [] } : { text: 'Booked.', toolCalls: [] };
    },
    followUp: async () => ({ toolCalls: [{ id: 'b', name: 'press_element', input: { element_id: 'btn_book_ride' } }] }),
  };
  const { r, assistant } = await mount({ greeting: 'Hi', voice, model, confirm, endOnSilence: true });
  await act(async () => {
    await assistant.start();
  });
  expect(results[0]).toMatch(/^Not done: "Book ride" needs the user's explicit yes/);
  expect(results[1]).toMatch(/^OK: press on btn_book_ride/);
  await act(async () => r.unmount());
});

test('the trace says why a realtime session ended: silence after the greeting', async () => {
  const t = scriptedTransport();
  const events: AssistantEvent[] = [];
  const { r, assistant } = await mount({ greeting: 'Hi', realtime: t.transport, noSpeechTimeoutMs: 30, onEvent: (e: AssistantEvent) => events.push(e) });
  let run!: Promise<void>;
  await act(async () => {
    run = assistant.start();
  });
  await act(async () => new Promise(res => setTimeout(res, 10)));
  await act(async () => {
    t.session().emit({ type: 'agent-audio', level: 0.5 });
    t.session().emit({ type: 'agent-done' });
    await run;
  });
  expect(events.at(-1)).toEqual({ type: 'session-end', reason: 'silence' });
  expect(describeEvent(events.at(-1)!)).toBe('session end: silence');
  await act(async () => r.unmount());
});

test('newWords tells the user from the agent echo', () => {
  const said = 'The Auto to Cubbon Park is 45 rupees. Shall I book it?';
  expect(newWords('the auto to cub and park is forty five', said)).toEqual([]);
  expect(newWords('no take me to the airport instead', said)).toEqual(['take', 'airport', 'instead']);
});
