import { fetchAuthSession } from 'aws-amplify/auth';
import { Hub } from 'aws-amplify/utils';
import { CognitoIdentityClient, GetCredentialsForIdentityCommand } from '@aws-sdk/client-cognito-identity';
import { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import outputs from '../amplify_outputs.json';
import { PROJECTS, type Project } from '../project';
import { projectRole, roleCredentialCache } from './role-access';

const config = outputs as {
  auth?: { aws_region?: string; user_pool_id?: string };
  storage?: { aws_region?: string; bucket_name?: string };
  custom?: { report_group_roles?: Record<string, string> };
};
let generation = 0;
const credentials = roleCredentialCache(async ({ identityId, token, roleArn }) => {
  const region = config.auth?.aws_region;
  const pool = config.auth?.user_pool_id;
  if (!region || !pool) throw new Error('Missing Cognito configuration');
  const client = new CognitoIdentityClient({ region });
  try {
    const result = await client.send(new GetCredentialsForIdentityCommand({
      IdentityId: identityId,
      Logins: { [`cognito-idp.${region}.amazonaws.com/${pool}`]: token },
      CustomRoleArn: roleArn,
    }));
    const value = result.Credentials;
    if (!value?.AccessKeyId || !value.SecretKey || !value.SessionToken || !value.Expiration) throw new Error('Missing temporary credentials');
    return { accessKeyId: value.AccessKeyId, secretAccessKey: value.SecretKey, sessionToken: value.SessionToken, expiration: value.Expiration };
  } finally { client.destroy(); }
});
Hub.listen('auth', ({ payload }) => {
  if (['signedIn', 'signedOut', 'tokenRefresh_failure'].includes(payload.event)) {
    generation++; credentials.clear();
  }
});

async function projectClient(project: Project, signal?: AbortSignal) {
  const started = generation;
  signal?.throwIfAborted();
  const session = await fetchAuthSession();
  if (started !== generation) throw new Error('Sign-in session changed');
  signal?.throwIfAborted();
  const token = session.tokens?.idToken;
  if (!token || !session.identityId) throw new Error('Sign in to view reports');
  const roleArn = projectRole(project, token.payload, config.custom?.report_group_roles ?? {});
  const value = await credentials.get({ identityId: session.identityId, token: token.toString(), roleArn });
  if (started !== generation) throw new Error('Sign-in session changed');
  signal?.throwIfAborted();
  const bucket = config.storage?.bucket_name, region = config.storage?.aws_region;
  if (!bucket || !region) throw new Error('Missing storage configuration');
  // Immutable credentials per operation: changing projects cannot change the role
  // of a listing, report fetch, or asset download already in progress.
  return { client: new S3Client({ region, credentials: value }), bucket, expiration: value.expiration };
}

export async function listProject(project: Project, nextToken?: string, signal?: AbortSignal) {
  const { client, bucket } = await projectClient(project, signal);
  try {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: project.prefix, MaxKeys: 1000, ContinuationToken: nextToken,
    }), { abortSignal: signal });
    if (page.IsTruncated && !page.NextContinuationToken) throw new Error('Incomplete report listing');
    return {
      items: (page.Contents ?? []).filter((item) => typeof item.Key === 'string').map((item) => ({
        path: item.Key!, eTag: item.ETag, lastModified: item.LastModified, size: item.Size,
      })),
      nextToken: page.NextContinuationToken,
    };
  } finally { client.destroy(); }
}

interface UrlOptions {
  expiresIn: number;
  validateObjectExistence?: boolean;
  contentDisposition?: { type: 'attachment'; filename: string };
  contentType?: string;
}
export async function getProjectUrl(input: { path: string; options: UrlOptions }, signal?: AbortSignal): Promise<{ url: URL }> {
  const project = PROJECTS.find((item) => input.path.startsWith(item.prefix));
  if (!project || /[\\\x00-\x1f]/.test(input.path) || input.path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Report is outside configured projects');
  }
  const { client, bucket, expiration } = await projectClient(project, signal);
  try {
    const { options } = input;
    if (options.validateObjectExistence) await client.send(new HeadObjectCommand({ Bucket: bucket, Key: input.path }), { abortSignal: signal });
    signal?.throwIfAborted();
    const filename = options.contentDisposition?.filename;
    const disposition = filename === undefined ? undefined : `attachment; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
    const expiresIn = Math.min(options.expiresIn, Math.floor((expiration.getTime() - Date.now()) / 1000) - 10);
    if (expiresIn <= 0) throw new Error('Temporary credentials expired');
    const url = await getSignedUrl(client, new GetObjectCommand({
      Bucket: bucket, Key: input.path, ResponseContentDisposition: disposition, ResponseContentType: options.contentType,
    }), { expiresIn });
    signal?.throwIfAborted();
    return { url: new URL(url) };
  } finally { client.destroy(); }
}
