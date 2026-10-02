// Downloads the Electron binary, then rebuilds native modules for Electron.
//
// Both run through this Node process directly rather than through npm's .bin
// shims: on Windows a shim invokes `node "<project path>\…"`, which cmd.exe
// splits at the first space in the project path whenever `node` resolves to a
// .cmd wrapper (as with Node version managers).
//
// Windows skips the rebuild: node-pty is an N-API module that ships prebuilt
// win32-x64/arm64 binaries usable by any Electron version, while rebuilding it
// needs Python and the Visual Studio C++ tools, which most machines lack.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const run = (script, args = []) => execFileSync(process.execPath, [script, ...args], { stdio: 'inherit' });

run(path.join(path.dirname(require.resolve('electron/package.json')), 'install.js'));
if (process.platform !== 'win32') run(path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js'), ['install-app-deps']);
