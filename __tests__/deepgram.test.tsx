import { useState } from 'react';
import { Button, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { base64ToBytes, deepgramAgentModel, floatToPcm16Base64, ScreenContextProvider, voiceAgentModel, type PcmAudioIO, type VoiceAgentProtocol } from '../src';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class FakeWS {
  static last: FakeWS;
  readyState = 0;
  binaryType = 'blob';
  json: any[] = [];
  audio: Uint8Array[] = [];
  onopen?: () => void;
  onmessage?: (m: { data: any }) => void;
  onclose?: (e: any) => void;
  onerror?: (e: any) => void;
  constructor(public url: string) {
    FakeWS.last = this;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
      this.server({ type: 'Welcome', request_id: 'r1' });
    });
  }
  send(data: string | ArrayBuffer) {
    if (typeof data === 'string') this.json.push(JSON.parse(data));
    else this.audio.push(new Uint8Array(data));
  }
  close() {
    this.readyState = 3;
  }
  server(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  serverAudio(b64: string) {
    this.onmessage?.({ data: base64ToBytes(b64).buffer });
  }
}

function fakeAudio() {
  const log: string[] = [];
  let onChunk: ((c: string) => void) | undefined;
  const audio: PcmAudioIO = {
    async startCapture(cb) {
      log.push('capture');
      onChunk = cb;
    },
    async stopCapture() {
      log.push('stop');
    },
    play: chunk => log.push(`play:${chunk}`),
    flush: () => log.push('flush'),
    drained: async () => {},
    close: async () => {},
  };
  return { audio, log, mic: (c: string) => onChunk?.(c) };
}

const wait = (ms: number) => act(async () => new Promise(r => setTimeout(r, ms)));

function Shop() {
  const [count, setCount] = useState(0);
  return (
    <View>
      <Text>{`Cart: ${count} bananas`}</Text>
      <Button title="Add banana" onPress={() => setCount(c => c + 1)} />
    </View>
  );
}

test('Deepgram agent: settings with the screen and tools, audio both ways as binary PCM, client-side functions, idle end', async () => {
  const { audio, log, mic } = fakeAudio();
  const realtime = deepgramAgentModel({ connect: async () => ({ url: 'ws://relay/deepgram/agent' }), audio, WebSocketImpl: FakeWS });
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      <ScreenContextProvider assistant={{ greeting: 'Hi there', realtime, idleTimeoutMs: 50 }}>
        <Shop />
      </ScreenContextProvider>,
    );
  });
  const provider = r.root.findByType(ScreenContextProvider).instance as ScreenContextProvider;
  const assistant = provider.assistant!;
  let run!: Promise<void>;
  await act(async () => {
    run = assistant.start();
  });
  await wait(5);
  const ws = FakeWS.last;
  expect(ws.binaryType).toBe('arraybuffer');
  const [settings] = ws.json;
  expect(settings.type).toBe('Settings');
  expect(settings.audio).toEqual({ input: { encoding: 'linear16', sample_rate: 24000 }, output: { encoding: 'linear16', sample_rate: 24000, container: 'none' } });
  expect(settings.agent.greeting).toBe('Hi there');
  expect(settings.agent.think.prompt).toContain('[btn_add_banana] button "Add banana"');
  expect(settings.agent.think.functions.map((f: any) => f.name)).toContain('press_element');

  // Greeting: binary audio is played; when it's done the mic opens and streams binary PCM.
  const greeting = floatToPcm16Base64(new Float32Array(240));
  await act(async () => {
    ws.server({ type: 'SettingsApplied' });
    ws.serverAudio(greeting);
    ws.server({ type: 'ConversationText', role: 'assistant', content: 'Hi there' });
    ws.server({ type: 'AgentAudioDone' });
  });
  await wait(350);
  expect(log.slice(0, 2)).toEqual([`play:${greeting}`, 'capture']);
  const voice = floatToPcm16Base64(new Float32Array(2400).fill(0.1));
  mic(voice);
  expect(ws.audio.at(-1)).toEqual(base64ToBytes(voice));

  // The user's turn, then a client-side function call that runs against the live screen.
  await act(async () => {
    ws.server({ type: 'UserStartedSpeaking' });
    ws.server({ type: 'ConversationText', role: 'user', content: 'add a banana' });
    ws.server({ type: 'FunctionCallRequest', functions: [{ id: 'f1', name: 'press_element', arguments: '{"element_id":"btn_add_banana"}', client_side: true }] });
  });
  expect(assistant.getStatus().transcript).toBe('add a banana');
  await wait(900); // action settle time
  const response = ws.json.find(m => m.type === 'FunctionCallResponse');
  expect(response).toMatchObject({ id: 'f1', name: 'press_element' });
  expect(response.content).toMatch(/^OK: press on btn_add_banana/);

  // A typed request goes in as text, like a spoken one.
  await act(async () => assistant.submitText('and one more'));
  expect(ws.json.at(-1)).toEqual({ type: 'InjectUserMessage', content: 'and one more' });
  expect(assistant.getStatus().transcript).toBe('and one more');

  // Answer, then silence: the core's idle timeout ends the session.
  await act(async () => {
    ws.serverAudio(greeting);
    ws.server({ type: 'ConversationText', role: 'assistant', content: 'Added a banana.' });
    ws.server({ type: 'AgentAudioDone' });
  });
  await act(async () => {
    await new Promise(res => setTimeout(res, 500));
    await run;
  });
  expect(assistant.getStatus().state).toBe('idle');
  expect(assistant.getStatus().log.map(m => m.text)).toEqual(['Hi there', 'add a banana', 'and one more', 'Added a banana.']);
  await act(async () => r.unmount());
});

test('any provider is just a protocol: a made-up one works with no engine code', async () => {
  const { audio, log, mic } = fakeAudio();
  // "Acme" speaks JSON both ways: { kind: 'hello' } on connect, audio as { pcm }, its own event names.
  const acme: VoiceAgentProtocol = {
    name: 'Acme',
    audioIn: { kind: 'json', message: pcm => ({ kind: 'mic', pcm }) },
    open: { messages: setup => [{ kind: 'start', prompt: setup.instructions, hello: setup.greeting, tools: setup.tools.map(t => t.name) }] },
    parse: m =>
      m.kind === 'voice' ? [{ type: 'audio', base64: m.pcm }]
      : m.kind === 'said' ? [{ type: 'agent-text', text: m.text }]
      : m.kind === 'voice-end' ? [{ type: 'reply-done' }]
      : m.kind === 'heard' ? [{ type: 'user-text', text: m.text, final: true }]
      : m.kind === 'do' ? [{ type: 'tool-calls', calls: [{ id: m.id, name: m.tool, args: m.args }] }]
      : [],
    toolResult: (call, result) => [{ kind: 'done', id: call.id, output: result.content }],
  };
  const realtime = voiceAgentModel(acme, { connect: async () => ({ url: 'wss://acme/voice' }), audio, WebSocketImpl: FakeWS });
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      <ScreenContextProvider assistant={{ greeting: 'Hello', realtime, idleTimeoutMs: 50 }}>
        <Shop />
      </ScreenContextProvider>,
    );
  });
  const assistant = (r.root.findByType(ScreenContextProvider).instance as ScreenContextProvider).assistant!;
  let run!: Promise<void>;
  await act(async () => {
    run = assistant.start();
  });
  await wait(5);
  const ws = FakeWS.last;
  expect(ws.json[0]).toMatchObject({ kind: 'start', hello: 'Hello', tools: expect.arrayContaining(['press_element']) });
  const pcm = floatToPcm16Base64(new Float32Array(240));
  await act(async () => {
    ws.server({ kind: 'voice', pcm });
    ws.server({ kind: 'voice-end' });
  });
  await wait(350);
  const voice = floatToPcm16Base64(new Float32Array(2400).fill(0.1));
  mic(voice);
  expect(ws.json.at(-1)).toEqual({ kind: 'mic', pcm: voice });
  await act(async () => {
    ws.server({ kind: 'heard', text: 'add a banana' });
    ws.server({ kind: 'do', id: 'x1', tool: 'press_element', args: { element_id: 'btn_add_banana' } });
  });
  await wait(900);
  expect(ws.json.find(m => m.kind === 'done')).toMatchObject({ id: 'x1', output: expect.stringMatching(/^OK: press on btn_add_banana/) });
  await act(async () => {
    ws.server({ kind: 'voice', pcm });
    ws.server({ kind: 'said', text: 'Done.' });
    ws.server({ kind: 'voice-end' });
  });
  await act(async () => {
    await new Promise(res => setTimeout(res, 500));
    await run;
  });
  expect(log).toContain(`play:${pcm}`);
  expect(assistant.getStatus().log.map(m => m.text)).toEqual(['add a banana', 'Done.']);
  await act(async () => r.unmount());
});
