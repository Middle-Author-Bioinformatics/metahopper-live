import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { initialTheme, persistTheme, resolveTheme, savedTheme, THEME_KEY } from '../src/theme.ts';
import { isolatedReport } from '../src/frame.ts';

test('theme follows the system until a valid saved choice overrides it, including blocked storage', () => {
  assert.equal(resolveTheme(null, true), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('invalid', false), 'light');
  const previous = ['localStorage', 'window'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => ({ matches: true }) } });
  try {
    assert.equal(initialTheme(), 'dark');
    persistTheme('light'); assert.equal(values.get(THEME_KEY), 'light'); assert.equal(initialTheme(), 'light');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage denied'); } });
    assert.equal(savedTheme(), null); assert.equal(initialTheme(), 'dark'); assert.doesNotThrow(() => persistTheme('light'));
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('the initial page palette is applied before the React entry loads', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const boot = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  assert(html.indexOf(boot) < html.indexOf('/src/main.tsx'));
  for (const [preference, systemDark, expected] of [[null, true, 'dark'], ['light', true, 'light'], ['dark', false, 'dark'], ['unknown', false, 'light']]) {
    const root = { dataset: {} as Record<string, string> };
    vm.runInNewContext(boot, { document: { documentElement: root }, localStorage: { getItem: () => preference }, matchMedia: () => ({ matches: systemDark }) });
    assert.equal(root.dataset.theme, expected);
  }
});

test('report themes initialize and change only through the authenticated parent channel', () => {
  const content = '<html><head></head><body><script id="original-data" type="application/json">{"untouched":true}</script></body></html>';
  const html = isolatedReport(content, 'theme-channel', 'dark');
  assert(html.includes('id="original-data" type="application/json">{"untouched":true}'));
  const code = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const root = { dataset: {} as Record<string, string>, setAttribute() {} };
  const events: Record<string, (event: any) => void> = {};
  const parent = {}; let redraws = 0;
  vm.runInNewContext(code, { document: { documentElement: root }, parent, window: { __draw() { redraws++; } },
    addEventListener: (type: string, callback: (event: any) => void) => { events[type] = callback; } });
  assert.equal(root.dataset.theme, 'dark'); assert.equal(redraws, 1);
  const data = { channel: 'theme-channel', type: 'set-theme', theme: 'light' };
  events.message({ source: {}, data });
  events.message({ source: parent, data: { ...data, channel: 'wrong' } });
  events.message({ source: parent, data: { ...data, theme: 'invalid' } });
  assert.equal(root.dataset.theme, 'dark'); assert.equal(redraws, 1);
  events.message({ source: parent, data });
  assert.equal(root.dataset.theme, 'light'); assert.equal(redraws, 2);
  events.message({ source: parent, data: { ...data, theme: 'dark' } });
  assert.equal(root.dataset.theme, 'dark'); assert.equal(redraws, 3);
});
