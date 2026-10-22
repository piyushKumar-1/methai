# react-native-screen-context

Turns what is **live on screen** in a React Native app into LLM context — buttons, text inputs,
switches, visible text — and lets the LLM **press, type and toggle** them through tool calls.

No per-component instrumentation needed: it walks React's fiber tree, so `Button`, `Pressable`,
`TouchableOpacity`, `TextInput`, `Switch`, `<Text onPress>` and any custom component that takes
`onPress` / `onValueChange` are picked up automatically. Optional annotations make it better.

```
Screen: Login
Visible text:
- Welcome back
- Remember me
Interactive elements (refer to them by the id in brackets):
- [input_you_example_com] text input "you@example.com" value="" keyboard=email-address
- [input_password] text input "Password" (secure, value hidden) (submittable)
- [switch_remember_me] switch "Remember me" = off
- [btn_log_in] button "Log in" — Signs in with the email and password
- [btn_search] button "search" — Opens search
- [promo_banner] button "Promo" [disabled]
- [action_refresh] action "refresh" args schema: {"type":"object"} — Reloads the account
```

## Setup

```tsx
import { ScreenContextProvider } from 'react-native-screen-context';

export default function App() {
  return (
    <ScreenContextProvider>
      <NavigationContainer>{/* … */}</NavigationContainer>
    </ScreenContextProvider>
  );
}
```

The provider just needs to be mounted; it reads the whole React tree it lives in (modals too).

## Reading the screen

```ts
import { getScreenContext, useScreenContext } from 'react-native-screen-context';

const screen = useScreenContext();          // in components, or getScreenContext() anywhere else

const snapshot = await screen.capture();    // structured: { screen, elements[], texts[] }
const text = await screen.describe();       // compact text for the prompt (shown above)
const fast = screen.captureSync();          // no layout measurement
```

Each element: `id`, `kind` (`button | text_input | switch | custom_action`), `label`, `description`,
`actions`, `disabled`, `placeholder`, `value`, `secure`, `keyboardType`, `checked`, `bounds`, `testID`.

**Labels** come from, in order: `accessibilityLabel`/`aria-label` → visible text inside the control →
`title` → icon `name` → `testID` → handler name. Inputs use the a11y label, a wrapping `label` prop
(react-native-paper style), the placeholder, then the text right before the input.

**Ids** are deterministic (`testID` if set, otherwise `kind + label`), so the same UI gives the same
ids between captures. Set `testID` on important controls for ids that survive copy changes.

**Visible only.** Skipped: unfocused react-navigation screens (stacks and tabs keep them mounted),
`display: 'none'`, `accessibilityElementsHidden`, `importantForAccessibility="no-hide-descendants"`,
`aria-hidden`, hidden `<Activity>`/Suspense trees, and — with `capture()` — anything zero-sized or
outside the window.

**Secure inputs** never expose their value.

## Telling the LLM what a control does

```tsx
import { AIAction, AIScreenAction, AIIgnore } from 'react-native-screen-context';

<AIAction name="checkout" description="Places the order and charges the saved card">
  <PayButton onPress={pay} />
</AIAction>

// Actions with no visible control
<AIScreenAction
  name="filter_by_price"
  description="Filters the product list by max price"
  parameters={{ type: 'object', properties: { max: { type: 'number' } }, required: ['max'] }}
  onRun={({ max }) => setMaxPrice(max as number)}
/>

<AIIgnore><DebugMenu /></AIIgnore>   // never exposed
```

`accessibilityHint` is also used as the description, so good accessibility already helps.

## Acting on the LLM's response

```ts
await screen.execute({ type: 'press', elementId: 'btn_log_in' });
await screen.execute({ type: 'type', elementId: 'input_email', text: 'a@b.co', submit: true });
await screen.execute({ type: 'toggle', elementId: 'switch_remember_me', value: true });
await screen.execute({ type: 'run', elementId: 'action_filter_by_price', args: { max: 500 } });
```

Before each action the tree is read again, so the element is looked up on the screen as it is now
and its *current* handler runs (no stale closures). `type` calls `onChangeText`/`onChange` (and
`setNativeProps` for uncontrolled inputs); `submit` runs after the re-render, so
`onSubmitEditing` sees the new value. Disabled or missing elements give back an error that lists the
valid ids, so the model can recover.

## LLM tools

A fixed set of four tools (`press_element`, `type_text`, `toggle_switch`, `run_screen_action`). The
tools never change between turns, so prompt caching keeps working; element ids are checked when the
tool runs.

```ts
import { anthropicTools, openAITools } from 'react-native-screen-context';

// One call: parse → execute → wait for re-render → text result that includes the new screen
const { isError, content } = await screen.executeToolCall(toolUse.name, toolUse.input);
```

`runAgent(controller, model, request)` is a provider-agnostic loop: request → tool calls →
actions → … → final answer. You plug in a model through the small `AgentModel` interface
(`start(request, screen)` / `continue(toolResults)`). [`example/model.ts`](example/model.ts)
implements it against your backend, and [`example/server.ts`](example/server.ts) is that backend:
it holds the API key and makes the LLM call. Don't ship an LLM API key in the app.

## Voice assistant

Voice-first, one request at a time, no chat UI: **tap → greeting is spoken → the user talks →
the agent acts on the screen → the answer is spoken → idle**. The screen is captured when the user
taps, so the request is about what they were looking at.

```tsx
import { AssistantButton, ScreenContextProvider, useAssistant } from 'react-native-screen-context';

<ScreenContextProvider
  assistant={{
    greeting: 'How can I help?',               // default
    voice: deviceVoice(),                      // speech-to-text + text-to-speech (VoiceIO)
    model: backendModel({ endpoint: '…' }),    // LLM with tool calling (AgentModel)
  }}
>
  <App />
  <AssistantButton />                          {/* floating mic; tap again to stop */}
</ScreenContextProvider>

// …or from any button of your own
const { state, transcript, toggle } = useAssistant();   // state: idle | greeting | listening | thinking | speaking
```

Two ways to plug in voice:

- **Speech-to-text → LLM → text-to-speech:** `{ voice, model }`. `VoiceIO` is just
  `speak(text)` and `listen() → transcript`. [`example/voice-adapters.ts`](example/voice-adapters.ts)
  uses on-device engines (`@react-native-voice/voice` + `expo-speech`), with end-of-speech
  detection on silence. Cloud STT/TTS fit the same interface.
- **Speech-to-speech models** (realtime voice APIs): `{ realtime }`. A `RealtimeVoiceModel`
  owns the mic and speaker. It gets the greeting, the screen and the four tools, and calls
  `onToolCall(name, input)` for each action. No adapter ships yet: realtime APIs need a WebRTC
  or WebSocket audio transport that depends on the provider.

The agent's own button is wrapped in `AIIgnore`, so the model never sees or presses it.

## Edge glow

While a session runs (the assistant or any `runAgent` call), a flowing gradient glows around the
screen edges. It ignores touches, pulses on every action, and is unmounted when idle. It uses
React Native's built-in `backgroundImage: linear-gradient(...)` and `Animated` (native driver),
so it needs no native dependency. It requires the New Architecture (RN ≥ 0.76), and it doesn't spin
when the OS "reduce motion" setting is on.

```tsx
<ScreenContextProvider glow={{ colors: ['#7C5CFF', '#22D3EE', '#FF5CA8'], thickness: 3, cornerRadius: 44, durationMs: 4000 }}>
<ScreenContextProvider glow={false}>   // off
controller.setActive(true)             // drive it yourself
```

It draws above your root view. Native modals (RN `Modal`, native-stack modals) open in their own
window, so the glow appears underneath them.

## Caveats

- It reads React internals (`_reactInternals`, fiber fields). Everything is duck-typed and
  defensive, but check it again when you upgrade React.
- Handlers get a synthetic event (`nativeEvent`, `persist`, `preventDefault`…). Code that relies on
  real touch data or `event.target` refs may act differently.
- Gesture-handler-only controls (e.g. RNGH `GestureDetector` with no `onPress` prop), WebViews and
  native-only views can't be seen. Wrap them in `AIScreenAction`.
- Scrolled-out content inside a `ScrollView` that is still within the window bounds is still listed.
  Virtualized lists only list the rows they have rendered.
- The voice adapters in `example/` and the glow are verified with unit tests only; try them on
  devices before shipping.
- On-screen detection is a heuristic. If you need a hard guarantee, gate dangerous actions in your
  own code (or in the system prompt) and don't rely on visibility.

## Development

```sh
npm test         # jest + react-test-renderer against the real RN component tree
npm run typecheck
npm run build    # -> lib/
```
