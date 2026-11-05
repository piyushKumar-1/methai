import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { AssistantOverlay, ScreenContextProvider, toCaptionText, typedSoFar, type AgentModel, type ConversationStyle, type VoiceIO } from '../src';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test('toCaptionText drops element ids, markdown and emoji', () => {
  expect(toCaptionText('Auto to **Cubbon Park** [btn_auto] is ₹45 🚕.')).toBe('Auto to Cubbon Park is ₹45.');
  expect(toCaptionText(undefined)).toBe('');
});

test('typedSoFar reveals whole words at speaking pace', () => {
  const text = 'Auto is 45 rupees. Shall I book it?';
  expect(typedSoFar(text, 0)).toBe('');
  expect(typedSoFar(text, 500)).toBe('Auto is'); // 7 chars at 15/s
  expect(typedSoFar(text, 60_000)).toBe(text);
  expect(typedSoFar('Okay.', 100)).toBe('');
  expect(typedSoFar('Okay.', 400)).toBe('Okay.');
});

test('a typed request starts a session without the greeting, and the reply shows beside the button', async () => {
  jest.useFakeTimers();
  let finishSpeaking!: () => void;
  const spoken: string[] = [];
  const voice: VoiceIO = {
    speak: text => (spoken.push(text), new Promise(resolve => (finishSpeaking = resolve))),
    listen: (signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve(''))),
  };
  const model: AgentModel = { start: async () => ({ text: 'Where to? [btn_x]', toolCalls: [] }), continue: jest.fn() };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ScreenContextProvider assistant={{ voice, model }}>
        <View />
        <AssistantOverlay typeToAsk theme={{ background: ['#000', '#333'], foreground: '#FC0' }} />
      </ScreenContextProvider>,
    );
  });
  const provider = renderer.root.findByType(ScreenContextProvider).instance as ScreenContextProvider;
  // Long-press opens the text field; sending it starts the session with that request.
  await act(async () => {
    renderer.root.findByProps({ accessibilityLabel: 'Voice assistant' }).props.onLongPress();
  });
  await act(async () => {
    const input = renderer.root.findByType(TextInput);
    input.props.onChangeText('book an auto');
  });
  await act(async () => {
    renderer.root.findByType(TextInput).props.onSubmitEditing();
    await jest.advanceTimersByTimeAsync(100);
  });
  expect(spoken).toEqual(['Where to? [btn_x]']); // no greeting
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  expect(renderer.root.findAllByType(Text).map(t => t.props.children)).toContain('Where to?');
  // Done talking: the bubble goes away.
  await act(async () => {
    finishSpeaking();
  });
  expect(provider.assistant!.getStatus().state).toBe('listening');
  expect(renderer.root.findAllByType(Text)).toHaveLength(0);
  await act(async () => {
    provider.assistant!.cancel();
  });
  await act(async () => renderer.unmount());
  jest.useRealTimers();
});

test('Interrupt / Take turns: the switch shows while active, and the choice reaches the voice at once', async () => {
  const interruptible: (boolean | undefined)[] = [];
  const voice: VoiceIO = {
    speak: async (_text, _signal, options) => void interruptible.push(options?.interruptible),
    listen: signal => new Promise(resolve => signal.addEventListener('abort', () => resolve(''))),
  };
  const model: AgentModel = { start: async () => ({ text: 'Done.', toolCalls: [] }), continue: jest.fn() };
  function App() {
    const [style, setStyle] = useState<ConversationStyle>('interrupt');
    return (
      <ScreenContextProvider assistant={{ greeting: 'Hi', voice, model, voiceInterruptions: style === 'turns' ? 'off' : 'smart' }}>
        <View />
        <AssistantOverlay interruptions={{ value: style, onChange: setStyle }} />
      </ScreenContextProvider>
    );
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
  });
  const switchFor = () => renderer.root.findAllByProps({ accessibilityRole: 'switch' });
  expect(switchFor()).toHaveLength(0); // idle: no switch
  const provider = renderer.root.findByType(ScreenContextProvider).instance as ScreenContextProvider;
  await act(async () => void provider.assistant!.start());
  expect(interruptible).toEqual([true]); // the greeting, in 'interrupt'
  expect(switchFor()[0].props.accessibilityState).toEqual({ checked: true });

  await act(async () => switchFor()[0].props.onPress());
  expect(switchFor()[0].props.accessibilityState).toEqual({ checked: false });
  await act(async () => provider.assistant!.submitText('add apples'));
  expect(interruptible).toEqual([true, false]); // the answer, now taking turns
  await act(async () => provider.assistant!.cancel());
  await act(async () => renderer.unmount());
});
