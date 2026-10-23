import { Component, type ReactNode } from 'react';
import { Button, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { formatSnapshot, nextScrollOffset, ScreenContextProvider } from '../src';
import { currentRootOf, fiberOfInstance } from '../src/fiber';
import { scrollScreen, type Scrollable } from '../src/scroll';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test('nextScrollOffset pages by most of the viewport and stops at the ends', () => {
  expect(nextScrollOffset(0, 800, 3000, 'down')).toBe(640);
  expect(nextScrollOffset(2100, 800, 3000, 'down')).toBe(2200); // clamped to content - viewport
  expect(nextScrollOffset(2200, 800, 3000, 'down')).toBeNull(); // already at the end
  expect(nextScrollOffset(300, 800, 3000, 'up')).toBe(0);
  expect(nextScrollOffset(0, 800, 3000, 'up')).toBeNull();
  expect(nextScrollOffset(0, 800, 500, 'down')).toBeNull(); // content fits
});

test('off-screen elements are listed as pressable without scrolling', () => {
  const text = formatSnapshot({
    screen: 'Rides',
    capturedAt: 0,
    texts: [],
    elements: [{ id: 'btn_xl_cab', kind: 'button', label: 'XL Cab', actions: ['press'], disabled: false, offscreen: true }],
  });
  expect(text).toContain('[btn_xl_cab] button "XL Cab" [off-screen; press works without scrolling]');
});

/** Stands in for React Native's ScrollView class: the scroll tool finds lists by scrollTo + getScrollResponder. */
class FakeScrollView extends Component<{ horizontal?: boolean; children: ReactNode; name: string }> {
  scrolledTo: unknown[] = [];
  scrollTo(o: unknown) {
    this.scrolledTo.push(o);
  }
  getScrollResponder() {
    return this;
  }
  render() {
    return <View>{this.props.children}</View>;
  }
}

test('scroll pages the biggest list that scrolls that way, or the one around an element', async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ScreenContextProvider>
        <FakeScrollView name="page">
          <Button title="Top" onPress={() => {}} />
        </FakeScrollView>
        <FakeScrollView name="rides">
          <Button title="Auto" onPress={() => {}} />
        </FakeScrollView>
        <FakeScrollView name="chips" horizontal>
          <Button title="Tip" onPress={() => {}} />
        </FakeScrollView>
      </ScreenContextProvider>,
    );
  });
  const [page, rides, chips] = renderer.root.findAllByType(FakeScrollView).map(n => n.instance as FakeScrollView);
  const provider = renderer.root.findByType(ScreenContextProvider).instance as ScreenContextProvider;
  const root = currentRootOf(fiberOfInstance(provider));
  // page: big, scrolled 100 down; rides: smaller; chips: horizontal.
  const sizes = new Map<any, { frame: any; content: any }>([
    [page, { frame: { x: 0, y: 0, width: 400, height: 800 }, content: { x: 0, y: -100, width: 400, height: 3000 } }],
    [rides, { frame: { x: 0, y: 400, width: 400, height: 300 }, content: { x: 0, y: 400, width: 400, height: 900 } }],
    [chips, { frame: { x: 0, y: 700, width: 400, height: 50 }, content: { x: 0, y: 700, width: 1000, height: 50 } }],
  ]);
  const measure = async (s: Scrollable) => sizes.get(s.instance) ?? null;

  expect(await scrollScreen(root, 'down', undefined, measure)).toEqual({ ok: true, message: 'Scrolled down.' });
  expect(page.scrolledTo).toEqual([{ y: 740, animated: true }]); // 100 + 0.8 × 800

  const autoFiber = fiberOfInstance(rides)!;
  expect(await scrollScreen(root, 'down', autoFiber, measure)).toEqual({ ok: true, message: 'Scrolled down.' });
  expect(rides.scrolledTo).toEqual([{ y: 240, animated: true }]);

  await scrollScreen(root, 'right', undefined, measure);
  expect(chips.scrolledTo).toEqual([{ x: 320, animated: true }]);

  expect((await scrollScreen(root, 'up', autoFiber, measure)).message).toBe('Already at the start of the list.');
  await act(async () => renderer.unmount());
});
