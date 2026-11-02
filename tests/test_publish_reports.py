import importlib.util
import csv
import hashlib
import gzip
import json
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('publish',Path(__file__).parents[1]/'scripts/publish_reports.py')
publish=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(publish)
PIPELINE=Path(os.environ.get('METAHOPPER_TEST_PIPELINE_DIR',str(Path(__file__).resolve().parents[2]/'MetaHopper')))


def write(path,text):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text);return path


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)/'Sample';self.stage=Path(self.tmp.name)/'stage';self.stage.mkdir()
        seq='A'*997+'CGT'
        write(self.root/'megahit/final.contigs.fa','>k3_1\n'+seq+'\n')
        write(self.root/'work/megahit/intermediate_contigs/k3.contigs.fa','>k3_1\n'+seq+'\n>k3_2\nCGTTAA\n')
        write(self.root/'final/assembly/consolidated_contigs.fasta','>MH_original_1\n'+seq+'\n')
        write(self.root/'final/bins/genus/Test.fasta','>MH_original_1\n'+seq+'\n')
        write(self.root/'final/assembly/contig_provenance.tsv','final_contig\tsource_rank\tsource_bin\tsource_type\tsource_record\nMH_original_1\tgenus\tTest\toriginal\tk3_1\n')
        write(self.root/'final/binarena/binarena_input.tsv','contig\tlength\tGC\tcoverage\tbin\t4PC1\t4PC2\nMH_original_1\t1000\t50\t2\tTest\t0.1\t0.2\n')
        self.report=write(self.root/'metahopper_report.html','placeholder')
    def tearDown(self):self.tmp.cleanup()
    def test_real_report_generation_exports_graphs_and_pins_each_sample_asset(self):
        output=publish.prepare_sample(self.report,self.stage,'sample-bucket','reports/phoridae/',PIPELINE)
        manifest=json.loads((output/'asset_manifest.json').read_text())
        self.assertEqual(manifest['sample'],'Sample')
        self.assertIn('assembly_graphs.final.json',manifest['files'])
        self.assertIn('megahit/assembly.gfa',manifest['files'])
        self.assertIn('final/bins/genus/Test.fasta',manifest['files'])
        for logical,entry in manifest['files'].items():
            self.assertEqual(entry['key'],f'reports/phoridae/Sample/assets/{entry["sha256"]}/{logical}')
            self.assertTrue((output/'assets'/entry['sha256']/logical).is_file())
        html=(output/'metahopper_report.html').read_text()
        self.assertIn('id="metahopper-assets"',html)
        self.assertIn('data-sample-asset="final/bins/genus/Test.fasta"',html)
        catalog=json.loads((self.root/'assembly_graphs.final.json').read_text())
        self.assertEqual(catalog['counts']['matched_contigs'],1)
        self.assertTrue((self.root/'work/megahit/intermediate_contigs/k3.contigs.fa').is_file())
    def test_symlinks_cannot_publish_files_outside_the_run(self):
        outside=write(Path(self.tmp.name)/'secret.fasta','outside')
        link=self.root/'final/bins/genus/Outside.fasta';link.symlink_to(outside)
        with self.assertRaisesRegex(ValueError,'outside this run'):
            publish.stage_asset(link,self.root,'final/bins/genus/Outside.fasta',self.stage,'reports/phoridae/Sample/')
    def test_active_pipeline_is_not_published(self):
        import fcntl
        lock=write(self.root/'pipeline.lock','')
        with lock.open('rb') as handle:
            fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError,'still running'):
                with publish.idle_sample(self.root):pass
    def test_manifest_injection_is_safe_and_replaces_an_old_manifest(self):
        html='<html><head></head><body></body></html>'
        result=publish.embed_manifest(html,{'sample':'</script><script>alert(1)</script>'})
        self.assertNotIn('</script><script>alert',result)
        result=publish.embed_manifest(result,{'sample':'safe'})
        self.assertEqual(result.count('id="metahopper-assets"'),1)

    def add_annotation(self, stale=False):
        directory=self.root/'final/annotation/genus/Test'
        checksum=hashlib.sha256((self.root/'final/bins/genus/Test.fasta').read_bytes()).hexdigest()
        write(directory/'result.json',json.dumps(dict(status='completed',signature={'input_sha256':'bad' if stale else checksum})))
        write(directory/'modules.json','{}')
        write(directory/'features.tsv','rank\tbin\tlocus_tag\tgene\tproduct\ttype\tcontig\tstart\tend\tstrand\tdb_xrefs\n'
            'genus\tTest\tMH_1\tdnaA\tChromosomal replication initiator\tcds\tMH_original_1\t1\t900\t+\tCOG:0593\n')
        write(directory/'bakta/annotation.faa','>MH_1 dnaA\nMAAAA\n')
        write(directory/'bakta/annotation.fna','>MH_original_1\nACGT\n')
        write(directory.parent/'summary.tsv','rank\tbin\tstatus\tcds\toutput_directory\n'
            'genus\tTest\tcompleted\t1\tfinal/annotation/genus/Test/bakta\n')

    def test_current_features_protein_fasta_and_existing_fastg_are_published(self):
        self.add_annotation()
        write(self.root/'reassembly/genus/Other/assembly_graph.fastg','>EDGE_1;\nACGT\n')
        write(self.root/'reassembly/genus/Other/assembly.gfa','S\t1\tACGT\n')
        write(self.root/'raw_reads.fastq.gz','not a report asset')
        output=publish.prepare_sample(self.report,self.stage,'sample-bucket','reports/aphrophora/',PIPELINE)
        manifest=json.loads((output/'asset_manifest.json').read_text())
        for path in ['final/annotation/genus/Test/features.tsv','final/annotation/genus/Test/bakta/annotation.faa',
                     'final/annotation/genus/Test/bakta/annotation.fna','reassembly/genus/Other/assembly_graph.fastg',
                     'reassembly/genus/Other/assembly.gfa']:
            self.assertIn(path,manifest['files'])
            self.assertTrue(manifest['files'][path]['key'].startswith('reports/aphrophora/Sample/assets/'))
        self.assertNotIn('raw_reads.fastq.gz',manifest['files'])
        html=(output/'metahopper_report.html').read_text()
        self.assertIn('Chromosomal replication initiator',html)
        self.assertIn('data-annotation-bin="genus/Test"',html)

    def test_stale_annotation_files_are_not_published(self):
        self.add_annotation(stale=True)
        output=publish.prepare_sample(self.report,self.stage,'sample-bucket','reports/sample-reports/',PIPELINE)
        manifest=json.loads((output/'asset_manifest.json').read_text())
        self.assertFalse(any('/annotation/' in key for key in manifest['files']))
        self.assertNotIn('Chromosomal replication initiator',(output/'metahopper_report.html').read_text())

    def test_upload_order_preserves_assets_before_html_and_explicit_project_prefix(self):
        commands=[]
        args=['publish_reports.py','--source',str(self.root.parent),'--sample','Sample',
              '--bucket','sample-bucket','--prefix','reports/sample-reports/','--pipeline-dir',str(PIPELINE),'--skip-refresh']
        def fake_prepare(report,stage,*args):
            dest=stage/report.parent.name
            write(dest/'metahopper_report.html','report')
            write(dest/'assets/hash/assembly.gfa','graph')
        with patch('sys.argv',args),patch.object(publish.shutil,'which',return_value='/usr/bin/aws'),\
             patch.object(publish,'prepare_sample',side_effect=fake_prepare),\
             patch.object(publish.subprocess,'run',side_effect=lambda cmd,**kwargs:commands.append(cmd)):
            publish.main()
        self.assertEqual(len(commands),2)
        self.assertIn('*.html',commands[0]);self.assertIn('*/metahopper_report.html',commands[1])
        for command in commands:
            self.assertIn('s3://sample-bucket/reports/sample-reports/',command)
            self.assertNotIn('--delete',command)

    def test_export_failure_stops_before_any_aws_upload_and_forwards_the_link_limit(self):
        commands=[]
        args=['publish_reports.py','--source',str(self.root.parent),'--sample','Sample',
              '--bucket','sample-bucket','--prefix','reports/aphrophora/','--pipeline-dir',str(PIPELINE),
              '--megahit-max-links','10000000']
        def fail_graph(command,**kwargs):
            commands.append(command)
            if 'metahopper_graph.py' in command[1]:
                self.assertIn('--megahit-max-links',command)
                self.assertEqual(command[command.index('--megahit-max-links')+1],'10000000')
                raise subprocess.CalledProcessError(1,command)
        with patch('sys.argv',args),patch.object(publish.shutil,'which',return_value='/usr/bin/aws'),\
             patch.object(publish.subprocess,'run',side_effect=fail_graph):
            with self.assertRaises(subprocess.CalledProcessError):publish.main()
        self.assertEqual(len(commands),1)
        self.assertNotEqual(commands[0][0],'aws')

    def test_graph_node_limit_does_not_silently_publish_without_the_original_graph(self):
        with self.assertRaisesRegex(ValueError,'Increase --graph-max-nodes'):
            publish.prepare_sample(self.report,self.stage,'sample-bucket','reports/aphrophora/',PIPELINE,max_nodes=1)

    def test_large_source_gfa_is_gzip_published_without_altering_the_saved_graph(self):
        source=self.root/'megahit/assembly.gfa'
        original=('S\tk3_1\t'+'A'*997+'CGT\nS\tk3_2\tCGTTAA\nL\tk3_1\t+\tk3_2\t+\t3M\n#'+'A'*20000+'\n').encode()
        write(source,original.decode());before=source.stat()
        with patch.object(publish,'MAX_ASSET_BYTES',8192):
            output=publish.prepare_sample(self.report,self.stage,'sample-bucket','reports/aphrophora/',PIPELINE)
        manifest=json.loads((output/'asset_manifest.json').read_text())
        logical='_compressed/megahit/assembly.gfa.gz'
        self.assertIn(logical,manifest['files']);self.assertNotIn('megahit/assembly.gfa',manifest['files'])
        entry=manifest['files'][logical];compressed=output/'assets'/entry['sha256']/logical
        self.assertEqual(gzip.decompress(compressed.read_bytes()),original)
        self.assertEqual(entry['size'],compressed.stat().st_size)
        self.assertEqual(entry['sha256'],hashlib.sha256(compressed.read_bytes()).hexdigest())
        self.assertEqual(source.read_bytes(),original)
        self.assertEqual(source.stat().st_mtime_ns,before.st_mtime_ns)

    def test_gzip_asset_keys_are_deterministic_and_remaining_transfer_limit_is_enforced(self):
        source=write(self.root/'large.gfa','S\t1\t'+'A'*20000+'\n')
        with patch.object(publish,'MAX_ASSET_BYTES',8192):
            a=publish.stage_asset(source,self.root,'_compressed/large.gfa.gz',self.stage,'reports/aphrophora/Sample/',compress=True)
            b=publish.stage_asset(source,self.root,'_compressed/large.gfa.gz',self.stage,'reports/aphrophora/Sample/',compress=True)
            self.assertEqual(a,b)
            source.write_bytes(os.urandom(20000))
            with self.assertRaisesRegex(ValueError,'Compressed graph still exceeds'):
                publish.stage_asset(source,self.root,'_compressed/large.gfa.gz',self.stage,'reports/aphrophora/Sample/',compress=True)


if __name__=='__main__':unittest.main()
