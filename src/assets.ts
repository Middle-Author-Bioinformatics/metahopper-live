export interface AssetFile { key: string; sha256: string; size: number }
export interface AssetManifest { schema: 'metahopper-assets-1'; sample: string; bucket: string; prefix: string; files: Record<string, AssetFile> }

export function assetManifest(html: string): AssetManifest | null {
  const match = html.match(/<script\b[^>]*\bid=["']metahopper-assets["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  const value = JSON.parse(match[1]);
  if (value?.schema !== 'metahopper-assets-1' || !value.files || typeof value.files !== 'object') throw new Error('Invalid report asset manifest');
  return value as AssetManifest;
}

export function resolveAsset(manifest: AssetManifest | null, reportPath: string, logical: string): AssetFile {
  if (!manifest || typeof logical !== 'string' || logical.length > 1000 || /[\\%?#\x00-\x1f]/.test(logical)
      || logical.split('/').some((part) => !part || part === '.' || part === '..')
      || !/\.(?:json|fasta|fa|fna|gfa(?:\.gz)?|fastg(?:\.gz)?|faa|ffn|gff3|gbff|embl|txt|tsv)$/.test(logical)) throw new Error('Unsupported report asset');
  if (!reportPath.endsWith('/metahopper_report.html') || /[\\%?#\x00-\x1f]/.test(reportPath)
      || reportPath.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid report path');
  const prefix = reportPath.slice(0, -'metahopper_report.html'.length);
  if (manifest.prefix !== prefix || manifest.sample !== prefix.slice(0, -1).split('/').pop()) throw new Error('Asset manifest belongs to a different sample');
  const entry = manifest.files[logical];
  if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.key !== `${prefix}assets/${entry.sha256}/${logical}`
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 512 * 1024 * 1024) throw new Error('Asset is outside this sample or exceeds 512 MB');
  return entry;
}

export async function verifyAsset(buffer: ArrayBuffer, expected: AssetFile): Promise<void> {
  if (buffer.byteLength !== expected.size) throw new Error('Published asset size does not match this report');
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const hex = Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('');
  if (hex !== expected.sha256) throw new Error('Published asset checksum does not match this report');
}
