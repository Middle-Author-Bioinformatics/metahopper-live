import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { resolveAsset, verifyAsset, type AssetManifest } from '../src/assets.ts';

// Exercise the real storage functions with only the Amplify/network boundary
// stubbed. No AWS credentials, network calls, or huge allocations are needed.
const code=stripTypeScriptTypes(readFileSync(new URL('../src/storage.ts',import.meta.url),'utf8'))
  .replace(/^import .*;$/gm,'').replace(/\bexport (?=(?:async )?function)/g,'')
  +'\n({readReportAsset,downloadReportAsset})';
const report='reports/aphrophora/Sample/metahopper_report.html';
const logical='_compressed/megahit/assembly.gfa.gz';
const sha='a'.repeat(64);
const manifest: AssetManifest={schema:'metahopper-assets-1',sample:'Sample',bucket:'bucket',prefix:'reports/aphrophora/Sample/',
  files:{[logical]:{key:`reports/aphrophora/Sample/assets/${sha}/${logical}`,sha256:sha,size:700*1024*1024,downloadOnly:true}}};

function harness(onUrl?:()=>void) {
  const calls: any[]=[];const downloads: any[]=[];
  const functions=vm.runInNewContext(code,{PROJECTS:[{prefix:'reports/aphrophora/'}],resolveAsset,verifyAsset,
    getUrl:async (input:unknown)=>{calls.push(input);onUrl?.();return {url:new URL('https://example.invalid/asset?signature=private')};},
    startAssetDownload:(url:URL,path:string)=>downloads.push({url,path}),
    fetch:()=>assert.fail('Native download must not fetch or allocate the file in JavaScript')});
  return {functions,calls,downloads};
}

test('large private assets request an attachment URL and start a parent download',async()=>{
  const {functions,calls,downloads}=harness();
  assert.equal(await functions.downloadReportAsset(report,manifest,logical,new AbortController().signal),undefined);
  assert.equal(calls.length,1);assert.equal(calls[0].path,manifest.files[logical].key);
  assert.equal(calls[0].options.validateObjectExistence,true);
  assert.equal(calls[0].options.contentDisposition.type,'attachment');
  assert.equal(calls[0].options.contentDisposition.filename,'assembly.gfa.gz');
  assert.equal(calls[0].options.contentType,'application/octet-stream');
  assert.equal(downloads.length,1);assert.equal(downloads[0].path,logical);
});

test('the storage boundary rejects cross-sample downloads and huge buffered loads before signing',async()=>{
  const {functions,calls,downloads}=harness();const signal=new AbortController().signal;
  await assert.rejects(functions.readReportAsset(report,manifest,logical,signal),/direct download/);
  await assert.rejects(functions.downloadReportAsset('reports/aphrophora/Other/metahopper_report.html',manifest,logical,signal),/different sample/);
  await assert.rejects(functions.downloadReportAsset('reports/unknown/Sample/metahopper_report.html',manifest,logical,signal),/configured projects/);
  const poisoned=structuredClone(manifest);poisoned.files[logical].key='reports/aphrophora/Other/private.gfa';
  await assert.rejects(functions.downloadReportAsset(report,poisoned,logical,signal),/outside this sample/);
  assert.equal(calls.length,0);assert.equal(downloads.length,0);
});

test('cancelled or replaced reports cannot start a stale browser download',async()=>{
  const controller=new AbortController();const {functions,downloads}=harness(()=>controller.abort());
  await assert.rejects(functions.downloadReportAsset(report,manifest,logical,controller.signal),/abort/i);
  assert.equal(downloads.length,0);
});
