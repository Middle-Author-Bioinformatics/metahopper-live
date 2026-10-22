import { defineAuth } from '@aws-amplify/backend';
import { AUTH_GROUPS } from '../../project';
export const auth = defineAuth({ loginWith: { email: true }, groups: AUTH_GROUPS });
