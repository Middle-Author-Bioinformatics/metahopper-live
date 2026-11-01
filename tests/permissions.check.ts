// Offline synthesis check. Does not contact AWS or deploy resources.
import assert from 'node:assert/strict';
import { Names, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

process.env.CDK_CONTEXT_JSON = JSON.stringify({
  'amplify-backend-name': 'permissions-check',
  'amplify-backend-namespace': 'metahopper',
  'amplify-backend-type': 'sandbox',
});
const { backend } = await import('../amplify/backend');
const stacks = backend.stack.node.root.node.findAll().filter(Stack.isStack);
const resources = stacks.flatMap((stack) => Object.values(Template.fromStack(stack).toJSON().Resources)) as any[];
const groups = resources.filter((resource) => resource.Type === 'AWS::Cognito::UserPoolGroup');
assert.equal(groups.find((group) => group.Properties.GroupName === 'metahopper-admins')?.Properties.Precedence, 0);
assert.equal(groups.find((group) => group.Properties.GroupName === 'phoridae-viewers')?.Properties.Precedence, 1);
assert.equal(groups.find((group) => group.Properties.GroupName === 'aphrophora-viewers')?.Properties.Precedence, 2);
assert.equal(groups.find((group) => group.Properties.GroupName === 'sample-reports')?.Properties.Precedence, 3);

const projectPrefixes = {
  'phoridae-viewers': 'reports/phoridae/',
  'aphrophora-viewers': 'reports/aphrophora/',
  'sample-reports': 'reports/sample-reports/',
};
for (const name of [...Object.keys(projectPrefixes), 'metahopper-admins']) {
  const roleId = groups.find((group) => group.Properties.GroupName === name)?.Properties.RoleArn['Fn::GetAtt'][0];
  assert.equal(typeof roleId, 'string');
  const role = backend.auth.resources.groups[name].role;
  const roleExport = Names.uniqueId(role.node.defaultChild!);
  // Storage policies are in the storage nested stack and reference the auth
  // group's role through a CloudFormation parameter containing its logical ID.
  const policies = resources.filter((r: any) =>
    r.Type === 'AWS::IAM::Policy' && r.Properties.Roles?.some((value: any) =>
      value.Ref === roleId || value.Ref?.endsWith(`${roleExport}Ref`)));
  const statements = policies.flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  const s3 = statements.filter((s: any) => JSON.stringify(s.Action).includes('s3:'));
  assert.ok(s3.length, `Missing storage policies for ${name}`);
  assert.deepEqual([...new Set(s3.flatMap((s: any) => s.Action))].sort(), ['s3:GetObject', 's3:ListBucket']);
  const serialized = JSON.stringify(s3);
  for (const [group, prefix] of Object.entries(projectPrefixes)) {
    assert.equal(serialized.includes(prefix), name === group || name === 'metahopper-admins',
      `${name} has incorrect access to ${prefix}`);
  }
  assert.ok(!serialized.includes('s3:Put') && !serialized.includes('s3:Delete'));
  console.log(`PASS synthesized ${name} role has only its intended read permissions`);
}
const bucket = resources.find((r) => r.Type === 'AWS::S3::Bucket');
assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
  BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
});
assert.equal(resources.find((r) => r.Type === 'AWS::Cognito::IdentityPool').Properties.AllowUnauthenticatedIdentities, false);
assert.equal(resources.find((r) => r.Type === 'AWS::Cognito::UserPool').Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly, true);
console.log('PASS public storage and guest access remain blocked; sign-up remains invitation-only');
