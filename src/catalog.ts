export interface StorageItem { path: string; eTag?: string; lastModified?: Date; size?: number }
export interface Report extends StorageItem { sample: string; version: string }

export function reportsFromItems(items: StorageItem[], prefix: string): Report[] {
  const found = new Map<string, Report>();
  for (const item of items) {
    if (!item.path.startsWith(prefix)) continue;
    const parts = item.path.slice(prefix.length).split('/');
    if (parts.length !== 2 || !parts[0] || parts[1] !== 'metahopper_report.html' || item.size === 0) continue;
    found.set(item.path, {
      ...item, sample: parts[0],
      version: JSON.stringify([item.eTag ?? '', item.lastModified?.toISOString() ?? '', item.size ?? 0]),
    });
  }
  return [...found.values()].sort((a, b) => a.sample.localeCompare(b.sample, undefined, { numeric: true }));
}

export async function collectPages(
  readPage: (nextToken?: string) => Promise<{ items: StorageItem[]; nextToken?: string }>,
  signal?: AbortSignal,
): Promise<StorageItem[]> {
  const all: StorageItem[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await readPage(token);
    signal?.throwIfAborted();
    all.push(...page.items);
    token = page.nextToken;
    if (token && seen.has(token)) throw new Error('Repeated page token');
    if (token) seen.add(token);
  } while (token);
  return all;
}
