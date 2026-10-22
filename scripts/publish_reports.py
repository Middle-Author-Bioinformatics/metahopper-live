#!/usr/bin/env python3
"""Publish completed */metahopper_report.html files, without raw pipeline outputs."""
import argparse
import pathlib
import re
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=pathlib.Path, required=True, help='Directory containing sample folders')
    parser.add_argument('--bucket', required=True, help='Actual Amplify-created S3 bucket name')
    parser.add_argument('--prefix', default='reports/phoridae/')
    parser.add_argument('--profile', help='AWS CLI profile configured on TheBelly')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if not args.source.is_dir():
        parser.error('--source must be an existing directory')
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', args.bucket):
        parser.error('--bucket must be an S3 bucket name, without s3://')
    if not args.prefix or args.prefix.startswith('/') or '..' in args.prefix.split('/'):
        parser.error('--prefix must be a nonempty relative S3 prefix')
    if not shutil.which('aws'):
        parser.error('Install AWS CLI v2 and configure a profile first')
    reports = sorted(args.source.glob('*/metahopper_report.html'))
    if not reports:
        parser.error('No */metahopper_report.html files found')
    with tempfile.TemporaryDirectory(prefix='metahopper-publish-') as directory:
        stage = pathlib.Path(directory)
        for report in reports:
            before = report.stat()
            if before.st_size == 0:
                raise SystemExit(f'Empty report: {report}')
            destination = stage / report.parent.name / report.name
            destination.parent.mkdir()
            shutil.copy2(report, destination)
            after = report.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise SystemExit(f'Report changed during copy; retry after pipeline finishes: {report}')
        command = ['aws']
        if args.profile:
            command += ['--profile', args.profile]
        command += ['s3', 'sync', str(stage), f's3://{args.bucket}/{args.prefix.rstrip("/")}/',
                    '--content-type', 'text/html; charset=utf-8', '--cache-control', 'no-store', '--no-progress']
        if args.dry_run:
            command.append('--dryrun')
        print(f'{len(reports)} completed reports selected. No remote objects will be deleted.', flush=True)
        subprocess.run(command, check=True)


if __name__ == '__main__':
    main()
