import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { assemblyContext } from '../src/assembly-context.ts';
import { isolatedReport } from '../src/frame.ts';

function report(source: unknown) {
  return '<html><head></head><body><div id="pane-bins" class="pane on"></div>'
    + '<script id="bin-partition-data" type="application/json">'
    + JSON.stringify({ source, total_bp: 19950000, ranks: {} })
    + '</script><script id="other-data" type="application/json">{"untouched":true}</script></body></html>';
}

test('assembly scope follows the actual source, including initial and unknown sources', () => {
  for (const source of ['final/assembly/consolidated_contigs.fasta', 'final/assembly/contigs.fasta']) {
    assert.equal(assemblyContext(report(source))?.label, 'Retained assembly');
    assert.match(assemblyContext(report(source))!.description, /Removed host and other excluded/);
  }
  for (const source of ['megahit/final.contigs.fa', 'assembly/preliminary_contigs.fasta']) {
    assert.equal(assemblyContext(report(source))?.label, 'Initial assembly');
  }
  for (const source of [null, 42, 'unknown.fasta', 'elsewhere/final/assembly/consolidated_contigs.fasta']) {
    const context = assemblyContext(report(source));
    assert.equal(context?.label, 'Displayed assembly');
    assert.doesNotMatch(context!.description, /Removed host/);
  }
  assert.equal(assemblyContext('<script id="bin-partition-data">invalid</script>'), null);
  assert.equal(assemblyContext('<html><head></head></html>'), null);
});

test('current S3 reports gain one compact scope note without changing scientific data', () => {
  const input = report('final/assembly/consolidated_contigs.fasta');
  const output = isolatedReport(input, 'assembly-channel');
  assert.match(output, /id="pane-bins"[^>]*><p id="assembly-scope-note"/);
  assert.match(output, /<strong>Retained assembly<\/strong>/);
  for (const script of input.matchAll(/<script[^>]*type="application\/json">[\s\S]*?<\/script>/g)) assert(output.includes(script[0]));
  const current = input.replace('<div id="pane-bins" class="pane on">', '<div id="pane-bins" class="pane on"><p id="assembly-scope-note">Existing note</p>');
  assert.equal((isolatedReport(current, 'assembly-channel').match(/id="assembly-scope-note"/g) ?? []).length, 1);
});

test('legacy partition labels stay scoped through rank and search redraws', () => {
  const events: Record<string, (event?: any) => void> = {};
  const callbacks: Record<string, () => void> = {};
  const total = { textContent: '19.95 Mb' };
  const titles = [{ textContent: 'Full assembly' }, { textContent: 'Full assembly to genus bins' }, { textContent: 'Full assembly bacterium' }];
  let aria = 'Full assembly partition at the genus rank';
  const svg = { getAttribute: () => aria, setAttribute: (_key: string, value: string) => { aria = value; }, querySelectorAll: () => titles };
  const nodes: Record<string, unknown> = {
    'bin-partition-total': total, 'bin-partition-figure': { querySelector: () => svg },
    'rank-filter': { addEventListener: (_name: string, callback: () => void) => { callbacks.rank = callback; } },
    'bin-search': { addEventListener: (_name: string, callback: () => void) => { callbacks.search = callback; } },
  };
  const document = { getElementById: (id: string) => nodes[id] ?? null,
    addEventListener(name: string, callback: () => void) { if (name === 'metahopper:bins-filter') callbacks.redraw = callback; } };
  const code = isolatedReport(report('final/assembly/consolidated_contigs.fasta'), 'assembly-channel').match(/<script>([\s\S]*?)<\/script>/)![1];
  vm.runInNewContext(code, { document, window: {}, parent: {}, addEventListener: (name: string, callback: (event?: any) => void) => { events[name] = callback; } });
  events.DOMContentLoaded();
  assert.equal(total.textContent, 'Retained assembly · 19.95 Mb');
  assert.equal(titles[0].textContent, 'Retained assembly');
  assert.equal(titles[1].textContent, 'Retained assembly to genus bins');
  assert.equal(titles[2].textContent, 'Full assembly bacterium');
  assert.equal(aria, 'Retained assembly partition at the genus rank');
  for (const callback of [callbacks.rank, callbacks.search, callbacks.redraw]) {
    total.textContent = '19.95 Mb'; titles[0].textContent = 'Full assembly';
    callback(); callback();
    assert.equal(total.textContent, 'Retained assembly · 19.95 Mb');
    assert.equal(titles[0].textContent, 'Retained assembly');
  }
});
