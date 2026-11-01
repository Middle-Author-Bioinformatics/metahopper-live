import { defineStorage } from '@aws-amplify/backend';
import { PROJECTS, STAFF_GROUP } from '../../project';
export const storage = defineStorage({
  name: 'metahopperReports',
  isDefault: true,
  access: (allow) => Object.fromEntries(PROJECTS.map((project) => [
    `${project.prefix}*`, [allow.groups([project.group, STAFF_GROUP]).to(['read'])],
  ])),
});
