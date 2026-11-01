import { getUrl, list } from 'aws-amplify/storage';
<<<<<<< HEAD
import { PROJECTS, type Project } from '../project';
=======
import type { Project } from '../project';
>>>>>>> 1538d3470e4f7fa44a6cc3d37a5b5873d9445079
import { collectPages, reportsFromItems, type Report } from './catalog';
import { resolveAsset, verifyAsset, type AssetManifest } from './assets';

export async function discoverReports(project: Project, signal?: AbortSignal): Promise<Report[]> {
  const items = await collectPages((nextToken) => list({
    path: project.prefix,
    options: { pageSize: 1000, ...(nextToken ? { nextToken } : {}) },
  }), signal);
  return reportsFromItems(items, project.prefix);
}

export async function readReport(path: string, signal: AbortSignal): Promise<string> {
  // The signed URL stays in the parent and is never passed into the report frame.
  const { url } = await getUrl({ path, options: { expiresIn: 120 } });
  signal.throwIfAborted();
  const response = await fetch(url, { signal, cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error(`Report request failed (${response.status})`);
  return response.text();
}

export async function readReportAsset(reportPath: string, manifest: AssetManifest | null, logical: string, signal: AbortSignal): Promise<ArrayBuffer> {
  // IAM enforces the signed-in user's group; this bridge further isolates one sample.
  if (!PROJECTS.some((project) => reportPath.startsWith(project.prefix))) throw new Error('Report is outside configured projects');
  const entry = resolveAsset(manifest, reportPath, logical);
  const { url } = await getUrl({ path: entry.key, options: { expiresIn: 300 } });
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

