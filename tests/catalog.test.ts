import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPages, reportsFromItems } from '../src/catalog.ts';
import { isolatedReport } from '../src/frame.ts';

const prefix = 'reports/phoridae/';
const item = (sample: string, tag = 'v1') => ({ path: `${prefix}${sample}/metahopper_report.html`, eTag: tag, size: 3000 });

test('discovers only completed, direct sample reports within the project', () => {
  const reports = reportsFromItems([
    item('SPH10'), item('SPH2'), item('SPH2'),
    { path: 'reports/other/SPH4/metahopper_report.html', size: 50 },
    { path: `${prefix}SPH1/raw.fastq.gz`, size: 50 },
    { path: `${prefix}SPH1/nested/metahopper_report.html`, size: 50 },
    { path: `${prefix}metahopper_report.html`, size: 50 },
    { path: `${prefix}SPH9/metahopper_report.html`, size: 0 },
  ], prefix);
  assert.deepEqual(reports.map((r) => r.sample), ['SPH2', 'SPH10']);
});

test('same-size overwrites change the report version; new and deleted samples reconcile', () => {
  const first = reportsFromItems([item('SPH1'), item('SPH2')], prefix);
  const next = reportsFromItems([item('SPH1', 'v2'), item('SPH3')], prefix);
  assert.notEqual(first[0].version, next[0].version);
  assert.deepEqual(next.map((r) => r.sample), ['SPH1', 'SPH3']);
});

test('reads every page and rejects partial results if a later page fails', async () => {
  const tokens: (string | undefined)[] = [];
  const all = await collectPages(async (token) => {
    tokens.push(token);
    return token ? { items: [item('SPH2')] } : { items: [item('SPH1')], nextToken: 'page2' };
  });
  assert.deepEqual(tokens, [undefined, 'page2']);
  assert.equal(all.length, 2);
  await assert.rejects(collectPages(async (token) => {
    if (token) throw new Error('Access denied');
    return { items: [item('SPH1')], nextToken: 'page2' };
  }));
});

test('aborts old sessions and prevents repeated pagination token loops', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collectPages(async () => ({ items: [] }), controller.signal));
  await assert.rejects(collectPages(async () => ({ items: [], nextToken: 'same' })), /Repeated/);
});

test('puts report network restrictions before report scripts and preserves embedded data', () => {
  const html = '<!doctype html><html><head><script>var DATA={sample:"SPH1"}</script></head><body></body></html>';
  const result = isolatedReport(html, 'test-channel');
  assert.ok(result.indexOf('Content-Security-Policy') < result.indexOf('var DATA'));
  assert.ok(result.includes("connect-src 'none'"));
  assert.ok(result.includes('var DATA={sample:"SPH1"}'));
  assert.throws(() => isolatedReport('invalid', 'test-channel'));
});
