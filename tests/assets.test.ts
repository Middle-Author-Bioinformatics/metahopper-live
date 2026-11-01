import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { assetManifest, resolveAsset, verifyAsset, type AssetManifest } from '../src/assets.ts';
import { isolatedReport } from '../src/frame.ts';

const report = 'reports/phoridae/Sample/metahopper_report.html';
const checksum = 'a'.repeat(64);
const path = 'final/assembly/consolidated_contigs.fasta';
const manifest: AssetManifest = { schema:'metahopper-assets-1',sample:'Sample',bucket:'bucket',prefix:'reports/phoridae/Sample/',
  files:{[path]:{key:`reports/phoridae/Sample/assets/${checksum}/${path}`,sha256:checksum,size:4}} };

test('only immutable, explicitly published assets in this exact sample resolve', () => {
  assert.equal(resolveAsset(manifest,report,path).size,4);
  for(const bad of ['../other.fasta','%2e%2e/other.fasta','https://example.org/file.fasta','raw.fastq.gz','/file.fasta','final/../file.fasta'])
    assert.throws(()=>resolveAsset(manifest,report,bad));
  assert.throws(()=>resolveAsset(manifest,'reports/phoridae/Other/metahopper_report.html',path));
  const poisoned=structuredClone(manifest);poisoned.files[path].key='reports/other/Sample/private.fasta';
  assert.throws(()=>resolveAsset(poisoned,report,path));
  poisoned.files[path].size=1e12;assert.throws(()=>resolveAsset(poisoned,report,path));
});

test('asset manifests parse without replacing embedded report data', () => {
  const html=`<html><head><script id="metahopper-assets" type="application/json">${JSON.stringify(manifest)}</script></head><body></body></html>`;
  assert.deepEqual(assetManifest(html),manifest);
  assert.equal(assetManifest('<html></html>'),null);
  const isolated=isolatedReport(html,'channel');
  assert.ok(isolated.includes("connect-src 'none'"));
  assert.ok(isolated.includes('window.metahopperLoadAsset'));
  assert.ok(isolated.includes("event.source === parent"));
  assert.ok(isolated.includes('asset-request'));
  assert.deepEqual(assetManifest(isolated),manifest);
});

test('published features and existing FASTG files remain sample-scoped', () => {
  for (const prefix of ['reports/aphrophora/', 'reports/sample-reports/']) {
    for (const logical of ['final/annotation/genus/Test/features.tsv', 'reassembly/genus/Test/assembly.fastg', 'megahit/assembly.gfa']) {
      const scoped: AssetManifest = {schema:'metahopper-assets-1',sample:'Sample',bucket:'bucket',prefix:prefix+'Sample/',
        files:{[logical]:{key:`${prefix}Sample/assets/${checksum}/${logical}`,sha256:checksum,size:4}}};
      assert.equal(resolveAsset(scoped,prefix+'Sample/metahopper_report.html',logical).size,4);
      assert.throws(()=>resolveAsset(scoped,'reports/phoridae/Sample/metahopper_report.html',logical));
    }
  }
});

test('downloaded bytes must match the report hash and size', async () => {
  const buffer = new TextEncoder().encode('ACGT').buffer;
  const digest=await crypto.subtle.digest('SHA-256',buffer);
  const sha=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
  await verifyAsset(buffer,{key:'unused',sha256:sha,size:4});
  await assert.rejects(verifyAsset(buffer,{key:'unused',sha256:checksum,size:4}),/checksum/);
  await assert.rejects(verifyAsset(buffer,{key:'unused',sha256:sha,size:5}),/size/);
});

test('the iframe bridge accepts responses only from its parent and its own channel', async () => {
  const output=isolatedReport('<html><head></head><body></body></html>','asset-channel');
  const code=output.match(/<script>([\s\S]*?)<\/script>/)![1];
  const messages: Array<Record<string,unknown>>=[];
  const listeners: Record<string,(event:unknown)=>void>={};
  const parent={postMessage:(message:Record<string,unknown>)=>messages.push(message)};
  const child: Record<string,unknown>={};
  vm.runInNewContext(code,{window:child,parent,ArrayBuffer,
    addEventListener:(name:string,callback:(event:unknown)=>void)=>{listeners[name]=callback;},
    setTimeout:()=>1,clearTimeout:()=>{}});
  const load=child.metahopperLoadAsset as (path:string)=>Promise<ArrayBuffer>;
  let resolved=false;const pending=load('assembly_graphs.final.json').then(value=>{resolved=true;return value;});
  const id=messages[0].id,buffer=new ArrayBuffer(4);
  listeners.message({source:{},data:{channel:'asset-channel',type:'asset-response',id,buffer}});
  listeners.message({source:parent,data:{channel:'wrong',type:'asset-response',id,buffer}});
  await Promise.resolve();assert.equal(resolved,false);
  listeners.message({source:parent,data:{channel:'asset-channel',type:'asset-response',id,buffer}});
  assert.equal(await pending,buffer);
});
