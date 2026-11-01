import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectsForGroups } from '../project.ts';

test('client logins see only their own project; missing or unknown groups fail closed', () => {
  assert.deepEqual(projectsForGroups(['phoridae-viewers']).map((p) => p.id), ['phoridae']);
  assert.deepEqual(projectsForGroups(['aphrophora-viewers']).map((p) => p.id), ['aphrophora']);
  assert.deepEqual(projectsForGroups(['sample-reports']).map((p) => p.id), ['sample-reports']);
  for (const groups of [undefined, [], ['unknown'], 'phoridae-viewers', { group: 'phoridae-viewers' }]) {
    assert.deepEqual(projectsForGroups(groups), []);
  }
});

test('staff can review all projects; multiple client groups follow IAM role precedence', () => {
  assert.deepEqual(projectsForGroups(['metahopper-admins']).map((p) => p.id), ['phoridae', 'aphrophora', 'sample-reports']);
  assert.deepEqual(projectsForGroups(['sample-reports', 'metahopper-admins']).map((p) => p.id), ['phoridae', 'aphrophora', 'sample-reports']);
  assert.deepEqual(projectsForGroups(['aphrophora-viewers', 'phoridae-viewers']).map((p) => p.id), ['phoridae']);
  assert.deepEqual(projectsForGroups(['sample-reports', 'phoridae-viewers']).map((p) => p.id), ['phoridae']);
  assert.deepEqual(projectsForGroups(['sample-reports', 'aphrophora-viewers']).map((p) => p.id), ['aphrophora']);
});
