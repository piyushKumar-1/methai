import { withConfirmationGuard, withModelLogging, withModelTimeout, type AgentModel, type ModelToolResult, type ModelTurn } from '../src';

jest.mock('../src/ScreenContextProvider', () => ({
  ...jest.requireActual('../src/ScreenContextProvider'),
  getScreenContext: () => ({ captureSync: () => ({ elements: [{ id: 'btn_book', label: 'Book Ride @ ₹45' }] }) }),
}));

const press = (id: string, callId = id) => ({ id: callId, name: 'press_element', input: JSON.stringify({ element_id: id }) });
const signal = new AbortController().signal;

const scripted = (turns: ModelTurn[]) => {
  const sent: ModelToolResult[][] = [];
  const next = () => Promise.resolve(turns.shift() ?? { text: 'done', toolCalls: [] });
  const model: AgentModel = { start: jest.fn(next), continue: jest.fn(async r => (sent.push(r), next())), followUp: jest.fn(next) };
  return { model, sent };
};

describe('withConfirmationGuard', () => {
  const opts = { isSensitive: (id: string) => id === 'btn_book' };

  test('passes ordinary presses through and blocks an unconfirmed sensitive one', async () => {
    const plain = scripted([{ toolCalls: [press('btn_auto')] }]);
    expect((await withConfirmationGuard(plain.model, opts).start('go', '', signal, '')).toolCalls).toEqual([press('btn_auto')]);

    const { model, sent } = scripted([{ toolCalls: [press('btn_book')] }, { text: 'Book it?', toolCalls: [] }]);
    expect(await withConfirmationGuard(model, opts).start('book', '', signal, '')).toEqual({ text: 'Book it?', toolCalls: [] });
    expect(sent[0][0].isError).toBe(true);
  });

  test('a yes allows one press; a no does not; repeated attempts become a question', async () => {
    const yes = scripted([{ text: 'Book it?', toolCalls: [] }, { toolCalls: [press('btn_book')] }]);
    const guarded = withConfirmationGuard(yes.model, opts);
    await guarded.start('book', '', signal, '');
    expect((await guarded.followUp!('yes', '', signal)).toolCalls).toEqual([press('btn_book')]);

    const no = scripted([{ text: 'Book it?', toolCalls: [] }, { toolCalls: [press('btn_book')] }, { text: 'Okay.', toolCalls: [] }]);
    const g2 = withConfirmationGuard(no.model, opts);
    await g2.start('book', '', signal, '');
    expect(await g2.followUp!('no wait', '', signal)).toEqual({ text: 'Okay.', toolCalls: [] });

    const pushy = scripted([{ toolCalls: [press('btn_book', 'a')] }, { toolCalls: [press('btn_book', 'b')] }, { toolCalls: [press('btn_book', 'c')] }]);
    expect(await withConfirmationGuard(pushy.model, opts).start('book', '', signal, '')).toEqual({ text: 'Should I go ahead with Book Ride @ ₹45?', toolCalls: [] });
  });
});

test('withModelTimeout fails a call that never answers', async () => {
  jest.useFakeTimers();
  const model: AgentModel = { start: () => new Promise(() => {}), continue: jest.fn() };
  const turn = withModelTimeout(model, 45000).start('hi', '', signal, '');
  jest.advanceTimersByTime(45000);
  await expect(turn).rejects.toThrow('no answer in 45s');
  jest.useRealTimers();
});

test('withModelLogging logs requests, tool calls and replies', async () => {
  const lines: string[] = [];
  const { model } = scripted([{ toolCalls: [press('btn_auto')] }, { text: 'Done.', toolCalls: [] }]);
  const logged = withModelLogging(model, l => lines.push(l));
  await logged.start('go', 'Screen: Home', signal, '');
  await logged.continue([{ id: 'x', content: 'OK', isError: false }], signal);
  expect(lines[0]).toBe('request "go"; screen:\nScreen: Home');
  expect(lines[1]).toMatch(/^start \(\d+ms\) → tools: press_element/);
  expect(lines[2]).toBe('tool result: OK');
  expect(lines[3]).toMatch(/^continue \(\d+ms\) → reply: "Done."$/);
});
