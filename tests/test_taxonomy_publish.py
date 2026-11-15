import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('publish_taxonomy', Path(__file__).parents[1] / 'scripts/publish_reports.py')
publish = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publish)


def summary():
    return dict(schema='metahopper-taxonomy-1', sample='Sample', stage='final', bins=[
        dict(rank='genus', bin='Wolbachia', total_length_bp=1500000, completeness_percent=0),
        dict(rank='genus', bin='unclassified_Viruses', total_length_bp=1000),
        dict(rank='genus', bin='Unclassified', total_length_bp=2000)])


class TaxonomyPublishTests(unittest.TestCase):
    def test_compact_summary_has_real_metrics_domain_buckets_and_no_generic_unbinned_row(self):
        data = summary()
        html = '<script id="metahopper-taxonomy-data" type="application/json">' + json.dumps(data) + '</script>'
        index = publish.taxonomy_index(html, 'Sample', 'final')
        self.assertEqual([r['bin'] for r in index['bins']], ['Wolbachia', 'unclassified_Viruses'])
        self.assertEqual(index['bins'][0]['completeness_percent'], 0)
        self.assertIsNone(index['bins'][0]['contamination_percent'])
        with self.assertRaisesRegex(ValueError, 'different sample'):
            publish.taxonomy_index(html, 'Other', 'final')
        self.assertIsNone(publish.taxonomy_index('<html>old report</html>', 'Sample', 'final'))

    def test_index_uses_the_upload_response_etag_without_requiring_read_permission(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'Sample'; destination.mkdir()
            report = destination / 'metahopper_report.html'; report.write_text('current report')
            checksum = hashlib.sha256(report.read_bytes()).hexdigest()
            (destination / 'taxonomy_index.json').write_text(json.dumps(summary()))
            calls = []
            def command(args, **kwargs):
                calls.append(args)
                return subprocess.CompletedProcess(args, 0, stdout=json.dumps(dict(ETag='"' + 'a' * 32 + '-3"')))
            with patch.object(publish.subprocess, 'run', side_effect=command):
                publish.publish_report(destination, ['aws', '--profile', 'test'], 'sample-bucket', 'reports/aphrophora/')
            self.assertEqual(len(calls), 2)
            self.assertIn('put-object', calls[0])
            self.assertEqual(calls[0][calls[0].index('--output') + 1], 'json')
            self.assertIn('--no-cli-pager', calls[0])
            self.assertFalse(any('head-object' in cmd or 'get-object' in cmd for cmd in calls))
            self.assertIn('s3://sample-bucket/reports/aphrophora/Sample/taxonomy/' + 'a' * 32 + '-3.json', calls[1])
            self.assertIn('metahopper-sha256=' + checksum, calls[0])
            data = json.loads((destination / 'taxonomy_index.json').read_text())
            self.assertEqual(data['report']['etag'], 'a' * 32 + '-3')
            self.assertEqual(data['report']['sha256'], checksum)

    def test_an_unconfirmed_upload_cannot_publish_a_taxonomy_index(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'Sample'; destination.mkdir()
            (destination / 'metahopper_report.html').write_text('report')
            (destination / 'taxonomy_index.json').write_text(json.dumps(summary()))
            calls = []
            def command(args, **kwargs):
                calls.append(args)
                return subprocess.CompletedProcess(args, 0, stdout='{}')
            with patch.object(publish.subprocess, 'run', side_effect=command):
                with self.assertRaisesRegex(ValueError, 'no usable ETag'):
                    publish.publish_report(destination, ['aws'], 'sample-bucket', 'reports/phoridae/')
            self.assertEqual(len(calls), 1)

    def test_dry_run_does_not_try_to_read_metadata_of_an_unuploaded_report(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'Sample'; destination.mkdir()
            (destination / 'metahopper_report.html').write_text('report')
            (destination / 'taxonomy_index.json').write_text(json.dumps(summary()))
            with patch.object(publish.subprocess, 'run') as command:
                publish.publish_report(destination, ['aws'], 'sample-bucket', 'reports/phoridae/', dry_run=True)
            self.assertEqual(command.call_count, 1)
            self.assertIn('--dryrun', command.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
