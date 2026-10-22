import { getUrl, list } from 'aws-amplify/storage';
import { PROJECT } from '../project';
import { collectPages, reportsFromItems, type Report } from './catalog';

export async function discoverReports(signal?: AbortSignal): Promise<Report[]> {
  const items = await collectPages((nextToken) => list({
    path: PROJECT.prefix,
    options: { pageSize: 1000, ...(nextToken ? { nextToken } : {}) },
  }), signal);
  return reportsFromItems(items, PROJECT.prefix);
}

export async function readReport(path: string, signal: AbortSignal): Promise<string> {
  // The signed URL stays in the parent and is never passed into the report frame.
  const { url } = await getUrl({ path, options: { expiresIn: 120 } });
  signal.throwIfAborted();
  const response = await fetch(url, { signal, cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error(`Report request failed (${response.status})`);
  return response.text();
}
