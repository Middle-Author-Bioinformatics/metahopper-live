import { defineStorage } from '@aws-amplify/backend';
import { PROJECT } from '../../project';
export const storage = defineStorage({
  name: 'metahopperReports',
  isDefault: true,
  access: (allow) => ({ [`${PROJECT.prefix}*`]: [allow.groups([PROJECT.group]).to(['read'])] }),
});
