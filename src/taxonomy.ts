import type { Report } from './catalog';

export const TAXONOMY_RANKS = ['phylum', 'class', 'order', 'family', 'genus', 'species'] as const;
export type Rank = typeof TAXONOMY_RANKS[number];
export interface BinSummary {
  rank: Rank; bin: string;
  total_length_bp: number | null; num_contigs: number | null; N50: number | null; GC_percent: number | null;
  completeness_percent: number | null; contamination_percent: number | null; strain_heterogeneity_percent: number | null;
}
export interface TaxonomyIndex {
  schema: 'metahopper-taxonomy-1'; sample: string; stage: 'final' | 'preliminary'; bins: BinSummary[];
  report: { etag: string; sha256: string; size: number };
}
export interface BinFocus { rank: Rank; bin: string; request: number }
export interface TaxonMatch { report: Report; bin: BinSummary }
export const MAX_TAXONOMY_BYTES = 8 * 1024 * 1024;
const metrics = ['total_length_bp', 'num_contigs', 'N50', 'GC_percent', 'completeness_percent',
  'contamination_percent', 'strain_heterogeneity_percent'] as const;

export function parseTaxonomy(value: unknown, report: Report): TaxonomyIndex {
  const data = value as TaxonomyIndex;
  if (!data || data.schema !== 'metahopper-taxonomy-1' || data.sample !== report.sample
      || !['final', 'preliminary'].includes(data.stage) || !Array.isArray(data.bins)
      || data.bins.length > 50_000 || data.report?.etag !== report.eTag?.replace(/^"|"$/g, '').toLowerCase()
      || data.report?.size !== report.size || !/^[0-9a-f]{64}$/.test(data.report?.sha256 ?? '')) {
    throw new Error('Taxonomy index does not match this published report');
  }
  const seen = new Set<string>();
  for (const bin of data.bins) {
    if (!bin || !TAXONOMY_RANKS.includes(bin.rank) || typeof bin.bin !== 'string' || !bin.bin.trim() || bin.bin.length > 1000
        || ['unclassified', 'unbinned', 'unassigned'].includes(bin.bin.trim().toLowerCase())
        || metrics.some((key) => bin[key] !== null && (typeof bin[key] !== 'number' || !Number.isFinite(bin[key]) || bin[key]! < 0))) {
      throw new Error('Invalid bin in taxonomy index');
    }
    const key = `${bin.rank}/${bin.bin}`;
    if (seen.has(key)) throw new Error('Duplicate bin in taxonomy index');
    seen.add(key);
  }
  return data;
}

export function normalizeTaxon(value: string): string {
  return value.toLocaleLowerCase().replace(/[_\s]+/g, ' ').trim();
}

export function searchTaxonomy(reports: readonly Report[], indexes: ReadonlyMap<string, { version: string; index: TaxonomyIndex }>, query: string, rank = 'all'): TaxonMatch[] {
  const term = normalizeTaxon(query);
  if (!term) return [];
  return reports.flatMap((report) => {
    const entry = indexes.get(report.path);
    if (!entry || entry.version !== report.version || !report.taxonomyPath) return [];
    return entry.index.bins.filter((bin) => (rank === 'all' || rank === bin.rank) && normalizeTaxon(bin.bin).includes(term))
      .map((bin) => ({ report, bin }));
  }).sort((a, b) => a.report.sample.localeCompare(b.report.sample, undefined, { numeric: true })
      || TAXONOMY_RANKS.indexOf(a.bin.rank) - TAXONOMY_RANKS.indexOf(b.bin.rank)
      || a.bin.bin.localeCompare(b.bin.bin));
}

export async function loadTaxonomy(
  reports: readonly Report[], read: (report: Report, signal: AbortSignal) => Promise<TaxonomyIndex>,
  signal: AbortSignal, receive: (report: Report, index: TaxonomyIndex | null) => void,
): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < reports.length) {
      signal.throwIfAborted();
      const report = reports[next++];
      let index: TaxonomyIndex | null = null;
      try { index = await read(report, signal); } catch { signal.throwIfAborted(); }
      signal.throwIfAborted();
      receive(report, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, reports.length) }, worker));
}

export function sizeLabel(value: number | null): string {
  if (value === null) return '—';
  const unit = value >= 1e6 ? 1e6 : value >= 1e3 ? 1e3 : 1;
  return (value / unit).toLocaleString(undefined, { maximumFractionDigits: 2 }) + (unit === 1e6 ? ' Mb' : unit === 1e3 ? ' kb' : ' bp');
}
