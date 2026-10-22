import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectsForGroups } from '../project.ts';

test('client logins see only their own project; missing or unknown groups fail closed', () => {
  assert.deepEqual(projectsForGroups(['phoridae-viewers']).map((p) => p.id), ['phoridae']);
  assert.deepEqual(projectsForGroups(['aphrophora-viewers']).map((p) => p.id), ['aphrophora']);
  for (const groups of [undefined, [], ['unknown'], 'phoridae-viewers', { group: 'phoridae-viewers' }]) {
    assert.deepEqual(projectsForGroups(groups), []);
  }
});

test('staff can review both projects; multiple client groups follow IAM role precedence', () => {
  assert.deepEqual(projectsForGroups(['metahopper-admins']).map((p) => p.id), ['phoridae', 'aphrophora']);
  assert.deepEqual(projectsForGroups(['aphrophora-viewers', 'metahopper-admins']).map((p) => p.id), ['phoridae', 'aphrophora']);
  assert.deepEqual(projectsForGroups(['aphrophora-viewers', 'phoridae-viewers']).map((p) => p.id), ['phoridae']);
});
