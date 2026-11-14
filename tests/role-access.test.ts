import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROJECTS } from '../project.ts';
import { projectRole, roleCredentialCache, type RoleSession } from '../src/role-access.ts';

const roles = {
  'phoridae-viewers': 'arn:aws:iam::123456789012:role/phoridae',
  'aphrophora-viewers': 'arn:aws:iam::123456789012:role/aphrophora',
  'sample-reports': 'arn:aws:iam::123456789012:role/samples',
  'metahopper-admins': 'arn:aws:iam::123456789012:role/staff',
};
const client = { 'cognito:groups': ['phoridae-viewers', 'aphrophora-viewers'], 'cognito:roles': [roles['phoridae-viewers'], roles['aphrophora-viewers']] };

test('a two-project client selects each assigned IAM role and cannot select Sample reports', () => {
  assert.equal(projectRole(PROJECTS[0], client, roles), roles['phoridae-viewers']);
  assert.equal(projectRole(PROJECTS[1], client, roles), roles['aphrophora-viewers']);
  assert.throws(() => projectRole(PROJECTS[2], client, roles), /do not have access/);
  assert.throws(() => projectRole({ ...PROJECTS[0], prefix: 'reports/sample-reports/' }, client, roles), /do not have access/);
});

test('a matching group without its signed role claim, missing outputs, and unknown users fail closed', () => {
  assert.throws(() => projectRole(PROJECTS[1], { ...client, 'cognito:roles': [roles['phoridae-viewers']] }, roles), /role unavailable/);
  assert.throws(() => projectRole(PROJECTS[0], client, {}), /role unavailable/);
  assert.throws(() => projectRole(PROJECTS[0], {}, roles), /do not have access/);
});

test('staff use their staff role for all projects without requiring client-group membership', () => {
  const claims = { 'cognito:groups': ['metahopper-admins'], 'cognito:roles': roles['metahopper-admins'] };
  for (const project of PROJECTS) assert.equal(projectRole(project, claims, roles), roles['metahopper-admins']);
});

test('parallel exchanges, role switches, identities, token changes, and expiration have separate credentials', async () => {
  let now = 0;
  const calls: RoleSession[] = [];
  const cache = roleCredentialCache(async (session) => {
    calls.push(session);
    return { accessKeyId: `${session.identityId}:${session.roleArn}`, secretAccessKey: 'secret', sessionToken: session.token, expiration: new Date(now + 120_000) };
  }, () => now);
  const session = { identityId: 'user1', token: 'token1', roleArn: roles['phoridae-viewers'] };
  const [a, b, c] = await Promise.all([cache.get(session), cache.get(session), cache.get({ ...session, roleArn: roles['aphrophora-viewers'] })]);
  assert.equal(calls.length, 2); assert.equal(a, b); assert.notEqual(a.accessKeyId, c.accessKeyId);
  await cache.get(session); assert.equal(calls.length, 2);
  await cache.get({ ...session, identityId: 'user2' });
  await cache.get({ ...session, token: 'token2' });
  assert.equal(calls.length, 4);
  now = 61_000; await cache.get(session); assert.equal(calls.length, 5);
  cache.clear(); await cache.get(session); assert.equal(calls.length, 6);
});

test('sign-out invalidates pending role exchanges and failed exchanges can retry', async () => {
  let finish!: () => void;
  const cache = roleCredentialCache(async () => {
    await new Promise<void>((resolve) => { finish = resolve; });
    return { accessKeyId: 'key', secretAccessKey: 'secret', sessionToken: 'token', expiration: new Date(Date.now() + 300_000) };
  });
  const session = { identityId: 'user1', token: 'token1', roleArn: roles['phoridae-viewers'] };
  const pending = cache.get(session);
  cache.clear(); finish();
  await assert.rejects(pending, /session changed/);
  const retry = cache.get(session); finish(); assert.equal((await retry).accessKeyId, 'key');
});
