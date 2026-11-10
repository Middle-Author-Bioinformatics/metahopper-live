import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import shutil

PIPELINE=Path(os.environ.get('METAHOPPER_TEST_PIPELINE_DIR',str(Path(__file__).resolve().parents[2]/'MetaHopper')))
sys.path.insert(0,str(PIPELINE))
from pathway_test_fixture import fixture
from metahopper_pathway_view import read_results,render_pathways
from metahopper_pathways import result_lock

spec=importlib.util.spec_from_file_location('publish_pathways',Path(__file__).parents[1]/'scripts/publish_reports.py')
publish=importlib.util.module_from_spec(spec);spec.loader.exec_module(publish)


class PathwayPublisherTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=(Path(self.tmp.name)/'Sample').resolve();self.output=fixture(self.root)
        self.data=read_results(self.output,self.root)

    def tearDown(self):self.tmp.cleanup()

    def test_exact_files_and_input_checksums_are_registered_without_external_paths(self):
        sources,expected=publish.pathway_sources(render_pathways(self.data),self.root,'final')
        self.assertEqual(len(sources),len(self.data['files']))
        name='final/pathways/genus/all_model_hits.csv';self.assertIn(name,sources)
        stage=Path(self.tmp.name)/'assets';stage.mkdir()
        result=publish.stage_asset(sources[name],self.root,name,stage,'reports/aphrophora/Sample/')
        self.assertEqual(result['sha256'],expected[name]['sha256'])
        self.assertEqual(result['size'],expected[name]['size'])

    def test_reports_without_pathways_keep_the_existing_publisher_behavior(self):
        self.assertEqual(publish.pathway_sources('<html></html>',self.root,'final'),({},{}))

    def test_cross_sample_or_bin_set_and_preview_reports_are_rejected(self):
        for change in [dict(run_name='Other'),dict(stage='preliminary'),dict(preview=True)]:
            with self.subTest(change=change):
                with self.assertRaises(ValueError):publish.pathway_sources(render_pathways(dict(self.data,**change)),self.root,'final')

    def test_changed_input_is_rejected_before_publishing(self):
        (self.root/'final/bins/genus/A.fasta').write_text('>A_contig\nATGCCCTAA\n')
        with self.assertRaisesRegex(ValueError,'input bin changed'):
            publish.pathway_sources(render_pathways(self.data),self.root,'final')

    def test_assets_cannot_escape_their_results_folder(self):
        self.data['files'][0]['path']='final/bins/genus/A.fasta'
        with self.assertRaisesRegex(ValueError,'outside its declared'):
            publish.pathway_sources(render_pathways(self.data),self.root,'final')

    def test_path_traversal_is_rejected(self):
        self.data['files'][0]['path']='final/pathways/genus/../../../outside.csv'
        with self.assertRaisesRegex(ValueError,'Invalid pathway asset'):
            publish.pathway_sources(render_pathways(self.data),self.root,'final')

    def test_locked_pathway_run_cannot_be_published(self):
        with result_lock(self.output):
            with self.assertRaisesRegex(ValueError,'active'):
                publish.pathway_sources(render_pathways(self.data),self.root,'final')

    def test_real_report_and_publisher_include_pathway_tables_and_sequences(self):
        assembly=self.root/'final/assembly/consolidated_contigs.fasta';assembly.parent.mkdir(parents=True);assembly.write_text('>A_contig\nATGAAATAA\n')
        report=self.root/'metahopper_report.html';report.write_text('placeholder')
        stage=Path(self.tmp.name)/'stage';stage.mkdir()
        output=publish.prepare_sample(report,stage,'sample-bucket','reports/aphrophora/',PIPELINE)
        manifest=json.loads((output/'asset_manifest.json').read_text())
        for logical in ['final/pathways/genus/all_model_hits.csv','final/pathways/genus/pathway_summary.long.csv','final/pathways/genus/bins/A_test/proteins.faa','final/pathways/genus/bins/A_test/genes.fna']:
            self.assertIn(logical,manifest['files'])
            item=manifest['files'][logical]
            self.assertTrue((output/'assets'/item['sha256']/logical).is_file())
            self.assertTrue(item['key'].startswith('reports/aphrophora/Sample/assets/'))
        self.assertIn('id="annotation-pathways-tab"',(output/'metahopper_report.html').read_text())
        shutil.copy2(output/'metahopper_report.html',report)
        with (self.output/'all_model_hits.csv').open('a') as handle:handle.write('\n')
        stage2=Path(self.tmp.name)/'stage2';stage2.mkdir()
        with self.assertRaisesRegex(ValueError,'Pathway outputs changed'):
            publish.prepare_sample(report,stage2,'sample-bucket','reports/aphrophora/',PIPELINE,skip_refresh=True)


if __name__=='__main__':unittest.main()
