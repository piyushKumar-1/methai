import { canSpeak, deviceVoice, isNoSpeechError, micLevelFromRms, pickBestVoice, speechTimeoutMs, stripEcho, type RecognizerResults, type SpeechRecognizerModule, type TextToSpeechModule } from '../src';

const voice = (id: string, language: string, quality = 300, extra = {}) => ({
  id,
  language,
  quality,
  latency: 200,
  networkConnectionRequired: false,
  notInstalled: false,
  ...extra,
});

describe('pickBestVoice', () => {
  test('prefers the exact region, then quality, then premium voices', () => {
    expect(pickBestVoice([voice('en-us', 'en-US', 400), voice('en-in', 'en-IN', 400)], 'en-IN')).toBe('en-in');
    expect(pickBestVoice([voice('kn-low', 'kn-IN', 200), voice('kn-high', 'kn-IN', 500)], 'kn-IN')).toBe('kn-high');
    expect(pickBestVoice([voice('com.apple.voice.compact.Rishi', 'en-IN'), voice('com.apple.voice.enhanced.Rishi', 'en-IN')], 'en-IN')).toBe(
      'com.apple.voice.enhanced.Rishi',
    );
  });

  test('lets an equal local voice beat a network one and skips voices not installed', () => {
    expect(pickBestVoice([voice('net', 'hi-IN', 400, { networkConnectionRequired: true }), voice('local', 'hi-IN', 400)], 'hi-IN')).toBe('local');
    expect(pickBestVoice([voice('best', 'ta-IN', 500, { notInstalled: true }), voice('ok', 'ta-IN')], 'ta-IN')).toBe('ok');
  });

  test('accepts other regions and underscores; undefined when nothing speaks the language', () => {
    expect(pickBestVoice([voice('en-gb', 'en_GB', 400)], 'en-IN')).toBe('en-gb');
    expect(pickBestVoice([voice('en-us', 'en-US')], 'kn-IN')).toBeUndefined();
    expect(pickBestVoice([], 'en-IN')).toBeUndefined();
  });
});

describe('stripEcho', () => {
  const greeting = 'Hi! Where would you like to go?';
  test('drops the tail of what was just said', () => {
    expect(stripEcho('hi where would you like to go', greeting)).toBe('');
    expect(stripEcho('would you like to go book an auto', greeting)).toBe('book an auto');
  });
  test('keeps short answers and requests that repeat its words', () => {
    expect(stripEcho('book it', 'Shall I book it?')).toBe('book it');
    expect(stripEcho('yes', 'Shall I book it? yes')).toBe('yes');
    expect(stripEcho('the non AC mini please', 'The Non-AC Mini is 665 rupees. Shall I book it?')).toBe('the non AC mini please');
    expect(stripEcho(' go to the airport ', greeting)).toBe('go to the airport');
    expect(stripEcho('book an auto', undefined)).toBe('book an auto');
    expect(stripEcho('', greeting)).toBe('');
  });
});

test('small helpers', () => {
  expect(isNoSpeechError('7', 'No match')).toBe(true);
  expect(isNoSpeechError(undefined, '1110/No speech detected')).toBe(true);
  expect(isNoSpeechError('5', 'Client side error')).toBe(false);
  expect(micLevelFromRms(5)).toBe(0.5);
  expect(micLevelFromRms(-2)).toBe(0);
  expect(micLevelFromRms(undefined)).toBe(0);
  expect(speechTimeoutMs('hi')).toBe(4000);
  expect(speechTimeoutMs('x'.repeat(10_000))).toBe(30000);
  expect(canSpeak('kn-IN', ['en-US', 'kn_IN'])).toBe(true);
  expect(canSpeak('kn-IN', ['en-US'])).toBe(false);
});

describe('deviceVoice', () => {
  function fakeRecognizer() {
    const rec: SpeechRecognizerModule & { emit: (kind: 'partial' | 'final', value: string[]) => void; error: (code: string) => void } = {
      start: jest.fn(async () => {}),
      stop: jest.fn(async () => {}),
      destroy: jest.fn(async () => {}),
      removeAllListeners: jest.fn(),
      emit: (kind, value) => (kind === 'partial' ? rec.onSpeechPartialResults : rec.onSpeechResults)?.({ value } as RecognizerResults),
      error: code => rec.onSpeechError?.({ error: { code, message: `${code}/No match` } }),
    };
    return rec;
  }
  const tts: TextToSpeechModule = {
    getInitStatus: async () => 'success',
    setDefaultRate: async () => {},
    setDefaultLanguage: async () => {},
    setDefaultVoice: async () => {},
    voices: async () => [voice('en-in', 'en-IN')],
    speak: () => 1,
    stop: async () => {},
    addListener: (_event, handler) => {
      setTimeout(handler, 5); // "finished speaking"
      return { remove: () => {} };
    },
  };
  const signal = new AbortController().signal;
  const listen = async (script: (rec: ReturnType<typeof fakeRecognizer>) => void) => {
    const rec = fakeRecognizer();
    const io = deviceVoice({ recognizer: rec, tts, locale: () => 'en-IN', micOpenDelayMs: 0 });
    const heard = io.listen(signal);
    await new Promise(r => setTimeout(r, 0));
    script(rec);
    return { heard: await heard, io };
  };

  test('a one-word answer followed by "no match" is still heard', async () => {
    const { heard } = await listen(rec => {
      rec.emit('partial', ['']);
      rec.emit('partial', ['yes']);
      rec.error('7');
    });
    expect(heard).toBe('yes');
  });

  test('an empty final result does not wipe what was heard', async () => {
    const { heard } = await listen(rec => {
      rec.emit('partial', ['book an auto']);
      rec.emit('final', ['']);
      rec.error('7');
    });
    expect(heard).toBe('book an auto');
  });

  test('silence resolves empty; real recognizer failures reject', async () => {
    expect((await listen(rec => rec.error('7'))).heard).toBe('');
    await expect(listen(rec => rec.error('5'))).rejects.toThrow('5/No match');
  });

  test('its own words heard from the loudspeaker are removed', async () => {
    const rec = fakeRecognizer();
    const io = deviceVoice({ recognizer: rec, tts, locale: () => 'en-IN', micOpenDelayMs: 0 });
    await io.speak('Where would you like to go?', signal);
    const heard = io.listen(signal);
    await new Promise(r => setTimeout(r, 0));
    rec.emit('partial', ['would you like to go to the airport']);
    rec.error('7');
    expect(await heard).toBe('to the airport');
  });
});
