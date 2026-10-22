import { defineAuth } from '@aws-amplify/backend';
import { PROJECT } from '../../project';
export const auth = defineAuth({ loginWith: { email: true }, groups: [PROJECT.group] });
