import { auditOwnedClients } from './audit-owned-client.mjs';
if (process.argv.includes('--write-baseline'))
  throw new Error(
    'The owned Client gate requires zero bare CJK literals; its rule has no writable baseline.',
  );
console.log('Owned Client localization literals:', await auditOwnedClients(undefined, 'literals'));
