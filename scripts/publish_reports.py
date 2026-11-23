#!/usr/bin/env python3
"""Publish sample reports and immutable graph/FASTA assets to private project S3."""
import argparse
import contextlib
from collections import Counter
import errno
import gzip
import hashlib
from html import escape
import json
import math
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

# This is the viewer's in-memory limit, not an upload or download size limit.
MAX_BUFFERED_ASSET_BYTES = 512 * 1024 * 1024


def sample_name(value):
    if (not isinstance(value, str) or len(value) > 200
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', value)):
        raise ValueError('Invalid published sample name: ' + repr(value))
    return value


def publication_targets(reports, config=None):
    """Resolve labels/exclusions before any upload; preserve source run folders."""
    names = {}
    if config is not None:
        data = json.loads(config.read_text())
        if (not isinstance(data, dict) or data.get('schema') != 'metahopper-publication-1'
                or set(data) != {'schema', 'samples'} or not isinstance(data['samples'], dict)):
            raise ValueError('Expected publication schema metahopper-publication-1 and a samples object')
        names = data['samples']
        for source, target in names.items():
            sample_name(source)
            if target is not None:
                sample_name(target)
        missing = {source for source, target in names.items() if target is not None} - {p.parent.name for p in reports}
        if missing:
            raise ValueError('Publication names refer to missing reports: ' + ', '.join(sorted(missing)))
    targets, owners = {}, {}
    for report in reports:
        source = report.parent.name
        target = names.get(source, source)
        if target is None:
            continue
        if target in owners:
            raise ValueError(f'Publication name collision: {owners[target]} and {source} both publish as {target}. '
                             'Explicitly exclude the older source with null in the publication config.')
        owners[target] = source
        targets[source] = target
    return targets


def published_title(html, name):
    """Change the displayed/published identity; internal run IDs stay provenance.

    Source run names are retained in DATA and graph/pathway records so graph
    ownership checks and scientific identifiers remain consistent.
    """
    title = escape('MetaHopper report — ' + sample_name(name))
    html, titles = re.subn(r'(<title\b[^>]*>)[\s\S]*?(</title>)',
                          lambda m: m[1] + title + m[2], html, count=1, flags=re.I)
    html, headings = re.subn(r'(<header\b[^>]*>\s*<h1\b[^>]*>)[\s\S]*?(</h1>)',
                            lambda m: m[1] + title + m[2], html, count=1, flags=re.I)
    if titles != 1 or headings != 1:
        raise ValueError('Cannot rename an unrecognized report title/header; regenerate the report first')
    def taxonomy(match):
        data = json.loads(match[2])
        data['sample'] = name
        payload = json.dumps(data, separators=(',', ':'), allow_nan=False).replace('<', '\\u003c').replace('&', '\\u0026')
        return match[1] + payload + match[3]
    return re.sub(r'(<script\b[^>]*\bid=["\']metahopper-taxonomy-data["\'][^>]*>)([\s\S]*?)(</script>)',
                  taxonomy, html, count=1, flags=re.I)


def staging_directory(value):
    if not value.strip():
        raise argparse.ArgumentTypeError('staging directory cannot be empty; set the shell variable, '
                                         'provide a directory path, or omit --staging-dir')
    return pathlib.Path(value)


def taxonomy_index(html, sample, stage):
    """Extract the generator's compact table data; never scrape rendered cells."""
    match = re.search(r'<script\b[^>]*\bid=["\']metahopper-taxonomy-data["\'][^>]*>([\s\S]*?)</script>', html, re.I)
    if not match:
        return None  # Older HTML remains publishable; the app shows its missing index.
    data = json.loads(match[1])
    if data.get('schema') != 'metahopper-taxonomy-1' or data.get('sample') != sample or data.get('stage') != stage:
        raise ValueError('Taxonomy summary belongs to a different sample or bin set')
    ranks = {'phylum', 'class', 'order', 'family', 'genus', 'species'}
    fields = ('total_length_bp', 'num_contigs', 'N50', 'GC_percent', 'completeness_percent',
              'contamination_percent', 'strain_heterogeneity_percent')
    bins, seen = [], set()
    for row in data['bins']:
        name, rank = row.get('bin'), row.get('rank')
        if not isinstance(name, str) or not name.strip() or len(name) > 1000 or rank not in ranks:
            raise ValueError('Invalid taxonomy bin name or rank')
        if name.strip().casefold() in {'unclassified', 'unbinned', 'unassigned'}:
            continue
        if (rank, name) in seen:
            raise ValueError('Duplicate taxonomy bin')
        seen.add((rank, name))
        entry = dict(bin=name, rank=rank)
        for field in fields:
            value = row.get(field)
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0):
                raise ValueError('Invalid taxonomy metric: ' + field)
            entry[field] = value
        bins.append(entry)
    return dict(schema=data['schema'], sample=sample, stage=stage, bins=bins)


def publish_report(destination, command, bucket, prefix, dry_run=False):
    """Bind the search index to the exact S3 report ETag, including multipart tags.

    Assets precede HTML, then the matching index is published last. An interrupted
    or concurrent update cannot associate an old index with a different report.
    """
    report = destination / 'metahopper_report.html'
    body = report.read_bytes()
    checksum = hashlib.sha256(body).hexdigest()
    key = prefix.rstrip('/') + '/' + destination.name + '/metahopper_report.html'
    manifest = destination / 'asset_manifest.json'
    if manifest.is_file():
        subprocess.run(command + ['s3', 'cp', str(manifest), f's3://{bucket}/{key.rsplit("/", 1)[0]}/asset_manifest.json',
                                  '--content-type', 'application/json', '--cache-control', 'no-store', '--no-progress']
                       + (['--dryrun'] if dry_run else []), check=True)
    if dry_run:
        subprocess.run(command + ['s3', 'cp', str(report), f's3://{bucket}/{key}', '--dryrun'], check=True)
        response = None
    else:
        # PutObject returns this upload's ETag directly. No GetObject/HeadObject
        # permission is needed by the existing write-only publishing principal.
        # AWS_PAGER disables v2 paging without a CLI argument rejected by v1.
        response = subprocess.run(command + ['s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', str(report),
                          '--content-type', 'text/html; charset=utf-8', '--metadata', 'metahopper-sha256=' + checksum,
                          '--cache-control', 'no-store', '--output', 'json'],
                          check=True, text=True, stdout=subprocess.PIPE,
                          env=dict(os.environ, AWS_PAGER=''))
    path = destination / 'taxonomy_index.json'
    if not path.is_file():
        print(destination.name + ': no taxonomy index; refresh this report with the updated generator to enable project search.', flush=True)
        return
    if dry_run:
        print(destination.name + ': would publish the taxonomy index using the report upload ETag.', flush=True)
        return
    etag = str(json.loads(response.stdout).get('ETag', '')).strip('"').lower()
    if not re.fullmatch(r'[0-9a-f]{32}(?:-[1-9][0-9]*)?', etag):
        raise ValueError('Report upload returned no usable ETag; its taxonomy index was not published. Retry publication.')
    index = json.loads(path.read_text())
    index['report'] = dict(etag=etag, sha256=checksum, size=len(body))
    path.write_text(json.dumps(index, separators=(',', ':'), allow_nan=False) + '\n')
    index_key = key.rsplit('/', 1)[0] + '/taxonomy/' + etag + '.json'
    subprocess.run(command + ['s3', 'cp', str(path), f's3://{bucket}/{index_key}', '--content-type', 'application/json',
                              '--cache-control', 'no-store', '--no-progress'], check=True)
    print(destination.name + ': project taxonomy search index published.', flush=True)


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
    temporary = None
    try:
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
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    entry = dict(key=sample_prefix + 'assets/' + checksum + '/' + logical, sha256=checksum, size=size)
    if size > MAX_BUFFERED_ASSET_BYTES:
        # The authenticated parent viewer starts a native browser download. It
        # never buffers this file or transfers it into the report iframe.
        entry['downloadOnly'] = True
    return entry


def pathway_sources(html, root, stage):
    """Only publish the exact sample-scoped files used by the embedded explorer."""
    match = re.search(r'<script\b[^>]*\bid=["\']metahopper-pathways-data["\'][^>]*>([\s\S]*?)</script>', html, re.I)
    if not match:
        return {}, {}
    data = json.loads(match[1])
    if data.get('schema') != 'metahopper-pathways-1' or data.get('run_name') != root.name or data.get('stage') != stage:
        raise ValueError('Pathway explorer belongs to a different sample or bin set')
    if data.get('preview'):
        raise ValueError('Pathway preview inputs are unverified; regenerate the report from this sample before publishing')
    def relative(value):
        path = pathlib.PurePosixPath(value)
        if not value or path.is_absolute() or any(p in ('', '.', '..') for p in value.split('/')) or re.search(r'[\\%?#\x00-\x1f]', value):
            raise ValueError('Invalid pathway asset path: ' + value)
        source = root / path
        if not source.resolve(strict=True).is_relative_to(root):
            raise ValueError('Pathway asset points outside this sample')
        return path, source
    directory, folder = relative(data.get('directory', ''))
    if (folder / '.pathwaygenie.lock').exists():
        raise ValueError('PathwayGenie is still running; publish after it finishes')
    lock = folder.parent / ('.' + folder.name + '.metahopper-pathways.lock')
    if lock.is_file():
        import fcntl
        with lock.open() as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise ValueError('A pathway run/import is active; publish after it finishes') from exc
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)
    for item in data.get('inputs', []):
        _, source = relative(item['path'])
        digest = hashlib.sha256()
        with source.open('rb') as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b''):
                digest.update(block)
        if digest.hexdigest() != item.get('sha256'):
            raise ValueError('Pathway input bin changed after report generation; regenerate the HTML before publishing')
    sources, expected = {}, {}
    for item in data.get('files', []):
        path, source = relative(item['path'])
        if not path.is_relative_to(directory) or source.is_dir():
            raise ValueError('Pathway download is outside its declared results folder')
        if not re.fullmatch(r'[0-9a-f]{64}', str(item.get('sha256', ''))) or not isinstance(item.get('size'), int):
            raise ValueError('Invalid pathway asset checksum/size')
        if item['path'] in sources:
            raise ValueError('Duplicate pathway asset in the report')
        sources[item['path']] = source
        expected[item['path']] = dict(sha256=item['sha256'], size=item['size'])
    return sources, expected


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


def prepare_sample(report, stage, bucket, prefix, pipeline_dir, max_nodes=4000000, skip_refresh=False, max_links=10000000, pathways_rank='genus', pathways_dir=None, *, published_name=None):
    with idle_sample(report.parent.resolve()):
        return _prepare_sample(report, stage, bucket, prefix, pipeline_dir, max_nodes, skip_refresh, max_links, pathways_rank, pathways_dir, published_name=published_name)


def _prepare_sample(report, stage, bucket, prefix, pipeline_dir, max_nodes=4000000, skip_refresh=False, max_links=10000000, pathways_rank='genus', pathways_dir=None, *, published_name=None):
    root = report.parent.resolve()
    source_name = report.parent.name
    sample = sample_name(published_name) if published_name is not None else source_name
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
        report_command = [sys.executable, str(report_script), '-i', str(root), '-o', str(destination / report.name),
                          '--graph-max-nodes', str(max_nodes), '--pathways-rank', pathways_rank]
        if pathways_dir is not None:
            report_command += ['--pathways-dir', str(pathways_dir)]
        subprocess.run(report_command, check=True)
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
                         + '. Increase --graph-max-nodes and retry. No files for this sample were uploaded.')
    if not graph_data.get('graphs'):
        reasons = Counter(graph_data.get('unmapped', {}).values())
        detail = ', '.join(f'{reason}={count:,}' for reason, count in reasons.most_common())
        print(f'WARNING: {sample}: no usable assembly graphs were imported. '
              f'FASTA/annotation publishing can continue, but assembly graphs cannot be displayed. '
              f'Inspect {catalog}' + (f' ({detail})' if detail else ''), flush=True)
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
    pathway_files, pathway_expected = pathway_sources(html, root, stage_name)
    sources.update(pathway_files)
    manifest = dict(schema='metahopper-assets-1', sample=sample, bucket=bucket, prefix=sample_prefix,
                    fasta=fasta.relative_to(root).as_posix(), files={})
    for logical, source in sorted(sources.items()):
        compress = logical.endswith(('.gfa', '.fastg')) and source.stat().st_size > MAX_BUFFERED_ASSET_BYTES
        published_logical = '_compressed/' + logical + '.gz' if compress else logical
        manifest['files'][published_logical] = stage_asset(source, root, published_logical, assets, sample_prefix, compress=compress)
        expected = pathway_expected.get(logical)
        if expected and any(manifest['files'][published_logical][key] != value for key, value in expected.items()):
            raise ValueError('Pathway outputs changed after report generation: ' + logical + '. Regenerate before publishing; no files for this sample were uploaded.')
        if compress:
            print(f'{sample}: full source graph compressed for download: {logical} -> {published_logical}', flush=True)
        if manifest['files'][published_logical].get('downloadOnly'):
            size = manifest['files'][published_logical]['size']
            print(f'{sample}: direct browser download ({size / (1024 * 1024):,.1f} MiB): {published_logical}', flush=True)
    # Validate source ownership before changing any published label.
    index = taxonomy_index(html, source_name, stage_name)
    if sample != source_name:
        html = published_title(html, sample)
        if index is not None:
            index['sample'] = sample
    (destination / report.name).write_text(embed_manifest(html, manifest))
    if index is not None:
        (destination / 'taxonomy_index.json').write_text(json.dumps(index, separators=(',', ':'), allow_nan=False) + '\n')
    (destination / 'asset_manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    counts = graph_data.get('counts', {})
    print(f'{sample}: staged {len(sources)} assets; graph mappings {counts.get("matched_contigs", 0):,}; '
          f'unmapped {counts.get("unmatched_contigs", 0):,}; target s3://{bucket}/{sample_prefix}', flush=True)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=pathlib.Path, required=True, help='Directory containing sample run folders')
    parser.add_argument('--bucket', required=True)
    parser.add_argument('--prefix', required=True,
                        help='Project folder, e.g. reports/aphrophora/ or reports/sample-reports/')
    parser.add_argument('--sample', action='append', help='Publish only this sample folder; may be repeated')
    parser.add_argument('--publication-config', type=pathlib.Path,
                        help='Published names/exclusions; defaults to SOURCE/report_publication.json when present')
    parser.add_argument('--pipeline-dir', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[2] / 'MetaHopper')
    parser.add_argument('--graph-max-nodes', type=int, default=4000000,
                        help='Maximum segments per input GFA; large display catalogues retain complete two-link neighbourhoods')
    parser.add_argument('--megahit-max-links', type=int, default=10000000,
                        help='Maximum overlap links during missing MEGAHIT GFA export (default: 10000000)')
    parser.add_argument('--skip-refresh', action='store_true', help='Use already regenerated HTML and graph JSON')
    parser.add_argument('--pathways-rank', default='genus', help='Rank annotated by PathwayGenie')
    parser.add_argument('--pathways-dir', type=pathlib.Path, help='Optional sample-relative PathwayGenie results directory')
    parser.add_argument('--profile')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--staging-dir', type=staging_directory,
                        help='Temporary staging parent on a filesystem with free bytes and inodes; '
                             'only one sample is staged at a time (default: TMPDIR or system temporary directory)')
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
        parser.error('AWS CLI (v1 or v2) must be installed and configured')
    reports = sorted(args.source.glob('*/metahopper_report.html'))
    config = args.publication_config
    if config is None and (args.source / 'report_publication.json').is_file():
        config = args.source / 'report_publication.json'
    try:
        names = publication_targets(reports, config)
    except (OSError, ValueError, TypeError) as exc:
        parser.error(str(exc))
    if args.sample:
        disabled = set(args.sample) & ({p.parent.name for p in reports} - set(names))
        if disabled:
            parser.error('Reports excluded by publication config: ' + ', '.join(sorted(disabled)))
        reports = [p for p in reports if p.parent.name in set(args.sample)]
        missing = set(args.sample) - {p.parent.name for p in reports}
        if missing:
            parser.error('No completed report for: ' + ', '.join(sorted(missing)))
    reports = [p for p in reports if p.parent.name in names]
    if not reports:
        parser.error('No sample reports found')
    if any(not report.stat().st_size for report in reports):
        parser.error('An empty report was found; regenerate it before publishing')
    staging_parent = args.staging_dir.expanduser().resolve() if args.staging_dir else pathlib.Path(tempfile.gettempdir())
    command = ['aws'] + (['--profile', args.profile] if args.profile else [])
    target = f's3://{args.bucket}/{args.prefix.rstrip("/")}/'
    completed = 0
    current = None
    try:
        staging_parent.mkdir(parents=True, exist_ok=True)
        print(f'{len(reports)} reports selected; staging one sample at a time in {staging_parent}. '
              'Existing S3 objects will not be deleted.', flush=True)
        for report in reports:
            source_name = report.parent.name
            current = names[source_name]
            if current != source_name:
                print(f'{source_name}: publishing as {current}; source run unchanged.', flush=True)
            with tempfile.TemporaryDirectory(prefix='metahopper-publish-', dir=staging_parent) as directory:
                stage = pathlib.Path(directory)
                renamed = dict(published_name=current) if current != source_name else {}
                prepare_sample(report, stage, args.bucket, args.prefix, args.pipeline_dir.resolve(), args.graph_max_nodes, args.skip_refresh, args.megahit_max_links, args.pathways_rank, args.pathways_dir, **renamed)
                # Assets precede this sample's HTML; a failed staging/upload must
                # never point a new report at absent files. Hash-named assets can
                # use size-only sync despite fresh local staging timestamps.
                assets_command = command + ['s3', 'sync', str(stage), target, '--exclude', '*.html',
                                            '--exclude', '*/taxonomy_index.json', '--exclude', '*/asset_manifest.json',
                                            '--size-only', '--cache-control', 'no-store', '--no-progress']
                subprocess.run(assets_command + (['--dryrun'] if args.dry_run else []), check=True)
                publish_report(stage / current, command, args.bucket, args.prefix, args.dry_run)
            # The temporary directory is removed before preparing the next sample.
            completed += 1
            print(f'{"Dry run complete" if args.dry_run else "Published"} {completed}/{len(reports)}: '
                  f's3://{args.bucket}/{args.prefix.rstrip("/")}/{current}/', flush=True)
    except OSError as exc:
        if exc.errno not in (errno.ENOSPC, errno.EDQUOT):
            raise
        parser.exit(1, f'ERROR: Local staging ran out of disk space, inodes, or quota in {staging_parent}'
                    + (f' while processing {current}' if current else '')
                    + f'. {completed} sample(s) completed earlier in this attempt. '
                      'Check df -h and df -i; rerun with --staging-dir on a filesystem with available capacity. '
                      'Original sample outputs were not deleted.\n')


if __name__ == '__main__':
    main()

