# Methai demo app

An Expo app to try `react-native-screen-context` on a real phone. It has three plain screens: a
login form, a shop with a cart and coupon, and settings with switches. None of them contain any
assistant-specific code beyond one `AIAction` description on Checkout. Tap the mic and say things
like:

- "Add two apples and a coffee, apply coupon save ten and check out"
- "Go to login, my email is test at example dot com, password hunter two, remember me and log in"
- "Turn on promotional offers"

## Run it

The app talks to a small dev server on your computer. The server holds the gateway key, so the key
is never bundled into the app.

```sh
# once: put the gateway key where the server can read it (or export GRID_API_KEY)
mkdir -p ~/.config/grid && printf '%s' 'sk-…' > ~/.config/grid/key && chmod 600 ~/.config/grid/key

cd demo
npm install
npm run server          # terminal 1: http://<your-lan-ip>:8787
npm run ios:device      # terminal 2: builds a development build onto a connected iPhone
# or: npm run android   (device with USB debugging, or an emulator)
```

- The phone must be on the same Wi-Fi as the computer. The app finds the server at the Metro
  host's IP; override it with `EXPO_PUBLIC_SERVER_URL=http://<ip>:8787`.
- The first `ios:device` run asks for a signing team. Pick your Apple ID team in Xcode
  (`ios/MethaiDemo.xcworkspace` → Signing & Capabilities) if it fails, and on the phone trust the
  developer under Settings → General → VPN & Device Management.
- Expo Go won't work: speech recognition and streaming audio are native modules, so this needs a
  development build. After the first build, `npm start` is enough for JS changes.

## App context

[`src/appContext.ts`](src/appContext.ts) describes the app, its screens and its flows for the
system prompt. In a test on the Login screen, "buy three apples" without it got "what is your email
and password?". With it, the agent opened the Shop tab, added three apples, and asked before
checking out.

## Modes (Settings → Assistant)

| Mode | How it works | Status |
|---|---|---|
| On-device voice + chat model (default) | Speech recognition on the phone → `open-fast` (or another gateway chat model) with tool calls → spoken reply with on-device text-to-speech | Works with the current key (`open-fast` ≈ 2 s per step) |
| Voice model (realtime) | Audio streams to `xor-latest-custom` / `xor-omni` over the gateway's `/v1/realtime` | The current key gets HTTP 403 on `/v1/realtime`, and the xor models reject chat requests (`strands_decider` provider). Needs gateway-side access |

The dev server logs every model call and its tool calls, so you can watch what the agent does.
