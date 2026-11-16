"""Bound temporary storage without weakening each sample's upload ordering."""
import contextlib
import errno
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('publish_staging', Path(__file__).parents[1] / 'scripts/publish_reports.py')
publish = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publish)


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


class StagingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root / 'samples'
        self.staging = self.root / 'other-disk' / 'staging'
        for name in ('SPH0055', 'SPH0074'):
            write(self.source / name / 'metahopper_report.html', 'saved report')
        self.args = ['publish_reports.py', '--source', str(self.source), '--bucket', 'sample-bucket',
                     '--prefix', 'reports/phoridae/', '--pipeline-dir', str(self.root / 'pipeline'),
                     '--staging-dir', str(self.staging), '--skip-refresh']

    def tearDown(self):
        self.tmp.cleanup()

    def prepare(self, report, stage, *args):
        destination = stage / report.parent.name
        write(destination / 'metahopper_report.html', 'refreshed report')
        write(destination / 'assets/hash/annotation.faa', 'protein snapshot')
        return destination

    def test_stages_uploads_and_removes_one_sample_before_preparing_the_next(self):
        events, stage_paths = [], []
        def prepare(report, stage, *args):
            if stage_paths:
                self.assertFalse(stage_paths[-1].exists(), 'Previous sample still occupies staging space')
            self.assertEqual(stage.parent, self.staging)
            stage_paths.append(stage)
            events.append(('prepare', report.parent.name))
            return self.prepare(report, stage)
        def upload(command, **kwargs):
            self.assertIn('--size-only', command)
            self.assertIn('s3://sample-bucket/reports/phoridae/', command)
            stage = Path(command[3])
            self.assertEqual(len(list(stage.iterdir())), 1)
            events.append(('assets', next(stage.iterdir()).name))
        def report(destination, *args):
            self.assertTrue((destination / 'assets/hash/annotation.faa').is_file())
            events.append(('report', destination.name))
        with patch('sys.argv', self.args), patch.object(publish.shutil, 'which', return_value='aws'), \
             patch.object(publish, 'prepare_sample', side_effect=prepare), \
             patch.object(publish.subprocess, 'run', side_effect=upload), \
             patch.object(publish, 'publish_report', side_effect=report):
            publish.main()
        self.assertEqual(events, [('prepare', 'SPH0055'), ('assets', 'SPH0055'), ('report', 'SPH0055'),
                                  ('prepare', 'SPH0074'), ('assets', 'SPH0074'), ('report', 'SPH0074')])
        self.assertTrue(all(not p.exists() for p in stage_paths))
        self.assertEqual(list(self.staging.iterdir()), [])

    def test_later_disk_failure_preserves_completed_publication_and_cleans_partial_staging(self):
        def prepare(report, stage, *args):
            self.prepare(report, stage)
            if report.parent.name == 'SPH0074':
                raise OSError(errno.ENOSPC, 'No space left on device')
        error = io.StringIO()
        with patch('sys.argv', self.args), patch.object(publish.shutil, 'which', return_value='aws'), \
             patch.object(publish, 'prepare_sample', side_effect=prepare), \
             patch.object(publish.subprocess, 'run') as upload, \
             patch.object(publish, 'publish_report') as report, contextlib.redirect_stderr(error):
            with self.assertRaises(SystemExit) as raised:
                publish.main()
        self.assertEqual(raised.exception.code, 1)
        self.assertIn('1 sample(s) completed earlier', error.getvalue())
        self.assertIn('SPH0074', error.getvalue())
        self.assertIn('--staging-dir', error.getvalue())
        self.assertIn('df -i', error.getvalue())
        self.assertEqual(upload.call_count, 1)
        self.assertEqual(report.call_count, 1)
        self.assertEqual(report.call_args.args[0].name, 'SPH0055')
        self.assertEqual(list(self.staging.iterdir()), [])
        self.assertTrue(all(p.read_text() == 'saved report' for p in self.source.glob('*/metahopper_report.html')))

    def test_failed_asset_upload_does_not_publish_html_or_start_the_next_sample(self):
        with patch('sys.argv', self.args), patch.object(publish.shutil, 'which', return_value='aws'), \
             patch.object(publish, 'prepare_sample', side_effect=self.prepare) as prepare, \
             patch.object(publish.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'aws')), \
             patch.object(publish, 'publish_report') as report:
            with self.assertRaises(subprocess.CalledProcessError):
                publish.main()
        self.assertEqual(prepare.call_count, 1)
        report.assert_not_called()
        self.assertEqual(list(self.staging.iterdir()), [])

    def test_dry_run_and_profile_apply_to_each_sample_and_leave_no_staging_files(self):
        with patch('sys.argv', self.args + ['--dry-run', '--profile', 'publisher']), \
             patch.object(publish.shutil, 'which', return_value='aws'), \
             patch.object(publish, 'prepare_sample', side_effect=self.prepare), \
             patch.object(publish.subprocess, 'run') as upload, \
             patch.object(publish, 'publish_report') as report:
            publish.main()
        self.assertEqual(upload.call_count, 2)
        for call in upload.call_args_list:
            self.assertEqual(call.args[0][:3], ['aws', '--profile', 'publisher'])
            self.assertIn('--dryrun', call.args[0])
        self.assertEqual(report.call_count, 2)
        for call in report.call_args_list:
            self.assertTrue(call.args[-1])
            self.assertEqual(call.args[1], ['aws', '--profile', 'publisher'])
        self.assertEqual(list(self.staging.iterdir()), [])

    def test_empty_staging_argument_is_rejected_before_preparing_or_uploading(self):
        for value in ('', '   '):
            with self.subTest(value=value):
                args = self.args[:]
                args[args.index('--staging-dir') + 1] = value
                error = io.StringIO()
                with patch('sys.argv', args), contextlib.redirect_stderr(error), \
                     patch.object(publish, 'prepare_sample') as prepare, \
                     patch.object(publish.subprocess, 'run') as upload:
                    with self.assertRaises(SystemExit) as raised:
                        publish.main()
                self.assertEqual(raised.exception.code, 2)
                self.assertIn('cannot be empty', error.getvalue())
                prepare.assert_not_called(); upload.assert_not_called()
        self.assertFalse(self.staging.exists())

    def test_failed_asset_copy_removes_its_partial_file_without_touching_the_source(self):
        source = write(self.source / 'SPH0055/assembly.fasta', '>contig\nACGT\n')
        assets = self.root / 'assets'; assets.mkdir()
        real_temporary_file = publish.tempfile.NamedTemporaryFile
        def full_disk(*args, **kwargs):
            handle = real_temporary_file(*args, **kwargs)
            handle.write = lambda data: (_ for _ in ()).throw(OSError(errno.ENOSPC, 'Full'))
            return handle
        with patch.object(publish.tempfile, 'NamedTemporaryFile', side_effect=full_disk):
            with self.assertRaises(OSError):
                publish.stage_asset(source, source.parent, 'assembly.fasta', assets, 'reports/phoridae/SPH0055/')
        self.assertEqual(list(assets.iterdir()), [])
        self.assertEqual(source.read_text(), '>contig\nACGT\n')


if __name__ == '__main__':
    unittest.main()
