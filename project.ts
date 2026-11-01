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
// Cognito uses the first matching group's role. Staff must take precedence.
export const AUTH_GROUPS = [STAFF_GROUP, ...PROJECTS.map((project) => project.group)];

export function projectsForGroups(groups: unknown): readonly Project[] {
  if (!Array.isArray(groups)) return [];
  if (groups.includes(STAFF_GROUP)) return PROJECTS;
  // Match Cognito role precedence; client-group permissions are not unioned.
  const project = PROJECTS.find((item) => groups.includes(item.group));
  return project ? [project] : [];
}
