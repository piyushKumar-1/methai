import { canSpeak, deviceVoice, isInterruption, isNoSpeechError, micLevelFromRms, pickBestVoice, speechTimeoutMs, stripEcho, type RecognizerResults, type SpeechRecognizerModule, type TextToSpeechModule } from '../src';

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

describe('isInterruption', () => {
  test("the reply's own echo, however garbled, does not interrupt (real cases from a phone)", () => {
    expect(isInterruption("cancel what's the", "The search is cancelled. What's the correct destination for the mall?")).toBe(false);
    expect(isInterruption('the destination is now next is called', 'The destination is now Nexus Koramangala Mall.')).toBe(false);
    expect(isInterruption('you are what', 'Your Auto is booked for 88 rupees.')).toBe(false);
  });
  test('a stop word that the reply does not contain does', () => {
    expect(isInterruption('stop', 'Your auto is 4 minutes away.')).toBe(true);
    expect(isInterruption('your auto is wait', 'Your auto is 4 minutes away.')).toBe(true);
    expect(isInterruption('hold on', 'Booking the Mini for 665 rupees.')).toBe(true);
    expect(isInterruption('wait', 'Please wait while I look.')).toBe(false);
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
    return { heard: (await heard).text, io };
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

  test('silence and transient errors resolve empty; real recognizer failures reject', async () => {
    expect((await listen(rec => rec.error('7'))).heard).toBe('');
    expect((await listen(rec => rec.error('11'))).heard).toBe('');
    await expect(listen(rec => rec.error('12'))).rejects.toThrow('12/No match');
  });

  test("a new turn starts only after the last turn's recognizer has shut down", async () => {
    const rec = fakeRecognizer();
    let finishDestroy!: () => void;
    rec.destroy = jest.fn(() => new Promise<void>(resolve => (finishDestroy = resolve)));
    const io = deviceVoice({ recognizer: rec, tts, locale: () => 'en-IN', micOpenDelayMs: 0 });
    const first = io.listen(signal);
    await new Promise(r => setTimeout(r, 0));
    rec.error('7');
    expect((await first).text).toBe('');
    const second = io.listen(signal);
    await new Promise(r => setTimeout(r, 50));
    expect(rec.start).toHaveBeenCalledTimes(1); // still waiting for destroy()
    finishDestroy();
    await new Promise(r => setTimeout(r, 0));
    expect(rec.start).toHaveBeenCalledTimes(2);
    rec.error('7');
    expect((await second).text).toBe('');
  });

  test('its own words heard from the loudspeaker are removed', async () => {
    const rec = fakeRecognizer();
    const io = deviceVoice({ recognizer: rec, tts, locale: () => 'en-IN', micOpenDelayMs: 0 });
    await io.speak('Where would you like to go?', signal);
    const heard = io.listen(signal);
    await new Promise(r => setTimeout(r, 0));
    rec.emit('partial', ['would you like to go to the airport']);
    rec.error('7');
    expect((await heard).text).toBe('to the airport');
  });

  test('saying "stop" while it talks cuts it off; its own echo does not, and nothing heard becomes a request', async () => {
    const rec = fakeRecognizer();
    const stop = jest.fn();
    const handlers: Record<string, () => void> = {};
    const slowTts: TextToSpeechModule = {
      ...tts,
      stop: () => {
        stop();
        handlers['tts-cancel']?.();
        return Promise.resolve();
      },
      addListener: (event, handler) => ((handlers[event] = handler), { remove: () => {} }), // never finishes on its own
    };
    const io = deviceVoice({ recognizer: rec, tts: slowTts, locale: () => 'en-IN', micOpenDelayMs: 0 });
    const speaking = io.speak('Your destination is now Nexus Koramangala Mall.', signal);
    await new Promise(r => setTimeout(r, 10));
    expect(rec.start).toHaveBeenCalledTimes(1); // listening while it speaks
    rec.emit('partial', ['your destination is now next is called']); // its own voice, garbled
    expect(stop).not.toHaveBeenCalled();
    rec.emit('partial', ['your destination is now next is called stop']);
    await speaking;
    expect(stop).toHaveBeenCalled();
    const next = io.listen(signal);
    await new Promise(r => setTimeout(r, 10));
    expect(rec.start).toHaveBeenCalledTimes(2); // a fresh session for the user's request
    rec.emit('partial', ['go to Forum mall']);
    rec.error('7');
    expect((await next).text).toBe('go to Forum mall');
  });

  test('a pause mid-sentence does not end the turn: the recognizer is restarted and the rest is added on', async () => {
    const rec = fakeRecognizer();
    const io = deviceVoice({ recognizer: rec, tts, locale: () => 'en-IN', micOpenDelayMs: 0, endOfSpeechMs: 600 });
    const partials: string[] = [];
    const heard = io.listen(signal, p => partials.push(p));
    await new Promise(r => setTimeout(r, 0));
    rec.emit('partial', ['book a ride to']);
    rec.onSpeechEnd?.({}); // the phone decides the user is done after a short pause
    await new Promise(r => setTimeout(r, 350));
    expect(rec.start).toHaveBeenCalledTimes(2); // listening again for the rest
    rec.emit('partial', ['Forum mall']);
    expect(partials[partials.length - 1]).toBe('book a ride to Forum mall');
    rec.error('7');
    await new Promise(r => setTimeout(r, 10));
    expect(rec.start).toHaveBeenCalledTimes(3); // the recognizer stopped right after words again
    expect((await heard).text).toBe('book a ride to Forum mall'); // nothing more within the pause
  });

  test('a turn ends when the user really stops: a long pause, or our own silence timer', async () => {
    const rec = fakeRecognizer();
    const io = deviceVoice({ recognizer: rec, tts, locale: () => 'en-IN', micOpenDelayMs: 0, endOfSpeechMs: 100 });
    const heard = io.listen(signal);
    await new Promise(r => setTimeout(r, 0));
    rec.emit('partial', ['yes']);
    expect((await heard).text).toBe('yes');
    expect(rec.start).toHaveBeenCalledTimes(1);
    expect(rec.start).toHaveBeenCalledWith('en-IN', expect.objectContaining({ EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 100 }));
  });

  test("the recognizer's other guesses come back as alternatives", async () => {
    const rec = fakeRecognizer();
    const io = deviceVoice({ recognizer: rec, tts, locale: () => 'en-IN', micOpenDelayMs: 0 });
    const heard = io.listen(signal);
    await new Promise(r => setTimeout(r, 0));
    rec.emit('final', ['to know my three office', 'to know my office', 'office', 'to know Atri office']);
    rec.error('7');
    expect(await heard).toEqual({ text: 'to know my three office', alternatives: ['to know my office', 'office', 'to know Atri office'] });
  });
});
