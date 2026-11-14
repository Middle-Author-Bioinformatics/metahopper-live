import { projectsForGroups, STAFF_GROUP, type Project } from '../project.ts';

export function projectRole(project: Project, claims: Record<string, unknown>, roles: Record<string, string>): string {
  const groups = claims['cognito:groups'];
  if (!projectsForGroups(groups).some((item) => item.id === project.id && item.prefix === project.prefix)) {
    throw new Error('You do not have access to this project');
  }
  const group = Array.isArray(groups) && groups.includes(STAFF_GROUP) ? STAFF_GROUP : project.group;
  const role = roles[group];
  const claim = claims['cognito:roles'];
  const allowed = Array.isArray(claim) ? claim : typeof claim === 'string' ? claim.split(',').map((item) => item.trim()) : [];
  if (!role || !allowed.includes(role)) throw new Error('Project role unavailable; sign in again after the backend deployment');
  return role;
}

export interface RoleSession { identityId: string; token: string; roleArn: string }
export interface RoleCredentials { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }

// Keep credentials separate by signed-in identity, ID token, and requested role.
// Concurrent requests for the same role share one exchange; no credentials are
// written to browser storage. Clearing invalidates unfinished exchanges too.
export function roleCredentialCache(exchange: (session: RoleSession) => Promise<RoleCredentials>, now = Date.now) {
  type Entry = { credentials?: RoleCredentials; pending?: Promise<RoleCredentials> };
  const entries = new Map<string, Entry>();
  let generation = 0;
  return {
    clear() { generation++; entries.clear(); },
    get(session: RoleSession): Promise<RoleCredentials> {
      const key = JSON.stringify([session.identityId, session.token, session.roleArn]);
      const entry = entries.get(key) ?? {};
      if (entry.credentials && entry.credentials.expiration.getTime() > now() + 60_000) return Promise.resolve(entry.credentials);
      if (entry.pending) return entry.pending;
      entry.credentials = undefined;
      const started = generation;
      entry.pending = exchange(session).then((credentials) => {
        if (started !== generation) throw new Error('Sign-in session changed');
        if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.sessionToken
            || !(credentials.expiration.getTime() > now() + 60_000)) throw new Error('Temporary credentials unavailable or expired');
        entry.credentials = credentials;
        return credentials;
      }).finally(() => {
        entry.pending = undefined;
        if (!entry.credentials && entries.get(key) === entry) entries.delete(key);
      });
      // Bound retained tokens when sessions refresh or multiple accounts are used.
      if (entries.size >= 8 && !entries.has(key)) entries.delete(entries.keys().next().value!);
      entries.set(key, entry);
      return entry.pending;
    },
  };
}
