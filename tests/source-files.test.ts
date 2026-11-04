import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the frontend entry point and all relative source imports are present', () => {
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  const entry = html.match(/<script\b[^>]*\bsrc=["']([^"']+)["']/)?.[1];
  assert.ok(entry, 'index.html must name the frontend entry point');
  assert.ok(existsSync(resolve(root, entry.replace(/^\//, ''))), `Missing frontend entry point: ${entry}`);
  const source = resolve(root, 'src');
  for (const name of readdirSync(source).filter((name) => /\.[cm]?[jt]sx?$/.test(name))) {
    const file = resolve(source, name);
    for (const match of readFileSync(file, 'utf8').matchAll(/\b(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
      const imported = resolve(dirname(file), match[1]);
      // Amplify writes this deployment-specific file before the frontend build.
      // It must never be replaced by an example configuration in an update ZIP.
      if (imported === resolve(root, 'amplify_outputs.json')) continue;
      const candidates = [imported, ...['.ts', '.tsx', '.js', '.jsx', '.css', '.json', '/index.ts', '/index.tsx'].map((suffix) => imported + suffix)];
      assert.ok(candidates.some(existsSync), `${name} imports missing local module ${match[1]}`);
    }
  }
});
