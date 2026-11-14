import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { CognitoIdentityClient, GetCredentialsForIdentityCommand } from '@aws-sdk/client-cognito-identity';
import { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PROJECTS } from '../project.ts';
import { projectRole, roleCredentialCache } from '../src/role-access.ts';

// Exercise the actual AWS SDK serialization and signing. Replace only HTTP
// transports and the signed-in Amplify session; no AWS requests are sent.
const code = stripTypeScriptTypes(readFileSync(new URL('../src/aws-storage.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replace(/\bexport (?=(?:async )?function)/g, '') + '\n({listProject,getProjectUrl})';
const roles = Object.fromEntries(['phoridae-viewers','aphrophora-viewers','sample-reports','metahopper-admins'].map((g) => [g, `arn:aws:iam::123456789012:role/${g}`]));

function harness(groups = ['phoridae-viewers', 'aphrophora-viewers']) {
  const exchanges: any[] = [], requests: any[] = [], listeners: any[] = [];
  const keys = new Map<string, string>();
  const functions = vm.runInNewContext(code, {
    Date, URL, PROJECTS, projectRole, roleCredentialCache, GetCredentialsForIdentityCommand,
    ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, getSignedUrl,
    outputs: { auth: { aws_region:'us-east-2', user_pool_id:'us-east-2_TEST' }, storage: { aws_region:'us-east-2', bucket_name:'test-bucket' }, custom: { report_group_roles:roles } },
    Hub: { listen: (_: string, listener: any) => listeners.push(listener) },
    fetchAuthSession: async () => ({ identityId:'us-east-2:11111111-2222-3333-4444-555555555555', tokens:{ idToken:{
      payload:{ 'cognito:groups':groups, 'cognito:roles':groups.map(g=>roles[g]) }, toString:()=> 'signed-test-token',
    } } }),
    CognitoIdentityClient: class extends CognitoIdentityClient {
      constructor(config: any) { super({ ...config, requestHandler:{ handle:async (request: any) => {
        const input=JSON.parse(typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString());exchanges.push(input);
        assert.equal(input.Logins['cognito-idp.us-east-2.amazonaws.com/us-east-2_TEST'],'signed-test-token');
        assert.ok(groups.some(g=>roles[g]===input.CustomRoleArn));
        const key=`AKIATEST${exchanges.length}`;keys.set(key,input.CustomRoleArn);
        return {response:{statusCode:200,headers:{'content-type':'application/x-amz-json-1.1'},body:Readable.from([JSON.stringify({
          IdentityId:input.IdentityId,Credentials:{AccessKeyId:key,SecretKey:'test-secret',SessionToken:'test-session',Expiration:Math.floor(Date.now()/1000)+3600},
        })])}};
      } } }); }
    },
    S3Client: class extends S3Client {
      constructor(config: any) { super({ ...config, requestHandler:{ handle:async (request: any) => {
        const key=request.headers.authorization.match(/Credential=([^/]+)/)[1];
        const role=keys.get(key); requests.push({ request, role });
        const prefix=request.query.prefix ?? request.path.slice(1);
        const project=PROJECTS.find(p=>prefix.startsWith(p.prefix));
        assert.ok(project);assert.ok(role===roles[project.group]||role===roles['metahopper-admins']);
        const body=request.method==='HEAD'?'':`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><Contents><Key>${prefix}Sample/metahopper_report.html</Key><Size>12</Size><ETag>v1</ETag></Contents></ListBucketResult>`;
        return {response:{statusCode:200,headers:{'content-type':'application/xml'},body:Readable.from([body])}};
      } } }); }
    },
  });
  return {functions,exchanges,requests,keys,signOut:()=>listeners.forEach(fn=>fn({payload:{event:'signedOut'}}))};
}

test('listings and signed report/asset downloads use the selected project role', async () => {
  const {functions,exchanges,requests,keys}=harness();
  const [phoridae,aphrophora]=await Promise.all(PROJECTS.slice(0,2).map(p=>functions.listProject(p)));
  assert.equal(phoridae.items[0].path,'reports/phoridae/Sample/metahopper_report.html');
  assert.equal(aphrophora.items[0].path,'reports/aphrophora/Sample/metahopper_report.html');
  for(const project of PROJECTS.slice(0,2)) {
    const path=`${project.prefix}Sample/assets/hash/assembly.fna`;
    const {url}=await functions.getProjectUrl({path,options:{expiresIn:3600,validateObjectExistence:true,contentDisposition:{type:'attachment',filename:'assembly.fna'},contentType:'application/octet-stream'}});
    const accessKey=url.searchParams.get('X-Amz-Credential')!.split('/')[0];
    assert.equal(keys.get(accessKey),roles[project.group]);
    assert.match(url.searchParams.get('response-content-disposition')!,/^attachment;/);
    assert.equal(url.searchParams.get('response-content-type'),'application/octet-stream');
    assert.ok(Number(url.searchParams.get('X-Amz-Expires'))<3600);
  }
  assert.equal(exchanges.length,2);assert.equal(requests.length,4);
  await assert.rejects(functions.getProjectUrl({path:'reports/sample-reports/Sample/metahopper_report.html',options:{expiresIn:120}}),/do not have access/);
  assert.equal(exchanges.length,2);assert.equal(requests.length,4);
});

test('staff can read every configured project; cancelled operations and unknown users send no AWS requests', async () => {
  const staff=harness(['metahopper-admins']);
  for(const project of PROJECTS) await staff.functions.listProject(project);
  assert.equal(staff.exchanges.length,1);
  assert.ok(staff.requests.every(r=>r.role===roles['metahopper-admins']));
  staff.signOut();await staff.functions.listProject(PROJECTS[0]);assert.equal(staff.exchanges.length,2);
  const controller=new AbortController();controller.abort();
  await assert.rejects(staff.functions.listProject(PROJECTS[0],undefined,controller.signal),/abort/i);
  assert.equal(staff.requests.length,4);
  const nobody=harness([]);
  await assert.rejects(nobody.functions.listProject(PROJECTS[0]),/do not have access/);
  assert.equal(nobody.exchanges.length,0);assert.equal(nobody.requests.length,0);
});
