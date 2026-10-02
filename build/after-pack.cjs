'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Without a Developer ID certificate electron-builder leaves only the linker's
// signature on the main binary, and macOS reports a downloaded copy as
// "damaged". Seal the whole bundle with an ad-hoc signature instead.
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
