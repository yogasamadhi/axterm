'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */

// Electerm 5.5.0 synchronously invokes macOS `security find-certificate` with
// the login keychain during startup. Reference capture needs no network trust
// store and must never trigger a system keychain prompt.
if (process.env.AXTERM_ELECTERM_PARITY === '1') {
  const childProcess = require('node:child_process');
  const Module = require('node:module');
  const originalExecSync = childProcess.execSync;
  const originalModuleLoad = Module._load;
  childProcess.execSync = function execSyncWithoutKeychain(command, options) {
    if (typeof command === 'string' && command.startsWith('security find-certificate ')) {
      return options?.encoding ? '' : Buffer.alloc(0);
    }
    return originalExecSync.apply(this, arguments);
  };
  Module._load = function loadWithoutSystemCredentialStore(request, parent, isMain) {
    let resolved = '';
    try {
      resolved = Module._resolveFilename(request, parent, isMain).replaceAll('\\', '/');
    } catch {
      // Preserve Node's normal error for unresolved modules.
    }
    if (resolved.endsWith('/work/app/lib/safe-storage.js')) {
      return {
        safeEncrypt: (value) => value,
        safeDecrypt: (value) => value,
      };
    }
    return originalModuleLoad.apply(this, arguments);
  };
}
