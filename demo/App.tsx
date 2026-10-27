import * as Speech from 'expo-speech';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import {
  AIAction,
  AIIgnore,
  AssistantButton,
  openAIChatModel,
  openAIRealtimeModel,
  ScreenContextProvider,
  useAssistant,
  type AssistantConfig,
} from 'react-native-screen-context';
import { APP_CONTEXT } from './src/appContext';
import { CHAT_MODELS, CLOUD_VOICE_MODELS, REALTIME_MODELS, SERVER_URL } from './src/config';
import { devicePcmAudio } from './src/pcm-audio';
import { deviceVoice, rankedVoices, type RankedVoice } from './src/voice';

type Tab = 'Login' | 'Shop' | 'Settings';
type Mode = 'cloud' | 'pipeline' | 'realtime';

const GREETING = 'Hi! How can I help?';
// Read on every utterance, so picking a voice in Settings applies immediately.
let selectedVoice: string | undefined;
const voice = deviceVoice({ voice: () => selectedVoice });
// Same mic + speaker, but the recorded utterance goes to the model, which hears it itself.
const cloudVoice = deviceVoice({ voice: () => selectedVoice, sendAudio: true });
let pcmAudio: ReturnType<typeof devicePcmAudio> | undefined;

export default function App() {
  const [tab, setTab] = useState<Tab>('Shop');
  const [mode, setMode] = useState<Mode>('cloud');
  const [chatModel, setChatModel] = useState<string>(CHAT_MODELS[0]);
  const [cloudModel, setCloudModel] = useState<string>(CLOUD_VOICE_MODELS[0]);
  const [realtimeModel, setRealtimeModel] = useState<string>(REALTIME_MODELS[0]);

  const assistant = useMemo<AssistantConfig>(() => {
    if (mode === 'realtime') {
      pcmAudio ??= devicePcmAudio();
      return {
        greeting: GREETING,
        app: APP_CONTEXT,
        realtime: openAIRealtimeModel({
          connect: async () => ({ url: `${SERVER_URL.replace(/^http/, 'ws')}/realtime?model=${encodeURIComponent(realtimeModel)}` }),
          audio: pcmAudio,
        }),
      };
    }
    return {
      greeting: GREETING,
      app: APP_CONTEXT,
      noInputReply: "Sorry, I didn't catch that.",
      // "Sure, adding those." while it works, instead of silence.
      speakProgress: true,
      voice: mode === 'cloud' ? cloudVoice : voice,
      model: openAIChatModel({ endpoint: `${SERVER_URL}/chat`, model: mode === 'cloud' ? cloudModel : chatModel }),
    };
  }, [mode, chatModel, cloudModel, realtimeModel]);

  return (
    <ScreenContextProvider assistant={assistant} getScreenName={() => tab}>
      <SafeAreaView style={styles.root}>
        <StatusBar style="dark" />
        <Header tab={tab} />
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {tab === 'Login' && <LoginScreen />}
          {tab === 'Shop' && <ShopScreen />}
          {tab === 'Settings' && (
            <SettingsScreen
              mode={mode}
              setMode={setMode}
              chatModel={chatModel}
              setChatModel={setChatModel}
              cloudModel={cloudModel}
              setCloudModel={setCloudModel}
              realtimeModel={realtimeModel}
              setRealtimeModel={setRealtimeModel}
            />
          )}
        </ScrollView>
        <TabBar tab={tab} setTab={setTab} />
      </SafeAreaView>
      <AssistantButton style={{ bottom: 96 }} />
    </ScreenContextProvider>
  );
}

function Header({ tab }: { tab: Tab }) {
  return (
    <View style={styles.header}>
      <Text style={styles.title}>{tab}</Text>
      <AssistantStatus />
    </View>
  );
}

/** Live assistant state + transcript. Hidden from the model. */
function AssistantStatus() {
  const { state, transcript, error } = useAssistant();
  if (state === 'idle' && !error && !transcript) return null;
  const label = { idle: 'Done', greeting: 'Speaking…', listening: 'Listening…', thinking: 'Working…', speaking: 'Answering… (tap ⏭ to interrupt)' }[state];
  return (
    <AIIgnore>
      <View style={styles.status}>
        <Text style={styles.statusState}>{error ? 'Error' : label}</Text>
        {!!(error || transcript) && (
          <Text style={styles.statusText} numberOfLines={2}>
            {error ?? `“${transcript}”`}
          </Text>
        )}
      </View>
    </AIIgnore>
  );
}

function TabBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <View style={styles.tabBar}>
      {(['Login', 'Shop', 'Settings'] as Tab[]).map(t => (
        <Pressable key={t} onPress={() => setTab(t)} accessibilityRole="tab" accessibilityLabel={`${t} tab`} style={styles.tab}>
          <Text style={[styles.tabText, tab === t && styles.tabActive]}>{t}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [user, setUser] = useState<string | null>(null);

  if (user) {
    return (
      <View style={styles.card}>
        <Text style={styles.h2}>Welcome, {user}</Text>
        <Text style={styles.muted}>{remember ? 'You will stay signed in.' : 'You will be signed out when you close the app.'}</Text>
        <Btn title="Log out" onPress={() => setUser(null)} kind="secondary" />
      </View>
    );
  }
  return (
    <View style={styles.card}>
      <Text style={styles.h2}>Sign in</Text>
      <Text style={styles.label}>Email</Text>
      <TextInput style={styles.input} placeholder="you@example.com" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
      <Text style={styles.label}>Password</Text>
      <TextInput style={styles.input} placeholder="Password" value={password} onChangeText={setPassword} secureTextEntry />
      <View style={styles.row}>
        <Text style={styles.body}>Remember me</Text>
        <Switch value={remember} onValueChange={setRemember} />
      </View>
      <Btn title="Log in" disabled={!email || !password} onPress={() => setUser(email)} />
    </View>
  );
}

const PRODUCTS = [
  { id: 'apples', name: 'Apples', price: 120 },
  { id: 'bananas', name: 'Bananas', price: 60 },
  { id: 'coffee', name: 'Coffee beans', price: 450 },
  { id: 'bread', name: 'Sourdough bread', price: 180 },
];

function ShopScreen() {
  const [qty, setQty] = useState<Record<string, number>>({});
  const [coupon, setCoupon] = useState('');
  const [ordered, setOrdered] = useState<number | null>(null);
  const change = (id: string, d: number) => setQty(q => ({ ...q, [id]: Math.max(0, (q[id] ?? 0) + d) }));
  const subtotal = PRODUCTS.reduce((s, p) => s + p.price * (qty[p.id] ?? 0), 0);
  const total = coupon.trim().toUpperCase() === 'SAVE10' ? Math.round(subtotal * 0.9) : subtotal;

  if (ordered !== null) {
    return (
      <View style={styles.card}>
        <Text style={styles.h2}>Order placed</Text>
        <Text style={styles.body}>You paid ₹{ordered}. It will arrive in 20 minutes.</Text>
        <Btn title="Shop again" onPress={() => (setOrdered(null), setQty({}), setCoupon(''))} kind="secondary" />
      </View>
    );
  }
  return (
    <>
      {PRODUCTS.map(p => (
        <View key={p.id} style={[styles.card, styles.product]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.h3}>{p.name}</Text>
            <Text style={styles.muted}>₹{p.price}</Text>
          </View>
          <Pressable style={styles.qtyBtn} onPress={() => change(p.id, -1)} accessibilityLabel={`Remove one ${p.name}`}>
            <Text style={styles.qtyText}>−</Text>
          </Pressable>
          <Text style={styles.qty}>{qty[p.id] ?? 0}</Text>
          <Pressable style={styles.qtyBtn} onPress={() => change(p.id, 1)} accessibilityLabel={`Add one ${p.name}`}>
            <Text style={styles.qtyText}>+</Text>
          </Pressable>
        </View>
      ))}
      <View style={styles.card}>
        <Text style={styles.label}>Coupon code</Text>
        <TextInput style={styles.input} placeholder="e.g. SAVE10" value={coupon} onChangeText={setCoupon} autoCapitalize="characters" />
        <Text style={styles.h3}>Total: ₹{total}</Text>
        <AIAction name="checkout" description="Places the order and charges the saved card for the total">
          <Btn title="Checkout" disabled={total === 0} onPress={() => setOrdered(total)} />
        </AIAction>
      </View>
    </>
  );
}

function SettingsScreen(props: {
  mode: Mode;
  setMode: (m: Mode) => void;
  chatModel: string;
  setChatModel: (m: string) => void;
  cloudModel: string;
  setCloudModel: (m: string) => void;
  realtimeModel: string;
  setRealtimeModel: (m: string) => void;
}) {
  const [notifications, setNotifications] = useState(true);
  const [offers, setOffers] = useState(false);
  return (
    <>
      <View style={styles.card}>
        <Text style={styles.h2}>Preferences</Text>
        <View style={styles.row}>
          <Text style={styles.body}>Order notifications</Text>
          <Switch value={notifications} onValueChange={setNotifications} />
        </View>
        <View style={styles.row}>
          <Text style={styles.body}>Promotional offers</Text>
          <Switch value={offers} onValueChange={setOffers} />
        </View>
      </View>

      {/* The assistant must not reconfigure itself. */}
      <AIIgnore>
        <View style={styles.card}>
          <Text style={styles.h2}>Assistant</Text>
          <Text style={styles.label}>Mode</Text>
          <Chips
            options={[
              ['cloud', 'Cloud voice model (hears your audio)'],
              ['pipeline', 'On-device speech + chat model'],
              ['realtime', 'Voice model (realtime)'],
            ]}
            value={props.mode}
            onChange={m => props.setMode(m as Mode)}
          />
          <Text style={styles.label}>{props.mode === 'pipeline' ? 'Chat model' : 'Voice model'}</Text>
          {props.mode === 'pipeline' ? (
            <Chips options={CHAT_MODELS.map(m => [m, m])} value={props.chatModel} onChange={props.setChatModel} />
          ) : props.mode === 'cloud' ? (
            <Chips options={CLOUD_VOICE_MODELS.map(m => [m, m])} value={props.cloudModel} onChange={props.setCloudModel} />
          ) : (
            <Chips options={REALTIME_MODELS.map(m => [m, m])} value={props.realtimeModel} onChange={props.setRealtimeModel} />
          )}
          {props.mode !== 'realtime' && <VoicePicker />}
          <Text style={[styles.muted, { marginTop: 12 }]}>Server: {SERVER_URL}</Text>
        </View>
      </AIIgnore>
    </>
  );
}

const TIER = ['', 'standard', 'enhanced', 'premium'];

function VoicePicker() {
  const [voices, setVoices] = useState<RankedVoice[]>([]);
  const [current, setCurrent] = useState<string | undefined>(selectedVoice);
  useEffect(() => {
    rankedVoices('en-US').then(v => setVoices(v.slice(0, 12)), () => {});
  }, []);
  const active = current ?? voices[0]?.identifier;
  const choose = (id: string) => {
    selectedVoice = id;
    setCurrent(id);
    Speech.stop();
    Speech.speak('Hi! I can tap buttons and fill in forms for you.', { voice: id, useApplicationAudioSession: false });
  };
  return (
    <>
      <Text style={styles.label}>Voice (tap to preview)</Text>
      <Chips
        options={voices.map(v => [v.identifier, `${v.name} · ${v.language} · ${TIER[v.tier]}`])}
        value={active ?? ''}
        onChange={choose}
      />
      {voices.length > 0 && voices[0].tier < 3 && (
        <Text style={styles.muted}>
          For a much more natural voice, download a Premium one: iPhone Settings → Accessibility → Spoken Content → Voices →
          English (e.g. Zoe or Ava, Premium). On Android, install a high-quality voice in Text-to-speech settings.
        </Text>
      )}
    </>
  );
}

function Chips({ options, value, onChange }: { options: [string, string][]; value: string; onChange: (v: string) => void }) {
  return (
    <View style={styles.chips}>
      {options.map(([v, label]) => (
        <Pressable key={v} onPress={() => onChange(v)} style={[styles.chip, v === value && styles.chipActive]}>
          <Text style={[styles.chipText, v === value && styles.chipTextActive]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Btn({ title, onPress, disabled, kind = 'primary' }: { title: string; onPress: () => void; disabled?: boolean; kind?: 'primary' | 'secondary' }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.btn, kind === 'secondary' && styles.btnSecondary, disabled && styles.btnDisabled]}>
      <Text style={[styles.btnText, kind === 'secondary' && styles.btnTextSecondary]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F4F4F7' },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8, gap: 8 },
  title: { fontSize: 30, fontWeight: '700', color: '#111' },
  status: { backgroundColor: '#111', borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14 },
  statusState: { color: '#A99BFF', fontWeight: '700', fontSize: 13 },
  statusText: { color: '#fff', fontSize: 15, marginTop: 2 },
  content: { padding: 16, paddingBottom: 160, gap: 12 },
  card: { backgroundColor: '#fff', borderRadius: 16, padding: 16, gap: 8 },
  product: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  h2: { fontSize: 20, fontWeight: '700', color: '#111' },
  h3: { fontSize: 17, fontWeight: '600', color: '#111' },
  body: { fontSize: 16, color: '#222' },
  muted: { fontSize: 14, color: '#777' },
  label: { fontSize: 13, fontWeight: '600', color: '#555', marginTop: 4 },
  input: { borderWidth: 1, borderColor: '#DDD', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: '#111' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  qtyBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#EFEFF4', alignItems: 'center', justifyContent: 'center' },
  qtyText: { fontSize: 20, fontWeight: '600', color: '#111' },
  qty: { minWidth: 20, textAlign: 'center', fontSize: 16, fontWeight: '600' },
  btn: { backgroundColor: '#111', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  btnSecondary: { backgroundColor: '#EFEFF4' },
  btnDisabled: { opacity: 0.35 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  btnTextSecondary: { color: '#111' },
  tabBar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#CCC', backgroundColor: '#fff', paddingBottom: 8 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  tabText: { fontSize: 15, color: '#888', fontWeight: '600' },
  tabActive: { color: '#111' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 20, borderWidth: 1, borderColor: '#DDD', paddingHorizontal: 12, paddingVertical: 8 },
  chipActive: { backgroundColor: '#111', borderColor: '#111' },
  chipText: { color: '#333', fontSize: 14 },
  chipTextActive: { color: '#fff' },
});
