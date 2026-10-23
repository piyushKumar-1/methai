import { openAIChatModel } from '../src';

const reply = (content: string) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });
const failure = (status: number, message: string) => ({ ok: false, status, json: async () => ({ error: { message } }) });
const signal = new AbortController().signal;

let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  (globalThis as any).fetch = fetchMock;
});
const modelsAsked = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).model);

test('a rate-limited model falls back to the next one, with the same conversation', async () => {
  fetchMock.mockResolvedValueOnce(failure(429, 'No deployments available')).mockResolvedValueOnce(reply('Where to?'));
  const log = jest.fn();
  const model = openAIChatModel({ endpoint: '/chat', model: 'kimi-k3', fallbackModels: ['open-large', 'kimi-k3'], log });
  expect(await model.start('book a cab', 'Screen: Home', signal, 'rules')).toEqual({ text: 'Where to?', toolCalls: [] });
  expect(modelsAsked()).toEqual(['kimi-k3', 'open-large']);
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages).toEqual(JSON.parse(fetchMock.mock.calls[0][1].body).messages);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('trying open-large'));

  // The failed model sits out its cooldown: the next call goes straight to the one that worked.
  fetchMock.mockResolvedValueOnce(reply('Booked.'));
  await model.followUp!('home', 'Screen: Home', signal);
  expect(modelsAsked()[2]).toBe('open-large');
});

test('network errors fall back too; a bad request does not', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('Network request failed')).mockResolvedValueOnce(reply('Hi'));
  const model = openAIChatModel({ endpoint: '/chat', model: 'a', fallbackModels: ['b'] });
  expect((await model.start('hi', 's', signal, 'r')).text).toBe('Hi');

  fetchMock.mockResolvedValueOnce(failure(400, 'bad tools'));
  const strict = openAIChatModel({ endpoint: '/chat', model: 'c', fallbackModels: ['d'] });
  await expect(strict.start('hi', 's', signal, 'r')).rejects.toThrow('Model request failed (400): bad tools');
  expect(modelsAsked().slice(2)).toEqual(['c']);
});

test('when every model fails, the last error is reported', async () => {
  fetchMock.mockResolvedValue(failure(503, 'overloaded'));
  const model = openAIChatModel({ endpoint: '/chat', model: 'a', fallbackModels: ['b'] });
  await expect(model.start('hi', 's', signal, 'r')).rejects.toThrow('Model request failed (503): overloaded');
  expect(modelsAsked()).toEqual(['a', 'b']);
});

test('a model that takes too long is dropped for the next one; the last one gets all the time it needs', async () => {
  fetchMock.mockImplementationOnce(
    (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('Aborted')))),
  );
  fetchMock.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(reply('Hi')), 80)));
  const model = openAIChatModel({ endpoint: '/chat', model: 'slow', fallbackModels: ['fast'], attemptTimeoutMs: 30 });
  expect((await model.start('hi', 's', signal, 'r')).text).toBe('Hi'); // 80ms > 30ms, but it is the last
  expect(modelsAsked()).toEqual(['slow', 'fast']);
});

test('closing the assistant aborts the call without trying fallbacks', async () => {
  const controller = new AbortController();
  fetchMock.mockImplementation(
    (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('Aborted')))),
  );
  const model = openAIChatModel({ endpoint: '/chat', model: 'a', fallbackModels: ['b'], attemptTimeoutMs: 1000 });
  const call = model.start('hi', 's', controller.signal, 'r');
  controller.abort();
  await expect(call).rejects.toThrow('Aborted');
  expect(modelsAsked()).toEqual(['a']);
});
