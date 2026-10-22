import { createContext, useState } from 'react';
import { Button, Pressable, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  AIAction,
  AIIgnore,
  AIScreenAction,
  anthropicTools,
  formatSnapshot,
  ScreenContextController,
  ScreenContextProvider,
} from '../src';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function SearchIcon(_: { name: string }) {
  return <View />;
}

// Stand-ins for react-navigation's NavigationContext / NavigationRouteContext.
const NavigationContext = createContext<any>(null);
const RouteContext = createContext<any>(null);
const nav = (focused: boolean) => ({ isFocused: () => focused, navigate() {} });

const log: string[] = [];

function Login() {
  const [email, setEmail] = useState('');
  const [remember, setRemember] = useState(false);
  return (
    <View>
      <Text>Welcome back</Text>
      <Text>Total: ₹{120 + 60}, <Text>incl. tax</Text></Text>
      <TextInput placeholder="you@example.com" value={email} onChangeText={setEmail} keyboardType="email-address" />
      <TextInput placeholder="Password" secureTextEntry value="hunter2" onChangeText={() => {}} onSubmitEditing={() => log.push('submit')} />
      <View>
        <Text>Remember me</Text>
        <Switch value={remember} onValueChange={setRemember} />
      </View>
      <AIAction name="log_in" description="Signs in with the email and password">
        <Button title="Log in" onPress={() => log.push(`login:${email}:${remember}`)} />
      </AIAction>
      <Pressable onPress={() => log.push('forgot')}>
        <Text>Forgot password?</Text>
      </Pressable>
      <TouchableOpacity onPress={() => log.push('search')} accessibilityHint="Opens search">
        <SearchIcon name="search" />
      </TouchableOpacity>
      <Pressable onPress={() => {}} disabled testID="promo-banner">
        <Text>Promo</Text>
      </Pressable>
      <View style={{ display: 'none' }}>
        <Button title="Hidden" onPress={() => {}} />
      </View>
      <AIIgnore>
        <Button title="Debug menu" onPress={() => {}} />
      </AIIgnore>
      <AIScreenAction name="refresh" description="Reloads the account" parameters={{ type: 'object' }} onRun={args => log.push(`refresh:${JSON.stringify(args)}`)} />
    </View>
  );
}

function App() {
  return (
    <ScreenContextProvider>
      <NavigationContext.Provider value={nav(false)}>
        <RouteContext.Provider value={{ key: 'home-1', name: 'Home' }}>
          <Button title="Home screen button" onPress={() => {}} />
        </RouteContext.Provider>
      </NavigationContext.Provider>
      <NavigationContext.Provider value={nav(true)}>
        <RouteContext.Provider value={{ key: 'login-1', name: 'Login' }}>
          <Login />
        </RouteContext.Provider>
      </NavigationContext.Provider>
    </ScreenContextProvider>
  );
}

let controller: ScreenContextController;

beforeEach(async () => {
  log.length = 0;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
  });
  controller = renderer.root.findByType(ScreenContextProvider).instance.controller;
});

const execute = async (...args: Parameters<ScreenContextController['execute']>) => {
  let result: any;
  await act(async () => {
    result = await controller.execute(args[0], { settleMs: 0, ...args[1] });
  });
  return result;
};

test('extracts the visible, focused interactive surface', () => {
  const snap = controller.captureSync();
  expect(snap.screen).toBe('Login');
  expect(snap.texts).toEqual(['Welcome back', 'Total: ₹180, incl. tax', 'Remember me']);
  expect(snap.elements.map(e => [e.id, e.kind, e.label])).toEqual([
    ['input_you_example_com', 'text_input', 'you@example.com'],
    ['input_password', 'text_input', 'Password'],
    ['switch_remember_me', 'switch', 'Remember me'],
    ['btn_log_in', 'button', 'Log in'],
    ['btn_forgot_password', 'button', 'Forgot password?'],
    ['btn_search', 'button', 'search'],
    ['promo_banner', 'button', 'Promo'],
    ['action_refresh', 'custom_action', 'refresh'],
  ]);
  const byId = Object.fromEntries(snap.elements.map(e => [e.id, e]));
  expect(byId.btn_log_in.description).toBe('Signs in with the email and password');
  expect(byId.btn_search.description).toBe('Opens search');
  expect(byId.promo_banner.disabled).toBe(true);
  expect(byId.input_password).toMatchObject({ secure: true, value: undefined, actions: ['type', 'submit'] });
  expect(byId.input_you_example_com).toMatchObject({ keyboardType: 'email-address', value: '' });
});

test('types, toggles and presses with fresh state', async () => {
  expect(await execute({ type: 'type', elementId: 'input_you_example_com', text: 'a@b.co' })).toEqual({ ok: true });
  expect(await execute({ type: 'toggle', elementId: 'switch_remember_me', value: true })).toMatchObject({ ok: true });
  expect(await execute({ type: 'press', elementId: 'btn_log_in' })).toMatchObject({ ok: true });
  expect(log).toEqual(['login:a@b.co:true']);

  const snap = controller.captureSync();
  const byId = Object.fromEntries(snap.elements.map(e => [e.id, e]));
  expect(byId.input_you_example_com.value).toBe('a@b.co');
  expect(byId.switch_remember_me.checked).toBe(true);
});

test('type with submit, custom actions, and errors', async () => {
  expect(await execute({ type: 'type', elementId: 'input_password', text: 'x', submit: true })).toMatchObject({ ok: true });
  expect(await execute({ type: 'run', elementId: 'action_refresh', args: { force: true } })).toMatchObject({ ok: true });
  expect(log).toEqual(['submit', 'refresh:{"force":true}']);

  expect((await execute({ type: 'press', elementId: 'promo_banner' })).error).toMatch(/disabled/);
  expect((await execute({ type: 'press', elementId: 'btn_hidden' })).error).toMatch(/No element "btn_hidden"/);
  expect((await execute({ type: 'toggle', elementId: 'btn_log_in' })).error).toMatch(/does not support "toggle"/);
});

test('tool calls round-trip and return the new screen', async () => {
  let res: any;
  await act(async () => {
    res = await controller.executeToolCall('press_element', { element_id: 'btn_forgot_password' }, { settleMs: 0, measure: false });
  });
  expect(res.isError).toBe(false);
  expect(res.content).toMatch(/^OK: press on btn_forgot_password/);
  expect(res.content).toContain('[btn_log_in] button "Log in" — Signs in with the email and password');
  expect(log).toEqual(['forgot']);
  expect(anthropicTools().map(t => t.name)).toEqual(['press_element', 'type_text', 'toggle_switch', 'run_screen_action']);
});

test('formatSnapshot', () => {
  expect(formatSnapshot(controller.captureSync())).toMatchInlineSnapshot(`
"Screen: Login
Visible text:
- Welcome back
- Total: ₹180, incl. tax
- Remember me
Interactive elements (refer to them by the id in brackets):
- [input_you_example_com] text input "you@example.com" value="" keyboard=email-address
- [input_password] text input "Password" (secure, value hidden) (submittable)
- [switch_remember_me] switch "Remember me" = off
- [btn_log_in] button "Log in" — Signs in with the email and password
- [btn_forgot_password] button "Forgot password?"
- [btn_search] button "search" — Opens search
- [promo_banner] button "Promo" [disabled]
- [action_refresh] action "refresh" args schema: {"type":"object"} — Reloads the account"
`);
});
