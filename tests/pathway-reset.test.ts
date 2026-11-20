import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { isolatedReport } from '../src/frame.ts';

function legacyPathwayReport() {
  const code = isolatedReport('<html><head></head><body></body></html>', 'reset-channel').match(/<script>([\s\S]*?)<\/script>/)![1];
  const listeners: Record<string, (event?: any) => void | Promise<void>> = {};
  const bins = ['Wolbachia', 'Zero coverage'];
  let shown: string[] = [];
  const hide = { checked: true, dispatchEvent() { shown = this.checked ? bins.slice(0, 1) : bins.slice(); } };
  const document = {
    getElementById: (id: string) => id === 'pathway-hide-zero' ? hide : null,
    addEventListener: (name: string, callback: (event: any) => void) => { listeners[name] = callback; },
  };
  vm.runInNewContext(code, { document, parent: {}, window: {}, Event,
    addEventListener: (name: string, callback: (event?: any) => void) => { listeners[name] = callback; } });
  listeners.DOMContentLoaded();
  return { listeners, hide, shown: () => shown };
}

test('already-published pathway reports initially show zero-coverage bins', () => {
  const h = legacyPathwayReport();
  assert.equal(h.hide.checked, false);
  assert.deepEqual(h.shown(), ['Wolbachia', 'Zero coverage']);
});

test('Reset overrides the old handler that rechecks Hide zero coverage, without changing other clicks', async () => {
  const h = legacyPathwayReport();
  h.hide.checked = true; h.hide.dispatchEvent();
  assert.deepEqual(h.shown(), ['Wolbachia']);
  const other = { closest: () => null };
  await h.listeners.click({ target: other });
  assert.equal(h.hide.checked, true, 'explicit zero-coverage filtering must remain usable');
  // The old target listener runs before the viewer's document bubble listener.
  h.hide.checked = true; h.hide.dispatchEvent();
  await h.listeners.click({ target: { closest: () => ({ id: 'pathway-reset' }) } });
  assert.equal(h.hide.checked, false);
  assert.deepEqual(h.shown(), ['Wolbachia', 'Zero coverage']);
});

test('the pathway compatibility hook is harmless in reports without pathway controls', async () => {
  const code = isolatedReport('<html><head></head><body></body></html>', 'empty-channel').match(/<script>([\s\S]*?)<\/script>/)![1];
  const listeners: Record<string, (event?: any) => void | Promise<void>> = {};
  vm.runInNewContext(code, { parent: {}, window: {}, Event,
    document: { getElementById: () => null, addEventListener: (name: string, callback: (event: any) => void) => { listeners[name] = callback; } },
    addEventListener: (name: string, callback: (event?: any) => void) => { listeners[name] = callback; } });
  assert.doesNotThrow(() => listeners.DOMContentLoaded());
  await listeners.click({ target: null });
});
