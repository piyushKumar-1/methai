import { useState } from 'react';
import { Button, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { elevenLabsAgentModel, elevenLabsClientTools, floatToPcm16Base64, ScreenContextProvider, withHostedSpeech, type PcmAudioIO, type VoiceIO } from '../src';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class FakeWS {
  static last: FakeWS;
  readyState = 0;
  sent: any[] = [];
  onopen?: () => void;
  onmessage?: (m: { data: string }) => void;
  onclose?: (e: any) => void;
  onerror?: (e: any) => void;
  constructor(public url: string) {
    FakeWS.last = this;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  server(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
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
  const [ordered, setOrdered] = useState(false);
  return (
    <View>
      <Text>{ordered ? 'Order placed' : 'Cart: 1 item'}</Text>
      <Button title="Place order" onPress={() => setOrdered(true)} />
    </View>
  );
}

test('client tools: ElevenLabs schema subset, args as JSON text', () => {
  const tools = elevenLabsClientTools();
  expect(tools.map(t => t.name)).toEqual(['press_element', 'type_text', 'toggle_switch', 'wait_for_screen', 'scroll', 'run_screen_action']);
  expect(JSON.stringify(tools)).not.toContain('additionalProperties');
  expect(tools[0]).toMatchObject({ type: 'client', expects_response: true, parameters: { type: 'object', required: ['element_id'] } });
  expect(tools[5].parameters.properties.args.type).toBe('string');
});

test('ElevenLabs agent session: prompt + greeting, mic after greeting, client tool on the live screen, interruption, idle end', async () => {
  const { audio, log, mic } = fakeAudio();
  const realtime = elevenLabsAgentModel({ connect: async () => ({ url: 'wss://el/signed' }), audio, idleTimeoutMs: 50, WebSocketImpl: FakeWS });

  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      <ScreenContextProvider assistant={{ greeting: 'Hey, what do you need?', realtime }}>
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
  await wait(0);
  const ws = FakeWS.last;
  expect(ws.url).toBe('wss://el/signed');
  const [init] = ws.sent;
  expect(init.type).toBe('conversation_initiation_client_data');
  expect(init.dynamic_variables).toEqual({ greeting: 'Hey, what do you need?' });
  expect(init.conversation_config_override.agent.prompt.prompt).toContain('[btn_place_order] button "Place order"');

  // 16 kHz agent audio is resampled to the speaker's 24 kHz; after the greeting the mic opens.
  const chunk16k = floatToPcm16Base64(new Float32Array(160));
  await act(async () => {
    ws.server({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_16000' } });
    ws.server({ type: 'audio', audio_event: { audio_base_64: chunk16k, event_id: 1 } });
    ws.server({ type: 'ping', ping_event: { event_id: 7 } });
  });
  expect(ws.sent).toContainEqual({ type: 'pong', event_id: 7 });
  expect(log[0]).toBe(`play:${floatToPcm16Base64(new Float32Array(240))}`);
  await wait(450);
  expect(log).toContain('capture');
  expect(assistant.getStatus().state).toBe('listening');
  mic(floatToPcm16Base64(new Float32Array(240)));
  expect(ws.sent.at(-1)).toEqual({ user_audio_chunk: floatToPcm16Base64(new Float32Array(160)) });

  // The agent presses a button; the result carries the screen after the press.
  await act(async () => {
    ws.server({ type: 'user_transcript', user_transcription_event: { user_transcript: 'place my order', event_id: 2 } });
    ws.server({ type: 'client_tool_call', client_tool_call: { tool_name: 'press_element', tool_call_id: 't1', parameters: { element_id: 'btn_place_order' }, event_id: 2, expects_response: true } });
  });
  expect(assistant.getStatus().transcript).toBe('place my order');
  await wait(900); // action settle time
  const result = ws.sent.find(e => e.type === 'client_tool_result');
  expect(result).toMatchObject({ tool_call_id: 't1', is_error: false });
  expect(result.result).toContain('Order placed');

  // The user talks over the answer: playback stops.
  await act(async () => {
    ws.server({ type: 'audio', audio_event: { audio_base_64: chunk16k, event_id: 3 } });
    ws.server({ type: 'interruption', interruption_event: { event_id: 3 } });
  });
  expect(log.at(-1)).toBe('flush');

  // Answer, then silence: the session ends after the idle timeout.
  await act(async () => {
    ws.server({ type: 'audio', audio_event: { audio_base_64: chunk16k, event_id: 4 } });
  });
  await act(async () => {
    await new Promise(r => setTimeout(r, 500));
    await run;
  });
  expect(log.at(-1)).toBe('stop');
  expect(assistant.getStatus().state).toBe('idle');
  await act(async () => r.unmount());
});

test('hosted speech: streams PCM at the reported rate, falls back to the device voice on failure', async () => {
  const { audio, log } = fakeAudio();
  const deviceSpoke: string[] = [];
  const device: VoiceIO = { speak: async text => void deviceSpoke.push(text), listen: async () => '' };
  const pcm48k = new Uint8Array(960); // 480 samples at 48 kHz → 240 at 24 kHz
  const bodies: any[] = [];
  let fail = false;
  const fetchImpl = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    if (fail) return { ok: false, status: 402, text: async () => 'no credits' };
    const chunks = [pcm48k.slice(0, 481), pcm48k.slice(481)]; // split mid-sample
    return {
      ok: true,
      headers: { get: () => 'audio/pcm;rate=48000;channels=1' },
      body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }), cancel: async () => {} }) },
    };
  }) as any;
  const errors: string[] = [];
  const voice = withHostedSpeech(device, { endpoint: 'http://srv/speech', model: 'm', voice: 'v', audio, fetchImpl, onError: e => errors.push(e.message) });

  await voice.speak('Added it [btn_add]. **Done**', new AbortController().signal);
  expect(bodies[0]).toEqual({ model: 'm', input: 'Added it . Done', voice: 'v', response_format: 'pcm' });
  const played = log.filter(l => l.startsWith('play:')).map(l => l.slice(5));
  expect(played).toHaveLength(2);
  expect(played.join('').length).toBeGreaterThan(0);
  expect(deviceSpoke).toEqual([]);

  fail = true;
  await voice.speak('Hello', new AbortController().signal);
  expect(deviceSpoke).toEqual(['Hello']);
  expect(errors[0]).toMatch(/HTTP 402/);
});
