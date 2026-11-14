// Offline synthesis only: no AWS requests or deployment.
import assert from 'node:assert/strict';
import { Names, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AUTH_GROUPS, PROJECTS, STAFF_GROUP } from '../project';

process.env.CDK_CONTEXT_JSON = JSON.stringify({
  'amplify-backend-name': 'permissions-check',
  'amplify-backend-namespace': 'metahopper',
  'amplify-backend-type': 'sandbox',
});
const { backend } = await import('../amplify/backend');
const stacks = backend.stack.node.root.node.findAll().filter(Stack.isStack);
const templates = stacks.map((stack) => Template.fromStack(stack).toJSON());
const resources = templates.flatMap((template) => Object.values(template.Resources)) as any[];
const groups = resources.filter((resource) => resource.Type === 'AWS::Cognito::UserPoolGroup');
for (const [precedence, name] of AUTH_GROUPS.entries()) {
  const group = groups.find((item) => item.Properties.GroupName === name);
  assert.equal(group?.Properties.Precedence, precedence);
  const roleId = group.Properties.RoleArn['Fn::GetAtt'][0];
  const role = backend.auth.resources.groups[name].role;
  const roleExport = Names.uniqueId(role.node.defaultChild!);
  const policies = resources.filter((r: any) => r.Type === 'AWS::IAM::Policy'
    && r.Properties.Roles?.some((value: any) => value.Ref === roleId || value.Ref?.endsWith(`${roleExport}Ref`)));
  const s3 = policies.flatMap((p: any) => p.Properties.PolicyDocument.Statement).filter((s: any) => JSON.stringify(s.Action).includes('s3:'));
  assert.ok(s3.length, `Missing policies for ${name}`);
  assert.deepEqual([...new Set(s3.flatMap((s: any) => s.Action))].sort(), ['s3:GetObject', 's3:ListBucket']);
  const serialized = JSON.stringify(s3);
  for (const project of PROJECTS) assert.equal(serialized.includes(project.prefix), name === STAFF_GROUP || name === project.group);
  console.log(`PASS ${name}: unchanged precedence and only intended read permissions`);
}
const attachment = resources.find((r) => r.Type === 'AWS::Cognito::IdentityPoolRoleAttachment');
for (const mapping of Object.values(attachment.Properties.RoleMappings) as any[]) {
  assert.equal(mapping.Type, 'Token');
  assert.equal(mapping.AmbiguousRoleResolution, 'AuthenticatedRole');
}
// Amplify's default authenticated fallback must not grant report access.
const authenticated = backend.auth.resources.authenticatedUserIamRole;
const authenticatedId = Names.uniqueId(authenticated.node.defaultChild!);
const fallbackPolicies = resources.filter((r: any) => r.Type === 'AWS::IAM::Policy'
  && r.Properties.Roles?.some((value: any) => value.Ref === authenticatedId || value.Ref?.endsWith(`${authenticatedId}Ref`)));
assert.ok(!JSON.stringify(fallbackPolicies).includes('s3:'), 'Unassigned authenticated users must not receive S3 permissions');
const bucket = resources.find((r) => r.Type === 'AWS::S3::Bucket');
assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
  BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
});
assert.equal(resources.find((r) => r.Type === 'AWS::Cognito::IdentityPool').Properties.AllowUnauthenticatedIdentities, false);
assert.equal(resources.find((r) => r.Type === 'AWS::Cognito::UserPool').Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly, true);
assert.ok(JSON.stringify(templates).includes('report_group_roles'), 'Deployed outputs must include role identifiers');
console.log('PASS token role selection, public/guest restrictions, invitation-only sign-in, and role outputs');
