"""Rename published reports without changing their source runs or sample scope."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('publication_names', Path(__file__).parents[1] / 'scripts/publish_reports.py')
publish = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publish)


class PublicationNamesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.source = Path(self.tmp.name)
        self.reports = []
        for name in ('Sample', 'Sample-2', 'Legacy-v0', 'Other'):
            path = self.source / name / 'metahopper_report.html'
            path.parent.mkdir(); path.write_text('original ' + name)
            self.reports.append(path)
        self.config = self.source / 'report_publication.json'

    def tearDown(self):
        self.tmp.cleanup()

    def names(self, mapping):
        self.config.write_text(json.dumps(dict(schema='metahopper-publication-1', samples=mapping)))
        return publish.publication_targets(self.reports, self.config)

    def test_without_config_all_original_names_are_preserved(self):
        reports = self.reports + [self.source / 'Older sample name' / 'metahopper_report.html']
        self.assertEqual(publish.publication_targets(reports), {p.parent.name: p.parent.name for p in reports})

    def test_explicit_exclusions_make_room_for_the_replacement_name(self):
        self.assertEqual(self.names({'Sample': None, 'Sample-2': 'Sample', 'Legacy-v0': None}),
                         {'Sample-2': 'Sample', 'Other': 'Other'})
        self.assertTrue(all(p.read_text() == 'original ' + p.parent.name for p in self.reports))

    def test_ambiguous_names_and_unsafe_targets_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'collision'):
            self.names({'Sample-2': 'Sample'})
        for name in ('../Other', 'bad/name', '', '.hidden', 'https://example.org', '<script>', True, []):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'Invalid published sample name'):
                self.names({'Sample-2': name})
        with self.assertRaisesRegex(ValueError, 'missing reports'):
            self.names({'Missing': 'New'})

    def test_unsupported_config_and_unknown_options_fail_closed(self):
        for data in ([], {}, {'schema': 'unknown', 'samples': {}},
                     {'schema': 'metahopper-publication-1', 'samples': {}, 'sampls': {}},
                     {'schema': 'metahopper-publication-1', 'samples': []}):
            self.config.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'publication schema'):
                publish.publication_targets(self.reports, self.config)

    def test_renaming_changes_title_and_taxonomy_but_preserves_source_identifiers(self):
        data = dict(schema='metahopper-taxonomy-1', sample='Sample-2', stage='final', bins=[])
        html = '<html><head><title>Old title</title></head><body><header><h1>Old title</h1></header>'
        html += '<script id="metahopper-taxonomy-data" type="application/json">' + json.dumps(data) + '</script>'
        html += '<script>var DATA = {"runName":"Sample-2","assemblyGraphs":{"run_name":"Sample-2"}};</script></body></html>'
        changed = publish.published_title(html, 'Sample')
        self.assertIn('<title>MetaHopper report — Sample</title>', changed)
        self.assertIn('<header><h1>MetaHopper report — Sample</h1></header>', changed)
        taxonomy = json.loads(re.search(r'id="metahopper-taxonomy-data"[^>]*>(.*?)</script>', changed)[1])
        self.assertEqual(taxonomy['sample'], 'Sample')
        self.assertIn('"runName":"Sample-2"', changed)
        self.assertIn('"run_name":"Sample-2"', changed)

    def test_automatic_config_applies_to_bulk_publication_without_deleting_anything(self):
        self.names({'Sample': None, 'Sample-2': 'Sample', 'Legacy-v0': None})
        args = ['publish_reports.py', '--source', str(self.source), '--bucket', 'sample-bucket',
                '--prefix', 'reports/aphrophora/', '--staging-dir', str(self.source / 'staging'), '--skip-refresh']
        prepared, uploaded = [], []
        def prepare(report, stage, *args, published_name=None):
            prepared.append((report.parent.name, published_name or report.parent.name))
            destination = stage / (published_name or report.parent.name)
            destination.mkdir(); (destination / 'metahopper_report.html').write_text('staged')
        with patch('sys.argv', args), patch.object(publish.shutil, 'which', return_value='aws'), \
             patch.object(publish, 'prepare_sample', side_effect=prepare), \
             patch.object(publish, 'publish_report', side_effect=lambda destination, *args: uploaded.append(destination.name)), \
             patch.object(publish.subprocess, 'run') as aws:
            publish.main()
        self.assertEqual(prepared, [('Other', 'Other'), ('Sample-2', 'Sample')])
        self.assertEqual(uploaded, ['Other', 'Sample'])
        self.assertTrue(all('--delete' not in call.args[0] and 'rm' not in call.args[0] for call in aws.call_args_list))
        self.assertTrue(all(p.read_text() == 'original ' + p.parent.name for p in self.reports))

    def test_collision_or_disabled_selection_stops_before_any_staging_or_aws_call(self):
        args = ['publish_reports.py', '--source', str(self.source), '--bucket', 'sample-bucket', '--prefix', 'reports/aphrophora/']
        cases = [({'Sample-2': 'Sample'}, []), ({'Sample': None, 'Sample-2': 'Sample'}, ['--sample', 'Sample'])]
        for mapping, extra in cases:
            self.config.write_text(json.dumps(dict(schema='metahopper-publication-1', samples=mapping)))
            with patch('sys.argv', args + extra), patch.object(publish.shutil, 'which', return_value='aws'), \
                 patch.object(publish, 'prepare_sample') as prepare, patch.object(publish.subprocess, 'run') as aws, \
                 contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                publish.main()
            prepare.assert_not_called(); aws.assert_not_called()


if __name__ == '__main__':
    unittest.main()
