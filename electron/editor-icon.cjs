'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Read the app's declared icon rather than Finder's generic bundle association.
 * The caller passes a discovered app bundle (or a CLI resolved to that bundle).
 * Conversion uses macOS system tools with literal arguments and owned temporary
 * output. Failures return undefined so the UI can use its branded vector icon.
 * createEditorService caches this result per installed app target.
 */
async function loadMacApplicationIcon(target, { fileSystem = fs, runFile = run, temporaryRoot = os.tmpdir() } = {}) {
  let ownedDirectory;
  try {
    if (typeof target !== 'string' || !path.isAbsolute(target) || !/\.app$/i.test(target)) return undefined;
    const bundle = await fileSystem.realpath(target);
    if (!(await fileSystem.stat(bundle)).isDirectory()) return undefined;
    const plist = path.join(bundle, 'Contents', 'Info.plist');
    const plistStat = await fileSystem.stat(plist);
    if (!plistStat.isFile() || plistStat.size > 2_097_152) return undefined;
    const extracted = await runFile('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', plist], {
      shell: false, timeout: 5_000, maxBuffer: 4_096, windowsHide: true,
    });
    const name = String(extracted.stdout ?? '').trim();
    if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name)) return undefined;
    const filename = path.extname(name) ? name : `${name}.icns`;
    const resources = await fileSystem.realpath(path.join(bundle, 'Contents', 'Resources'));
    const iconPath = await fileSystem.realpath(path.join(resources, filename));
    // A declared icon is a single resource basename, never a caller-controlled path.
    if (path.dirname(iconPath) !== resources) return undefined;
    const iconStat = await fileSystem.stat(iconPath);
    if (!iconStat.isFile() || iconStat.size > 33_554_432) return undefined;
    ownedDirectory = await fileSystem.mkdtemp(path.join(temporaryRoot, 'mullion-editor-icon-'));
    const output = path.join(ownedDirectory, 'icon.png');
    await runFile('/usr/bin/sips', ['-s', 'format', 'png', iconPath, '--out', output, '-Z', '64'], {
      shell: false, timeout: 10_000, maxBuffer: 8_192, windowsHide: true,
    });
    const png = await fileSystem.readFile(output);
    if (png.length > 1_500_000 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return undefined;
  } finally {
    if (ownedDirectory) await fileSystem.rm(ownedDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { loadMacApplicationIcon };
