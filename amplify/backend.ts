import { defineBackend } from '@aws-amplify/backend';
import { CfnBucket } from 'aws-cdk-lib/aws-s3';
import { auth } from './auth/resource';
import { storage } from './storage/resource';

const backend = defineBackend({ auth, storage });
const { cfnUserPool, cfnIdentityPool } = backend.auth.resources.cfnResources;
// Hiding the signup UI alone is insufficient: enforce invitations in Cognito.
cfnUserPool.addPropertyOverride('AdminCreateUserConfig.AllowAdminCreateUserOnly', true);
cfnIdentityPool.allowUnauthenticatedIdentities = false;
const bucket = backend.storage.resources.bucket.node.defaultChild as CfnBucket;
bucket.publicAccessBlockConfiguration = {
  blockPublicAcls: true, blockPublicPolicy: true, ignorePublicAcls: true, restrictPublicBuckets: true,
};
bucket.versioningConfiguration = { status: 'Enabled' };
