export interface Project {
  id: string;
  name: string;
  group: string;
  prefix: string;
}

export const PROJECTS: readonly Project[] = [
  { id: 'phoridae', name: 'Phoridae', group: 'phoridae-viewers', prefix: 'reports/phoridae/' },
  { id: 'aphrophora', name: 'Aphrophora', group: 'aphrophora-viewers', prefix: 'reports/aphrophora/' },
  { id: 'sample-reports', name: 'Sample reports', group: 'sample-reports', prefix: 'reports/sample-reports/' },
];
export const STAFF_GROUP = 'metahopper-admins';
export const POLL_MS = 30_000;
// Preserve existing Cognito default-role precedence. Storage requests explicitly
// select an assigned project's role when a client belongs to multiple groups.
export const AUTH_GROUPS = [STAFF_GROUP, ...PROJECTS.map((project) => project.group)];

export function projectsForGroups(groups: unknown): readonly Project[] {
  if (!Array.isArray(groups)) return [];
  if (groups.includes(STAFF_GROUP)) return PROJECTS;
  return PROJECTS.filter((item) => groups.includes(item.group));
}
