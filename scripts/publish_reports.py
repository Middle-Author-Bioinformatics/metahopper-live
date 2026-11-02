#!/usr/bin/env python3
"""Publish sample reports and immutable graph/FASTA assets to private project S3."""
import argparse
import contextlib
import gzip
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

# This is the viewer's in-memory limit, not an upload or download size limit.
MAX_BUFFERED_ASSET_BYTES = 512 * 1024 * 1024


def embed_manifest(html, manifest):
    html = re.sub(r'<script\b[^>]*\bid=["\']metahopper-assets["\'][^>]*>[\s\S]*?</script>', '', html, flags=re.I)
    payload = json.dumps(manifest, separators=(',', ':')).replace('<', '\\u003c').replace('&', '\\u0026')
    tag = f'<script id="metahopper-assets" type="application/json">{payload}</script>'
    if not re.search(r'</head>', html, re.I):
        raise ValueError('Report has no HTML head')
    return re.sub(r'</head>', lambda _: tag + '</head>', html, count=1, flags=re.I)


def stage_asset(source, root, logical, assets, sample_prefix, compress=False):
    resolved = source.resolve(strict=True)
    if not resolved.is_relative_to(root.resolve()):
        raise ValueError(f'Asset points outside this run: {source}')
    if any(part in ('', '.', '..') for part in logical.split('/')) or re.search(r'[\\%?#\x00-\x1f]', logical):
        raise ValueError(f'Invalid asset path: {logical}')
    before = resolved.stat()
    if compress and not logical.endswith(('.gfa.gz', '.fastg.gz')):
        raise ValueError('Only source graph downloads can be gzip-compressed')
    digest = hashlib.sha256()
    with tempfile.NamedTemporaryFile(dir=assets, delete=False) as handle:
        temporary = pathlib.Path(handle.name)
        stream = gzip.GzipFile(filename='', mode='wb', fileobj=handle, compresslevel=1, mtime=0) if compress else contextlib.nullcontext(handle)
        with stream as output, resolved.open('rb') as inp:
            for chunk in iter(lambda: inp.read(8 * 1024 * 1024), b''):
                if not compress:
                    digest.update(chunk)
                output.write(chunk)
    after = resolved.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        temporary.unlink()
        raise ValueError(f'Asset changed during publication; retry after the pipeline finishes: {source}')
    size = temporary.stat().st_size
    if compress:
        with temporary.open('rb') as handle:
            for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b''):
                digest.update(chunk)
    checksum = digest.hexdigest()
    destination = assets / checksum / logical
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary.replace(destination)
    entry = dict(key=sample_prefix + 'assets/' + checksum + '/' + logical, sha256=checksum, size=size)
    if size > MAX_BUFFERED_ASSET_BYTES:
        # The authenticated parent viewer starts a native browser download. It
        # never buffers this file or transfers it into the report iframe.
        entry['downloadOnly'] = True
    return entry


@contextlib.contextmanager
def idle_sample(root):
    lock = root / 'pipeline.lock'
    if not lock.is_file():
        yield
        return
    import fcntl
    with lock.open('rb') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError(f'Pipeline is still running for {root.name}; publish after it finishes') from exc
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def prepare_sample(report, stage, bucket, prefix, pipeline_dir, max_nodes=4000000, skip_refresh=False, max_links=10000000):
    with idle_sample(report.parent.resolve()):
        return _prepare_sample(report, stage, bucket, prefix, pipeline_dir, max_nodes, skip_refresh, max_links)


def _prepare_sample(report, stage, bucket, prefix, pipeline_dir, max_nodes=4000000, skip_refresh=False, max_links=10000000):
    root = report.parent.resolve()
    sample = report.parent.name
    sample_prefix = prefix.rstrip('/') + '/' + sample + '/'
    destination = stage / sample
    destination.mkdir(parents=True)
    assets = destination / 'assets'
    assets.mkdir()
    if not skip_refresh:
        graph_script, report_script = pipeline_dir / 'metahopper_graph.py', pipeline_dir / 'metahopper_report.py'
        if not graph_script.is_file() or not report_script.is_file():
            raise ValueError('Pass --pipeline-dir pointing at the updated MetaHopper repository')
        graph_command = [sys.executable, str(graph_script), '-i', str(root), '--max-nodes', str(max_nodes)]
        if (root / 'megahit/final.contigs.fa').is_file() and not (root / 'megahit/assembly.gfa').is_file():
            graph_command += ['--export-megahit-graph', '--megahit-max-links', str(max_links)]
        elif (root / 'megahit/assembly.gfa').is_file():
            print(f'{sample}: using existing MEGAHIT GFA; refreshing the display catalogue (source limit {max_nodes:,} segments)', flush=True)
        subprocess.run(graph_command, check=True)
        subprocess.run([sys.executable, str(report_script), '-i', str(root), '-o', str(destination / report.name),
                        '--graph-max-nodes', str(max_nodes)], check=True)
    else:
        shutil.copy2(report, destination / report.name)
    html = (destination / report.name).read_text()
    match = re.search(r'var DATA = (.*?);\s*/\*', html, re.S)
    if not match:
        raise ValueError(f'Unrecognized report data: {report}')
    payload = json.loads(match[1])
    if payload.get('runName') != root.name:
        raise ValueError(f'Report sample does not match its run directory: {report}')
    stage_name = payload.get('assemblyGraphs', {}).get('stage', 'final')
    base = root / 'final' if stage_name == 'final' else root
    catalog = root / f'assembly_graphs.{stage_name}.json'
    if not catalog.is_file():
        raise ValueError(f'Missing graph catalogue: {catalog}. Generate it with metahopper_graph.py first.')
    graph_data = json.loads(catalog.read_text())
    if graph_data.get('run_name') != root.name or graph_data.get('stage') != stage_name:
        raise ValueError('Graph catalogue belongs to a different run or bin set')
    limit_errors = [warning for warning in graph_data.get('warnings', []) if 'Graph exceeds ' in warning]
    if limit_errors:
        raise ValueError('Graph catalogue import failed: ' + '; '.join(limit_errors)
                         + '. Increase --graph-max-nodes and retry. No files were uploaded.')
    fasta = next((p for p in [base / 'assembly/consolidated_contigs.fasta',
                              root / 'assembly/preliminary_contigs.fasta', root / 'megahit/final.contigs.fa'] if p.is_file()), None)
    if fasta is None:
        raise ValueError(f'No matching assembly FASTA in {root}')
    sources = {catalog.relative_to(root).as_posix(): catalog, fasta.relative_to(root).as_posix(): fasta}
    for path in (base / 'bins').glob('*/*.fasta'):
        sources[path.relative_to(root).as_posix()] = path
    for item in graph_data.get('graphs', []):
        relative = pathlib.PurePosixPath(item.get('id', ''))
        if not relative.is_absolute() and '..' not in relative.parts and relative.name.endswith(('.gfa', '.gfa.gz')):
            path = root / relative
            if path.is_file():
                sources[relative.as_posix()] = path
    # Retain existing candidate graph files as downloads, even when the report
    # correctly maps final contigs to a different accepted source assembly.
    for directory in (root / 'megahit', root / 'assembly'):
        for pattern in ('*.gfa', '*.gfa.gz', '*.fastg', '*.fastg.gz'):
            for path in directory.glob(pattern):
                sources[path.relative_to(root).as_posix()] = path
    for pattern in ('*/*/*.gfa', '*/*/*.gfa.gz', '*/*/*.fastg', '*/*/*.fastg.gz'):
        for path in (root / 'reassembly').glob(pattern):
            sources[path.relative_to(root).as_posix()] = path
    for record_path in (base / 'annotation').glob('*/*/result.json'):
        record = json.loads(record_path.read_text())
        rank, name = record_path.parent.parent.name, record_path.parent.name
        bin_fasta = base / 'bins' / rank / (name + '.fasta')
        if record.get('status') != 'completed' or not bin_fasta.is_file():
            continue
        if not bin_fasta.resolve().is_relative_to(root):
            raise ValueError(f'Annotation bin points outside this run: {bin_fasta}')
        digest = hashlib.sha256()
        with bin_fasta.open('rb') as handle:
            for block in iter(lambda: handle.read(8 * 1024 * 1024), b''):
                digest.update(block)
        if record.get('signature', {}).get('input_sha256') != digest.hexdigest():
            continue
        for filename in ('features.tsv', 'modules.json', 'result.json'):
            path = record_path.parent / filename
            if path.is_file():
                sources[path.relative_to(root).as_posix()] = path
        for path in (record_path.parent / 'bakta').glob('annotation.*'):
            if path.suffix in ('.faa', '.ffn', '.fna', '.gff3', '.gbff', '.json', '.tsv', '.embl', '.txt'):
                sources[path.relative_to(root).as_posix()] = path
    manifest = dict(schema='metahopper-assets-1', sample=sample, bucket=bucket, prefix=sample_prefix,
                    fasta=fasta.relative_to(root).as_posix(), files={})
    for logical, source in sorted(sources.items()):
        compress = logical.endswith(('.gfa', '.fastg')) and source.stat().st_size > MAX_BUFFERED_ASSET_BYTES
        published_logical = '_compressed/' + logical + '.gz' if compress else logical
        manifest['files'][published_logical] = stage_asset(source, root, published_logical, assets, sample_prefix, compress=compress)
        if compress:
            print(f'{sample}: full source graph compressed for download: {logical} -> {published_logical}', flush=True)
        if manifest['files'][published_logical].get('downloadOnly'):
            size = manifest['files'][published_logical]['size']
            print(f'{sample}: direct browser download ({size / (1024 * 1024):,.1f} MiB): {published_logical}', flush=True)
    (destination / report.name).write_text(embed_manifest(html, manifest))
    (destination / 'asset_manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    counts = graph_data.get('counts', {})
    print(f'{sample}: {len(sources)} assets; graph mappings {counts.get("matched_contigs", 0):,}; '
          f'unmapped {counts.get("unmatched_contigs", 0):,}; s3://{bucket}/{sample_prefix}', flush=True)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=pathlib.Path, required=True, help='Directory containing sample run folders')
    parser.add_argument('--bucket', required=True)
    parser.add_argument('--prefix', required=True,
                        help='Project folder, e.g. reports/aphrophora/ or reports/sample-reports/')
    parser.add_argument('--sample', action='append', help='Publish only this sample folder; may be repeated')
    parser.add_argument('--pipeline-dir', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[2] / 'MetaHopper')
    parser.add_argument('--graph-max-nodes', type=int, default=4000000,
                        help='Maximum segments per input GFA; large display catalogues retain complete two-link neighbourhoods')
    parser.add_argument('--megahit-max-links', type=int, default=10000000,
                        help='Maximum overlap links during missing MEGAHIT GFA export (default: 10000000)')
    parser.add_argument('--skip-refresh', action='store_true', help='Use already regenerated HTML and graph JSON')
    parser.add_argument('--profile')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if not args.source.is_dir():
        parser.error('--source must be an existing directory')
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', args.bucket):
        parser.error('--bucket must be an S3 bucket name')
    if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]*/?', args.prefix)
            or any(part in ('', '.', '..') for part in args.prefix.rstrip('/').split('/'))):
        parser.error('Invalid S3 prefix')
    if args.graph_max_nodes < 1 or args.megahit_max_links < 1:
        parser.error('Graph node and link limits must be positive')
    if not shutil.which('aws'):
        parser.error('AWS CLI v2 must be installed and configured')
    reports = sorted(args.source.glob('*/metahopper_report.html'))
    if args.sample:
        reports = [p for p in reports if p.parent.name in set(args.sample)]
        missing = set(args.sample) - {p.parent.name for p in reports}
        if missing:
            parser.error('No completed report for: ' + ', '.join(sorted(missing)))
    if not reports:
        parser.error('No sample reports found')
    with tempfile.TemporaryDirectory(prefix='metahopper-publish-') as directory:
        stage = pathlib.Path(directory)
        for report in reports:
            if not report.stat().st_size:
                raise SystemExit(f'Empty report: {report}')
            prepare_sample(report, stage, args.bucket, args.prefix, args.pipeline_dir.resolve(), args.graph_max_nodes, args.skip_refresh, args.megahit_max_links)
        command = ['aws'] + (['--profile', args.profile] if args.profile else [])
        target = f's3://{args.bucket}/{args.prefix.rstrip("/")}/'
        # Immutable assets first; HTML is published only after all assets succeed.
        commands = [command + ['s3', 'sync', str(stage), target, '--exclude', '*.html', '--cache-control', 'no-store', '--no-progress'],
                    command + ['s3', 'sync', str(stage), target, '--exclude', '*', '--include', '*/metahopper_report.html',
                               '--content-type', 'text/html; charset=utf-8', '--cache-control', 'no-store', '--no-progress']]
        print(f'{len(reports)} reports staged. Existing S3 objects will not be deleted.', flush=True)
        for cmd in commands:
            if args.dry_run:
                cmd.append('--dryrun')
            subprocess.run(cmd, check=True)


if __name__ == '__main__':
    main()

