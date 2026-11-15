import { getProjectUrl, listProject } from './aws-storage';
import { PROJECTS, type Project } from '../project';
import { collectPages, reportsFromItems, taxonomyPath, type Report } from './catalog';
import { MAX_TAXONOMY_BYTES, parseTaxonomy, type TaxonomyIndex } from './taxonomy';
import { resolveAsset, startAssetDownload, verifyAsset, type AssetManifest } from './assets';

export async function discoverReports(project: Project, signal?: AbortSignal): Promise<Report[]> {
  const items = await collectPages((nextToken) => listProject(project, nextToken, signal), signal);
  return reportsFromItems(items, project.prefix);
}

export async function readReport(path: string, signal: AbortSignal): Promise<string> {
  // The signed URL stays in the parent and is never passed into the report frame.
  const { url } = await getProjectUrl({ path, options: { expiresIn: 120 } }, signal);
  signal.throwIfAborted();
  const response = await fetch(url, { signal, cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error(`Report request failed (${response.status})`);
  return response.text();
}

export async function readTaxonomyIndex(project: Project, report: Report, signal: AbortSignal): Promise<TaxonomyIndex> {
  const parts = report.path.startsWith(project.prefix) ? report.path.slice(project.prefix.length).split('/') : [];
  const path = taxonomyPath(report);
  if (parts.length !== 2 || parts[0] !== report.sample || parts[1] !== 'metahopper_report.html'
      || parts.some((p) => !p || p === '.' || p === '..') || /[\\%?#\x00-\x1f]/.test(report.path)
      || !path || report.taxonomyPath !== path) throw new Error('Taxonomy index is outside this report and project');
  signal.throwIfAborted();
  const { url } = await getProjectUrl({ path, options: { expiresIn: 120 } }, signal);
  signal.throwIfAborted();
  const response = await fetch(url, { signal, cache: 'no-store', credentials: 'omit' });
  if (!response.ok || !response.body) throw new Error('Taxonomy index unavailable');
  const length = Number(response.headers.get('content-length') ?? 0);
  const reader = response.body.getReader();
  let bytes = 0, text = '';
  const decoder = new TextDecoder();
  try {
    if (length > MAX_TAXONOMY_BYTES) throw new Error('Taxonomy index exceeds the size limit');
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_TAXONOMY_BYTES) throw new Error('Taxonomy index exceeds the size limit');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    signal.throwIfAborted();
    return parseTaxonomy(JSON.parse(text), report);
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export async function readReportAsset(reportPath: string, manifest: AssetManifest | null, logical: string, signal: AbortSignal): Promise<ArrayBuffer> {
  // IAM enforces the signed-in user's group; this bridge further isolates one sample.
  if (!PROJECTS.some((project) => reportPath.startsWith(project.prefix))) throw new Error('Report is outside configured projects');
  const entry = resolveAsset(manifest, reportPath, logical);
  const { url } = await getProjectUrl({ path: entry.key, options: { expiresIn: 300 } }, signal);
  signal.throwIfAborted();
  const response = await fetch(url, { signal, cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error(`Sample asset unavailable (${response.status})`);
  const length = response.headers.get('content-length');
  if (length && Number(length) !== entry.size) throw new Error('Published asset size changed');
  const buffer = await response.arrayBuffer();
  await verifyAsset(buffer, entry);
  signal.throwIfAborted();
  return buffer;
}

export async function downloadReportAsset(reportPath: string, manifest: AssetManifest | null, logical: string, signal: AbortSignal): Promise<void> {
  if (!PROJECTS.some((project) => reportPath.startsWith(project.prefix))) throw new Error('Report is outside configured projects');
  const entry = resolveAsset(manifest, reportPath, logical, 'download');
  signal.throwIfAborted();
  const { url } = await getProjectUrl({ path: entry.key, options: {
    expiresIn: 3600, validateObjectExistence: true,
    contentDisposition: { type: 'attachment', filename: logical.split('/').pop() ?? 'sample-asset' },
    contentType: 'application/octet-stream',
  } }, signal);
  signal.throwIfAborted();
  startAssetDownload(url, logical);
}
