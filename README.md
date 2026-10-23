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

**Try it on a phone:** [`demo/`](demo/) is an Expo app with a login form, a shop and settings
that you can drive by voice. See [demo/README.md](demo/README.md).

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

For OpenAI-compatible gateways (LiteLLM, vLLM, …) there is a ready adapter:
`openAIChatModel({ endpoint, model })`. It posts chat-completions bodies to your backend route,
which adds the key and forwards them.

`runAgent(controller, model, request)` is a provider-agnostic loop: request → tool calls →
actions → … → final answer. You plug in a model through the small `AgentModel` interface
(`start(request, screen)` / `continue(toolResults)`). [`example/model.ts`](example/model.ts)
implements it against your backend, and [`example/server.ts`](example/server.ts) is that backend:
it holds the API key and makes the LLM call. Don't ship an LLM API key in the app.

## Voice assistant

Voice-first, no chat UI: **tap → greeting is spoken → the user talks → the agent acts on the screen
→ the answer is spoken → it listens again…**. The screen is captured when the user taps, so the
first request is about what they were looking at.

- `conversation: 'continuous'` (default) keeps the same conversation going, so "and one more" or
  "yes, check out" work. It ends on a short closing phrase ("stop", "that's all", "thanks, bye";
  see `stopPhrases` and `isStopPhrase`, which ignores requests like "stop the timer"), on silence,
  or when the button is tapped. `farewell` is spoken on the way out.
- `conversation: 'single'` handles one request. It listens again only when the answer is a question.
- `endOnSilence: false` keeps a continuous conversation open through silence, until the user says a
  stop phrase or taps the button.
- `resumeWithinMs` continues the previous conversation when the assistant is reopened within that
  time, so "yes, book it" still makes sense after closing it. A conversation whose last model call
  failed or was cut off is never continued.
- `greeting` can be a function of `{ screen, resumed }`: return a fixed line, or `undefined` to let
  the model open the session itself from the screen and the conversation so far
  (e.g. "Still want the auto to Cubbon Park?").
- `speakProgress: true` speaks text the model sends together with tool calls ("Sure, finding autos
  to the airport.") right away while the agent keeps working (`onProgress` on `runAgent` for your
  own loops). Off by default: only answers are spoken.
- `useAssistant().log` is the conversation so far (`{ role, text }[]`), for captions or a transcript.
- One button does it all: tap to start, tap while it talks to cut the answer short (`interrupt()`),
  tap while it listens to end.
- Speech-to-speech models get the same behaviour, plus an `end_conversation` tool they call when
  the user is done. `idleTimeoutMs` sets how long they wait in silence before ending.

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

### On-device voice

`deviceVoice()` is a ready VoiceIO on the phone's own engines. Pass in the speech libraries you use
(the library itself has no native dependencies):

```ts
import Voice from '@react-native-voice/voice';
import Tts from 'react-native-tts';
import { deviceVoice } from 'react-native-screen-context';

const voice = deviceVoice({
  recognizer: Voice,
  tts: Tts,
  locale: () => 'en-IN',                        // read every turn, so it can follow the app language
  requestMicPermission: askForMic,              // optional
  speakable: text => text.replace(/₹(\d+)/g, '$1 rupees'),  // optional: how replies are read aloud
  log: console.log,                             // optional: listen started / partials / why it ended
});
```

It picks the most natural installed voice for the language, removes its own words if the mic hears
them from the loudspeaker, keeps one-word answers that the recognizer reports as "no match", reports
mic loudness for the glow, and never hangs on an engine that dies mid-utterance. The helpers it uses
(`pickBestVoice`, `stripEcho`, `micLevelFromRms`, …) are exported for your own adapters.

### Model wrappers

- `withModelTimeout(model, ms)`: a stuck backend ends in an error instead of silence.
- `withModelLogging(model, log)`: requests, screens, tool calls, results, replies and timings.
- `withConfirmationGuard(model, { isSensitive })`: opt-in hard rule that matching controls are only
  pressed after the user said yes (a prompt can ask the model to confirm; only this guarantees it).

### Waiting for the screen

After every action the agent waits until the screen settles (no changes for a moment, no spinner)
instead of a fixed delay, and the built-in `wait_for_screen` tool lets the model wait for data that
arrives later (search results, prices). A snapshot is marked loading while a spinner shows.

### Ready-made UI

`<AssistantOverlay />` is the whole on-screen part: a button docked to the screen edge and a bubble
beside it with what is being said — the user's words while it listens, the reply typed out while it
speaks, gone once it stops talking. Theme and place it to match your app:

```tsx
<ScreenContextProvider assistant={{ voice, model }} glow={{ colors: [brand, brand2] }}>
  <App />
  <AssistantOverlay
    theme={{ background: '#111', foreground: '#FCC32C', accent: '#FCC32C' }}   // or background: [from, to]
    position={{ side: 'right', vertical: 0.42 }}
    icon={<MyMicIcon />}            // optional; a built-in mic otherwise
    typeToAsk={__DEV__}             // long-press to type a request (emulators have no speech engines)
  />
</ScreenContextProvider>
```

`useAssistant().submitText(text)` sends a typed request from your own UI the same way.

### Describing your app (system prompt)

Tell the agent what the app is, which screens exist and how common tasks are done. It then knows
where to go before it has seen the screen (e.g. "buy apples" while you're on Login → open the Shop
tab first):

```tsx
<ScreenContextProvider
  assistant={{
    voice, model,
    app: {
      name: 'FreshCart',
      description: 'Grocery delivery in 20 minutes. Prices are in rupees.',
      screens: [
        { name: 'Shop', description: 'Products, quantities, coupon, Checkout', howToReach: 'the Shop tab' },
        { name: 'Orders', description: 'Past orders and tracking', howToReach: 'Profile → Orders' },
      ],
      flows: [{ name: 'Place an order', steps: 'Shop → add items → coupon (optional) → Checkout' }],
      instructions: 'Never cancel an order without asking.',
    },
    // systemPrompt: '…',   // replaces the built-in agent rules; `app` is still appended
  }}
>
```

`buildInstructions(app)` returns the final system prompt if you call `runAgent` yourself or want to
log it. It is the same for every request in a session, so it caches well.

When an answer ends with a question ("Should I check out?"), the assistant listens again and
continues the same conversation (`maxFollowUps`, default 3). Speech-to-speech models get a short
follow-up window after every answer.

Two ways to plug in voice:

- **Speech-to-text → LLM → text-to-speech:** `{ voice, model }`. `VoiceIO` is just
  `speak(text)` and `listen() → transcript`. [`example/voice-adapters.ts`](example/voice-adapters.ts)
  uses on-device engines (`@react-native-voice/voice` + `expo-speech`), with end-of-speech
  detection on silence. Cloud STT/TTS fit the same interface.
- **Speech-to-speech models** (realtime voice APIs): `{ realtime }`. A `RealtimeVoiceModel`
  owns the mic and speaker. It gets the greeting, the screen and the four tools, and calls
  `onToolCall(name, input)` for each action. `openAIRealtimeModel()` implements the OpenAI Realtime
  WebSocket protocol, which LiteLLM proxies also serve at `/v1/realtime`. It handles the greeting,
  server-side voice activity detection, interrupting the model mid-answer (barge-in), tool calls,
  and a short follow-up window after each answer so the user can reply to a confirmation question.
  There's a mic/speaker adapter in [`example/pcm-audio.ts`](example/pcm-audio.ts)
  (`react-native-audio-api`).

### Using a LiteLLM gateway voice model

```ts
import { openAIRealtimeModel } from 'react-native-screen-context';
import { devicePcmAudio } from './pcm-audio';

const realtime = openAIRealtimeModel({
  // Your relay (example/realtime-relay.ts) keeps the gateway key on the server.
  connect: async () => ({ url: 'wss://your-backend.example.com/realtime' }),
  audio: devicePcmAudio(),
  protocol: 'ga',                      // or 'beta' for older realtime-preview style models
});

<ScreenContextProvider assistant={{ greeting: 'How can I help?', realtime }}>
```

Check what your gateway and model support first (the key is read from the environment or from
`~/.config/grid/key` and never printed):

```sh
node scripts/probe-gateway.mjs xor-latest-custom
```

It reports whether the model is listed, whether `/v1/realtime` accepts it in the GA or beta shape,
whether tool calls and audio come back, and whether `/v1/realtime/client_secrets` can mint
short-lived tokens. If it can, `connect` can fetch a token from your backend and connect to the
gateway directly with `headers: { Authorization: 'Bearer <token>' }`, with no relay in between.

The agent's own button is wrapped in `AIIgnore`, so the model never sees or presses it.

## Voice-reactive glow

While a session runs, an aura of colours flows along the bottom of the screen. It reacts to the
voice: quiet means a thin glow at the bottom edge, and as the user (or the model) gets louder it swells
and climbs up the sides. It flashes on every tap or keystroke the agent makes, and fades out when
the session ends.

- Levels come from `VoiceIO.listen(…, onLevel)` (mic loudness) and `VoiceIO.onSpeakingLevel`
  (speech being played). Realtime models feed both automatically from the audio stream. Without
  levels, the aura synthesises speech-like motion from the phase (listening, thinking, speaking).
- It is all `Animated` on the native thread. Levels update an `Animated.Value`, never React state,
  so the app doesn't re-render. Built-in gradients (`backgroundImage`) only; no native dependency.
  Requires the New Architecture (RN ≥ 0.76).
- It ignores touches, respects "reduce motion", and draws above your root view (native modals
  open in their own window, so it appears underneath them).

```tsx
<ScreenContextProvider glow={{ variant: 'aura', colors: ['#7C5CFF', '#22D3EE', '#FF5CA8'], durationMs: 7000 }}>
<ScreenContextProvider glow={{ variant: 'edge' }}>   // gradient flowing around the whole border
<ScreenContextProvider glow={false}>                 // off
controller.setActive(true); controller.reportVoice('listening', 0.6)   // drive it yourself
```

## Overhead

- **Idle: nothing.** No polling, timers or tree walks, and no re-renders. The provider's context
  values never change, so wrapping the app doesn't re-render it. The glow is unmounted when idle.
- **Reading the screen** happens only when the assistant is triggered and once after each action:
  one synchronous walk of the tree. About 9 ms for 19k components and 2k controls on a laptop
  (expect 3–5× that on a mid-range phone).
- **While running:** only the glow, the assistant button and components that call `useAssistant()`
  re-render, and only when the state changes (not per audio chunk). The glow animates on the native
  thread (`useNativeDriver`), so it doesn't cost JS frames.
- **No runtime dependencies.** Voice and audio adapters are opt-in examples.

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
