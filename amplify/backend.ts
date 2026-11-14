import { defineBackend } from '@aws-amplify/backend';
import { CfnBucket } from 'aws-cdk-lib/aws-s3';
import { auth } from './auth/resource';
import { storage } from './storage/resource';
import { AUTH_GROUPS } from '../project';

export const backend = defineBackend({ auth, storage });
const { cfnUserPool, cfnIdentityPool } = backend.auth.resources.cfnResources;
// Hiding the signup UI alone is insufficient: enforce invitations in Cognito.
cfnUserPool.addPropertyOverride('AdminCreateUserConfig.AllowAdminCreateUserOnly', true);
cfnIdentityPool.allowUnauthenticatedIdentities = false;
const bucket = backend.storage.resources.bucket.node.defaultChild as CfnBucket;
bucket.publicAccessBlockConfiguration = {
  blockPublicAcls: true, blockPublicPolicy: true, ignorePublicAcls: true, restrictPublicBuckets: true,
};
bucket.versioningConfiguration = { status: 'Enabled' };

// Role identifiers are public configuration, not credentials. Cognito permits a
// requested role only when it is present in the user's signed token.
backend.addOutput({
  custom: {
    report_group_roles: Object.fromEntries(AUTH_GROUPS.map((group) => [
      group, backend.auth.resources.groups[group].role.roleArn,
    ])),
  },
});
