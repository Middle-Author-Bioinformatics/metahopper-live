import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { reportsFromItems, taxonomyPath, type Report } from '../src/catalog.ts';
import { loadTaxonomy, MAX_TAXONOMY_BYTES, parseTaxonomy, searchTaxonomy, type TaxonomyIndex } from '../src/taxonomy.ts';
import { isolatedReport } from '../src/frame.ts';

const prefix = 'reports/aphrophora/';
const tag = 'a'.repeat(32);
const report: Report = { sample: 'Sample', path: `${prefix}Sample/metahopper_report.html`, eTag: `"${tag}"`, size: 1000, version: 'v1', taxonomyPath: `${prefix}Sample/taxonomy/${tag}.json` };
const bin = { rank: 'genus' as const, bin: 'Sodalis_test', total_length_bp: 12000, num_contigs: 10, N50: 2000, GC_percent: 30,
  completeness_percent: 0, contamination_percent: null, strain_heterogeneity_percent: null };
const makeIndex = (r = report): TaxonomyIndex => ({ schema: 'metahopper-taxonomy-1', sample: r.sample, stage: 'final', bins: [bin],
  report: { etag: r.eTag!.replace(/"/g, ''), size: r.size!, sha256: 'b'.repeat(64) } });

test('only the index tied to the current report ETag is discovered, including multipart ETags', () => {
  const objects = [report, { path: report.taxonomyPath!, size: 400 },
    { path: `${prefix}Sample/taxonomy/${'b'.repeat(32)}.json`, size: 400 }];
  assert.equal(reportsFromItems(objects, prefix)[0].taxonomyPath, report.taxonomyPath);
  assert.equal(reportsFromItems([{ ...report, eTag: 'c'.repeat(32) }, ...objects.slice(1)], prefix)[0].taxonomyPath, undefined);
  const multipart = { ...report, eTag: `"${tag}-3"` };
  assert.equal(taxonomyPath(multipart), `${prefix}Sample/taxonomy/${tag}-3.json`);
  assert.equal(reportsFromItems(objects, 'reports/phoridae/').length, 0);
});

test('taxonomy index validates sample, report version, metrics, and named-domain catchalls', () => {
  assert.equal(parseTaxonomy(makeIndex(), report).bins[0].completeness_percent, 0);
  for (const name of ['unclassified_Bacteria', 'unclassified_Viruses']) {
    const data = makeIndex(); data.bins[0] = { ...bin, bin: name };
    assert.doesNotThrow(() => parseTaxonomy(data, report));
  }
  const changes = [
    (d: TaxonomyIndex) => { d.sample = 'Other'; },
    (d: TaxonomyIndex) => { d.report.etag = 'c'.repeat(32); },
    (d: TaxonomyIndex) => { d.report.size++; },
    (d: TaxonomyIndex) => { d.bins = [{ ...bin, total_length_bp: -1 }]; },
    (d: TaxonomyIndex) => { d.bins = [{ ...bin, completeness_percent: NaN }]; },
    (d: TaxonomyIndex) => { d.bins = [{ ...bin, bin: 'Unclassified' }]; },
    (d: TaxonomyIndex) => { d.bins = [bin, bin]; },
  ];
  for (const change of changes) { const data = makeIndex(); change(data); assert.throws(() => parseTaxonomy(data, report)); }
});

test('taxon search spans samples and ranks, normalizes names, and drops stale or removed reports', () => {
  const second = { ...report, path: `${prefix}Second/metahopper_report.html`, sample: 'Second' };
  const indexes = new Map([[report.path, { version: 'v1', index: makeIndex() }], [second.path, { version: 'v1', index: makeIndex(second) }]]);
  indexes.get(second.path)!.index.bins.push({ ...bin, rank: 'species', bin: 'Sodalis_test_sp.' });
  assert.equal(searchTaxonomy([report, second], indexes, ' sODaLis  TEST ').length, 3);
  assert.equal(searchTaxonomy([report, second], indexes, 'sodalis', 'species').length, 1);
  assert.equal(searchTaxonomy([report], indexes, 'sodalis').length, 1);
  assert.equal(searchTaxonomy([{ ...report, version: 'v2' }], indexes, 'sodalis').length, 0);
  assert.equal(searchTaxonomy([report], indexes, '<script>').length, 0);
});

test('index fetching stays bounded and cancels without delivering results after project changes', async () => {
  const reports = Array.from({ length: 10 }, (_, i) => ({ ...report, sample: `Sample${i}` }));
  let pending = 0, max = 0, received = 0;
  await loadTaxonomy(reports, async (r) => {
    pending++; max = Math.max(max, pending); await new Promise((resolve) => setTimeout(resolve, 1)); pending--;
    return makeIndex(r);
  }, new AbortController().signal, () => received++);
  assert.equal(max, 4); assert.equal(received, 10);
  const controller = new AbortController(); received = 0;
  await assert.rejects(loadTaxonomy(reports, async () => { controller.abort(); return makeIndex(); }, controller.signal, () => received++), /abort/i);
  assert.equal(received, 0);
});

const storageCode = stripTypeScriptTypes(readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replace(/\bexport (?=(?:async )?function)/g, '') + '\n({readTaxonomyIndex})';
function storageHarness(body = JSON.stringify(makeIndex()), contentLength?: number) {
  const paths: string[] = [];
  const api = vm.runInNewContext(storageCode, { taxonomyPath, MAX_TAXONOMY_BYTES, parseTaxonomy, TextDecoder,
    getProjectUrl: async ({ path }: { path: string }) => { paths.push(path); return { url: new URL('https://example.invalid/index') }; },
    fetch: async () => new Response(body, { headers: contentLength ? { 'content-length': String(contentLength) } : {} }),
  });
  return { api, paths };
}

test('taxonomy storage isolates the selected project and report before requesting a private URL', async () => {
  const { api, paths } = storageHarness();
  await assert.rejects(api.readTaxonomyIndex({ prefix: 'reports/phoridae/' }, report, new AbortController().signal), /outside/);
  await assert.rejects(api.readTaxonomyIndex({ prefix }, { ...report, taxonomyPath: `${prefix}Other/index.json` }, new AbortController().signal), /outside/);
  assert.equal(paths.length, 0);
  const result = await api.readTaxonomyIndex({ prefix }, report, new AbortController().signal);
  assert.equal(result.bins[0].bin, 'Sodalis_test'); assert.deepEqual(paths, [report.taxonomyPath]);
});

test('taxonomy transfers reject oversized metadata and oversized streams', async () => {
  for (const h of [storageHarness('{}', MAX_TAXONOMY_BYTES + 1), storageHarness('x'.repeat(MAX_TAXONOMY_BYTES + 1))]) {
    await assert.rejects(h.api.readTaxonomyIndex({ prefix }, report, new AbortController().signal), /size limit/);
  }
});

test('focus-bin messages require the exact frame channel and parent window', () => {
  const html = isolatedReport('<html><head></head><body></body></html>', 'channel');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const events: Record<string, (event: any) => void> = {};
  const parent = {}, search = { value: '', dispatchEvent() {} }, rank = { value: '' };
  let clicked = 0, scrolled = 0;
  const row = { dataset: { rank: 'genus', binName: 'Sodalis_test' }, classList: { add() {} }, scrollIntoView() { scrolled++; } };
  vm.runInNewContext(script, { parent, window: {}, Map, Set, JSON, Event,
    addEventListener: (name: string, callback: (event: any) => void) => { events[name] = callback; },
    document: { getElementById: (id: string) => id === 'bin-search' ? search : rank,
      querySelectorAll: (selector: string) => selector.startsWith('#bin-table') ? [row] : [],
      querySelector: () => ({ click() { clicked++; } }) },
  });
  const data = { channel: 'channel', type: 'focus-bin', rank: 'genus', bin: 'Sodalis_test', request: 1 };
  events.message({ source: {}, data }); events.message({ source: parent, data: { ...data, channel: 'wrong' } });
  assert.equal(scrolled, 0);
  events.message({ source: parent, data }); events.message({ source: parent, data });
  assert.equal(clicked, 1); assert.equal(scrolled, 1); assert.equal(search.value, 'Sodalis_test');
});

test('one authenticated parent rank controls the report, including ranks missing from a sample', () => {
  const html = isolatedReport('<html><head></head><body></body></html>', 'channel');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const events: Record<string, (event: any) => void> = {};
  const parent = {}, changes: string[] = [], classes: string[] = [];
  let hidden = false;
  const rank = { value: 'phylum', options: [{ value: 'phylum' }],
    appendChild(option: { value: string }) { this.options.push(option); },
    dispatchEvent() { changes.push(this.value); },
    parentElement: { setAttribute() { hidden = true; } },
  };
  vm.runInNewContext(script, { parent, window: {}, Map, Set, JSON, Event,
    addEventListener: (name: string, callback: (event: any) => void) => { events[name] = callback; },
    document: { getElementById: () => rank, createElement: () => ({}),
      body: { classList: { add: (value: string) => classes.push(value) } } },
  });
  const data = { channel: 'channel', type: 'set-report-rank', rank: 'genus' };
  events.message({ source: {}, data });
  events.message({ source: parent, data: { ...data, channel: 'wrong' } });
  events.message({ source: parent, data: { ...data, rank: 'all' } });
  assert.deepEqual(changes, []); assert.equal(hidden, false);
  events.message({ source: parent, data });
  assert.equal(rank.value, 'genus'); assert.deepEqual(changes, ['genus']);
  assert.equal(rank.options.length, 2); assert.equal(hidden, true);
  assert.deepEqual(classes, ['mh-shared-rank']);
  events.message({ source: parent, data: { ...data, rank: 'species' } });
  events.message({ source: parent, data: { ...data, rank: 'genus' } });
  assert.deepEqual(changes, ['genus', 'species', 'genus']);
  assert.equal(rank.options.length, 3, 'rank changes must not add duplicate options');
  assert(html.includes('body.mh-shared-rank #bin-rank-control'));
});
