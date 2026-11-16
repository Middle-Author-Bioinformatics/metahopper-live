"""Exercise publisher subprocesses against an AWS CLI v1-shaped argument parser."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('publish_compat', Path(__file__).parents[1] / 'scripts/publish_reports.py')
publish = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publish)


class CliCompatibilityTests(unittest.TestCase):
    def test_real_subprocess_uploads_accept_v1_options_and_bind_index_to_etag(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sample = root / 'Sample'; sample.mkdir()
            (sample / 'metahopper_report.html').write_text('<html>report</html>')
            (sample / 'asset_manifest.json').write_text('{}')
            (sample / 'taxonomy_index.json').write_text(json.dumps(dict(
                schema='metahopper-taxonomy-1', sample='Sample', stage='final', bins=[])))
            log = root / 'calls.jsonl'
            cli = root / 'cli_v1.py'
            cli.write_text(textwrap.dedent('''\
                import argparse, json, os
                from pathlib import Path
                p = argparse.ArgumentParser(allow_abbrev=False)
                p.add_argument('--profile')
                p.add_argument('service', choices=['s3api', 's3'])
                p.add_argument('operation', choices=['put-object', 'cp'])
                p.add_argument('source', nargs='?')
                p.add_argument('destination', nargs='?')
                for option in ('bucket','key','body','content-type','metadata','cache-control','output'):
                    p.add_argument('--' + option)
                p.add_argument('--no-progress', action='store_true')
                # No --no-cli-pager option: argparse rejects it just as CLI v1 does.
                args = p.parse_args()
                assert os.environ['MH_COMPAT_SENTINEL'] == 'preserved'
                if args.service == 's3api':
                    assert args.operation == 'put-object'
                    assert args.output == 'json'
                    assert os.environ.get('AWS_PAGER') == ''
                    assert Path(args.body).read_text() == '<html>report</html>'
                    print(json.dumps(dict(ETag='"' + 'a'*32 + '"')))
                else:
                    assert args.operation == 'cp'
                    assert Path(args.source).is_file()
                with open(os.environ['MH_COMPAT_LOG'], 'a') as handle:
                    handle.write(json.dumps(vars(args)) + '\\n')
                '''))
            with patch.dict(os.environ, {'AWS_PAGER': 'less', 'MH_COMPAT_SENTINEL': 'preserved',
                                         'MH_COMPAT_LOG': str(log)}):
                publish.publish_report(sample, [sys.executable, str(cli), '--profile', 'test'],
                                       'sample-bucket', 'reports/phoridae/')
                self.assertEqual(os.environ['AWS_PAGER'], 'less', 'The parent shell configuration was changed')
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertEqual([(c['service'], c['operation']) for c in calls],
                             [('s3', 'cp'), ('s3api', 'put-object'), ('s3', 'cp')])
            self.assertTrue(all(c['profile'] == 'test' for c in calls))
            self.assertEqual(calls[-1]['destination'], 's3://sample-bucket/reports/phoridae/Sample/taxonomy/' + 'a'*32 + '.json')
            self.assertEqual(json.loads((sample/'taxonomy_index.json').read_text())['report']['etag'], 'a'*32)


if __name__ == '__main__':
    unittest.main()
