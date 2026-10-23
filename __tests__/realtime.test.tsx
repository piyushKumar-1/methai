import { useState } from 'react';
import { Button, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { floatToPcm16Base64, openAIRealtimeModel, pcm16Base64ToFloat, resample, ScreenContextProvider, type PcmAudioIO } from '../src';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test('pcm16 base64 round trip and resampling', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
  const back = pcm16Base64ToFloat(floatToPcm16Base64(samples));
  back.forEach((v, i) => expect(v).toBeCloseTo(samples[i], 3));
  expect(floatToPcm16Base64(new Float32Array([0]))).toBe('AAA=');
  expect(resample(new Float32Array(480), 48000, 24000)).toHaveLength(240);
});

class FakeWS {
  static last: FakeWS;
  readyState = 0;
  sent: any[] = [];
  onopen?: () => void;
  onmessage?: (m: { data: string }) => void;
  onclose?: (e: any) => void;
  onerror?: (e: any) => void;
  constructor(
    public url: string,
    _protocols: string[],
    public options?: { headers: Record<string, string> },
  ) {
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

const tick = () => act(async () => new Promise(r => setTimeout(r, 0)));

function Shop() {
  const [ordered, setOrdered] = useState(false);
  return (
    <View>
      <Text>{ordered ? 'Order placed' : 'Cart: 1 item'}</Text>
      <Button title="Place order" onPress={() => setOrdered(true)} />
    </View>
  );
}

test('speech-to-speech session: greeting, mic, tool call on the live screen, answer, follow-up timeout', async () => {
  const { audio, log, mic } = fakeAudio();
  const realtime = openAIRealtimeModel({
    connect: async () => ({ url: 'wss://gw/v1/realtime?model=xor-latest-custom', headers: { Authorization: 'Bearer eph' } }),
    audio,
    voice: 'alloy',
    idleTimeoutMs: 20,
    WebSocketImpl: FakeWS,
  });

  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      <ScreenContextProvider
        assistant={{
          greeting: 'Hey, what do you need?',
          realtime,
          app: {
            name: 'FreshCart',
            description: 'Grocery delivery in 20 minutes.',
            screens: [{ name: 'Shop', description: 'Products and the cart', howToReach: 'the Shop tab' }],
            flows: [{ name: 'Order', steps: 'Shop → add items → Checkout' }],
            instructions: 'Prices are in rupees.',
          },
        }}
      >
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
  await tick();
  const ws = FakeWS.last;
  expect(ws.options?.headers.Authorization).toBe('Bearer eph');

  const [update, greet] = ws.sent;
  expect(update.type).toBe('session.update');
  expect(update.session.audio.output.voice).toBe('alloy');
  expect(update.session.tools.map((t: any) => t.name)).toEqual(['press_element', 'type_text', 'toggle_switch', 'wait_for_screen', 'scroll', 'run_screen_action', 'end_conversation']);
  expect(update.session.instructions).toContain('[btn_place_order] button "Place order"');
  expect(update.session.instructions).toContain('About the app: FreshCart\nGrocery delivery in 20 minutes.');
  expect(update.session.instructions).toContain('- Shop: Products and the cart (reach it via the Shop tab)');
  expect(update.session.instructions).toContain('- Order: Shop → add items → Checkout');
  expect(update.session.instructions).toContain('Prices are in rupees.');
  expect(greet.response.instructions).toContain('Hey, what do you need?');

  // Greeting audio, then the mic opens.
  await act(async () => {
    ws.server({ type: 'response.output_audio.delta', delta: 'AAA=' });
    ws.server({ type: 'response.done', response: { status: 'completed', output: [] } });
  });
  await tick();
  expect(log).toEqual(['play:AAA=', 'capture']);
  expect(assistant.getStatus().state).toBe('listening');
  mic('BBBB');
  expect(ws.sent.at(-1)).toEqual({ type: 'input_audio_buffer.append', audio: 'BBBB' });

  // User speaks, model calls a tool against the auto-discovered button.
  await act(async () => {
    ws.server({ type: 'input_audio_buffer.speech_started' });
    ws.server({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'place my order' });
    ws.server({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'press_element', arguments: '{"element_id":"btn_place_order"}' }] } });
  });
  await act(async () => new Promise(r => setTimeout(r, 900))); // action settle time
  const out = ws.sent.find(e => e.type === 'conversation.item.create');
  expect(out.item.call_id).toBe('c1');
  expect(out.item.output).toMatch(/^OK: press on btn_place_order/);
  expect(out.item.output).toContain('Order placed');
  expect(ws.sent.at(-1)).toEqual({ type: 'response.create' });
  expect(assistant.getStatus().transcript).toBe('place my order');

  // Spoken answer, then nobody replies within the follow-up window: session ends.
  await act(async () => {
    ws.server({ type: 'response.output_audio.delta', delta: 'CCCC' });
    ws.server({ type: 'response.done', response: { status: 'completed', output: [] } });
    await run;
  });
  expect(log).toContain('flush'); // barge-in on speech_started
  expect(log.at(-1)).toBe('stop');
  expect(assistant.getStatus().state).toBe('idle');
  expect(provider.controller.active).toBe(false);
  await act(async () => r.unmount());
});
