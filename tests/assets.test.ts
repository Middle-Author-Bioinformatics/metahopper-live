import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { assetManifest, MAX_BUFFERED_ASSET_BYTES, resolveAsset, startAssetDownload, verifyAsset, type AssetManifest } from '../src/assets.ts';
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

test('large published assets resolve for direct download while buffering stays bounded', () => {
  const large = structuredClone(manifest);
  large.files[path].size = MAX_BUFFERED_ASSET_BYTES + 1;
  large.files[path].downloadOnly = true;
  assert.equal(resolveAsset(large, report, path, 'download').size, MAX_BUFFERED_ASSET_BYTES + 1);
  assert.throws(() => resolveAsset(large, report, path), /direct download/);
  delete large.files[path].downloadOnly;
  assert.throws(() => resolveAsset(large, report, path), /direct download/);
  large.files[path].size = 4;large.files[path].downloadOnly = true;
  assert.throws(() => resolveAsset(large, report, path), /direct download/);
  assert.equal(resolveAsset(large, report, path, 'download').size, 4);
  assert.throws(() => resolveAsset(large, 'reports/aphrophora/Sample/metahopper_report.html', path, 'download'));
  large.files[path].key = 'reports/phoridae/Other/private.fasta';
  assert.throws(() => resolveAsset(large, report, path, 'download'));
});

test('native downloads use a parent link without fetching, buffering, or creating a Blob', () => {
  const events: string[]=[];
  const anchor={href:'',download:'',rel:'',referrerPolicy:'',click:()=>events.push('click'),remove:()=>events.push('remove')};
  const doc={createElement:(tag:string)=>{assert.equal(tag,'a');return anchor;},body:{appendChild:(value:unknown)=>{assert.equal(value,anchor);events.push('append');}}};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{value:doc,configurable:true});
  try {
    startAssetDownload(new URL('https://example.invalid/immutable/assembly.gfa.gz?signature=private'), '_compressed/megahit/assembly.gfa.gz');
    assert.deepEqual(events,['append','click','remove']);
    assert.equal(anchor.download,'assembly.gfa.gz');assert.equal(anchor.rel,'noreferrer');assert.equal(anchor.referrerPolicy,'no-referrer');
    assert.throws(()=>startAssetDownload(new URL('javascript:alert(1)'),path),/secure/);
  } finally {
    if (previous) Object.defineProperty(globalThis,'document',previous); else Reflect.deleteProperty(globalThis,'document');
  }
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

test('large graph clicks request a native parent download without returning a signed URL or bytes', async () => {
  const code=isolatedReport('<html><head></head><body></body></html>','download-channel').match(/<script>([\s\S]*?)<\/script>/)![1];
  const messages: Array<Record<string,unknown>>=[];
  const listeners: Record<string,(event:any)=>void>={};
  const parent={postMessage:(message:Record<string,unknown>)=>messages.push(message)};
  const logical='_compressed/megahit/assembly.gfa.gz';
  const anchor={getAttribute:(key:string)=>key==='data-sample-asset'?logical:null};
  const child: Record<string,unknown>={};
  const document={getElementById:(id:string)=>id==='metahopper-assets'?{textContent:JSON.stringify({files:{[logical]:{size:MAX_BUFFERED_ASSET_BYTES+1,downloadOnly:true}}})}:null,
    addEventListener:(name:string,callback:(event:any)=>void)=>{listeners[name]=callback;}};
  vm.runInNewContext(code,{window:child,parent,document,ArrayBuffer,
    addEventListener:(name:string,callback:(event:any)=>void)=>{listeners[name]=callback;},
    setTimeout:()=>1,clearTimeout:()=>{},alert:(error:string)=>assert.fail(error),
    Blob:()=>assert.fail('Large download must not create a Blob'),URL:{createObjectURL:()=>assert.fail('Large download must not be buffered')}});
  listeners.DOMContentLoaded({});let prevented=false;
  const click=listeners.click({target:{closest:()=>anchor},preventDefault:()=>{prevented=true;}});
  assert.equal(prevented,true);assert.equal(messages.length,1);assert.equal(messages[0].type,'asset-download');assert.equal(messages[0].path,logical);
  listeners.message({source:parent,data:{channel:'download-channel',type:'asset-response',id:messages[0].id,downloadStarted:true}});
  await click;
  assert.equal(messages[0].url,undefined);assert.equal(messages[0].buffer,undefined);
});
