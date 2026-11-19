import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Project } from '../project';
import type { Report } from './catalog';
import { readTaxonomyIndex } from './storage';
import { loadTaxonomy, searchTaxonomy, sizeLabel, TAXONOMY_RANKS, type BinFocus, type TaxonomyIndex, type Rank } from './taxonomy';

interface Props {
  project: Project; reports: Report[];
  onSelect: (report: Report, bin: BinFocus) => void;
  rank: Rank;
  onRankChange: (rank: Rank) => void;
  sampleControls?: ReactNode;
}
type Entry = { version: string; index: TaxonomyIndex };
const PAGE_SIZE = 30;
const numeric = (value: number | null, digits = 0) => value === null ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: digits });

export default function TaxonomySearch({ project, reports, onSelect, rank, onRankChange, sampleControls }: Props) {
  const [query, setQuery] = useState('');
  const [indexes, setIndexes] = useState(new Map<string, Entry>());
  const [failed, setFailed] = useState(new Set<string>());
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const cache = useRef(new Map<string, Entry>());
  const active = !!query.trim();
  const focusRequest = useRef(0);

  useEffect(() => {
    if (!active) { setLoading(false); return; }
    const controller = new AbortController();
    const pending = reports.filter((r) => r.taxonomyPath && cache.current.get(r.path)?.version !== r.version);
    setLoading(pending.length > 0); setFailed(new Set());
    // A short delay avoids requests when the user starts typing and immediately clears.
    const timer = window.setTimeout(() => {
      void loadTaxonomy(pending, (report, signal) => readTaxonomyIndex(project, report, signal), controller.signal, (report, index) => {
        if (index) {
          cache.current.set(report.path, { version: report.version, index });
          setIndexes(new Map(cache.current));
        } else setFailed((old) => new Set(old).add(report.path));
      }).then(() => { if (!controller.signal.aborted) setLoading(false); })
        .catch(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [active, reports, project, retry]);

  useEffect(() => { setPage(0); }, [query, rank, project.id]);
  const matches = searchTaxonomy(reports, indexes, query, rank);
  const indexed = reports.filter((r) => r.taxonomyPath && indexes.get(r.path)?.version === r.version).length;
  const missing = reports.filter((r) => !r.taxonomyPath).length;
  const pages = Math.ceil(matches.length / PAGE_SIZE);
  const currentPage = Math.min(page, Math.max(0, pages - 1));
  const sampleCount = new Set(matches.map((m) => m.report.path)).size;

  return <section className="taxonomy-search" aria-label="Sample and taxon search">
    <div className="taxonomy-controls">
      {sampleControls}
      <label className="taxonomy-query">Search taxa across samples
        <input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setExpanded(true); }} placeholder="e.g. Wolbachia or Pseudomonadota" />
      </label>
      <label>Taxonomic rank<select value={rank} onChange={(e) => onRankChange(e.target.value as Rank)} title="Search, bins and assembly plots">{TAXONOMY_RANKS.map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}</select></label>
      {active && <button className="taxonomy-clear" onClick={() => setQuery('')}>Clear</button>}
      {active && <button className="taxonomy-clear" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>{expanded ? 'Hide results' : 'Show results'}</button>}
    </div>
    {active && expanded && <>
      <p className="taxonomy-status" role="status" aria-live="polite">
        <strong>{matches.length.toLocaleString()} matching bins</strong> in {sampleCount} samples · {indexed}/{reports.length} samples indexed{loading ? ' · Loading indexes…' : ''}
        {missing > 0 && <span> · {missing} need republishing to enable search</span>}
        {failed.size > 0 && <span> · {failed.size} could not be loaded <button onClick={() => setRetry((n) => n + 1)}>Retry</button></span>}
      </p>
      {matches.length > 0 ? <>
        <div className="taxonomy-results"><table><thead><tr><th>Sample</th><th>Taxonomic bin</th><th>Matched rank</th><th>Size</th><th>Contigs</th><th>N50</th><th>Completeness %</th><th>Contamination %</th></tr></thead><tbody>
          {matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(({ report, bin }) => <tr key={`${report.path}/${bin.rank}/${bin.bin}`}>
            <td>{report.sample}</td><td><button className="taxon-link" onClick={() => { onSelect(report, { rank: bin.rank, bin: bin.bin, request: ++focusRequest.current }); setExpanded(false); }}>{bin.bin.replace(/_/g, ' ')}<span aria-hidden="true"> ↗</span></button></td>
            <td>{bin.rank}</td><td>{sizeLabel(bin.total_length_bp)}</td><td>{numeric(bin.num_contigs)}</td><td>{sizeLabel(bin.N50)}</td><td>{numeric(bin.completeness_percent, 2)}</td><td>{numeric(bin.contamination_percent, 2)}</td>
          </tr>)}
        </tbody></table></div>
        {pages > 1 && <div className="taxonomy-pagination"><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage + 1} / {pages}</span><button disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</button></div>}
      </> : <p className="taxonomy-empty">{loading ? 'Searching…' : indexed ? 'No matching bins.' : 'Search indexes unavailable. Republish these reports.'}</p>}
    </>}
  </section>;
}
