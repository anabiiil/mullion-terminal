'use strict';

// Installs (or removes) the per-user macOS Quick Action "Open in Mullion
// Terminal" at ~/Library/Services. Finder lists it under right-click → Quick
// Actions (and the Services menu) for any file or folder, whatever its type —
// unlike "Open With", which only offers apps that claim the item's UTI.
//
// Only a bundle carrying the `MullionTerminalQuickAction` marker in its
// Contents/Info.plist is ever overwritten or deleted; anything else under
// ~/Library/Services — including an unrelated bundle that happens to share
// the name — is left untouched.

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const WORKFLOW_NAME = 'Open in Mullion Terminal.workflow';
const MARKER_KEY = 'MullionTerminalQuickAction';
const PBS_PATH = '/System/Library/CoreServices/pbs';

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

/** Where the template bundle ships: next to this module from source, under `process.resourcesPath` once packaged. */
function templateDirectory({ isPackaged = false, resourcesPath = process.resourcesPath } = {}) {
  return isPackaged ? path.join(resourcesPath, WORKFLOW_NAME) : path.join(__dirname, 'resources', WORKFLOW_NAME);
}

function workflowPath(homeDir = os.homedir()) {
  return path.join(homeDir, 'Library', 'Services', WORKFLOW_NAME);
}

async function exists(target) {
  try { await fs.lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** True only when `bundle` is a real directory whose Info.plist (XML or binary) has the marker key set to true. */
async function isOurBundle(bundle) {
  try {
    if (!(await fs.lstat(bundle)).isDirectory()) return false;
    const json = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', path.join(bundle, 'Contents', 'Info.plist')]);
    return JSON.parse(json)?.[MARKER_KEY] === true;
  } catch {
    return false;
  }
}

/** Asks the pasteboard server to rescan Services so Finder picks up the change without a logout. Best-effort. */
async function refreshServices() {
  try {
    await run(PBS_PATH, ['-update']);
    return { refreshed: true };
  } catch (error) {
    return { refreshed: false, refreshError: error.message };
  }
}

/**
 * Copies the template bundle to ~/Library/Services. Idempotent: an existing
 * marked bundle is replaced; an unmarked one of the same name is left alone.
 *
 * @param {{ templateDir: string, appPath?: string, homeDir?: string, platform?: string, refresh?: () => Promise<object> }} options
 */
async function installFinderQuickAction({ templateDir, appPath, homeDir = os.homedir(), platform = process.platform, refresh = refreshServices } = {}) {
  if (platform !== 'darwin') return { installed: false, reason: 'unsupported-platform' };
  if (!templateDir || !(await isOurBundle(templateDir))) return { installed: false, reason: 'missing-template' };
  const destination = workflowPath(homeDir);
  if (await exists(destination) && !(await isOurBundle(destination))) return { installed: false, reason: 'foreign-bundle', path: destination };
  const services = path.dirname(destination);
  await fs.mkdir(services, { recursive: true });
  // Stage beside the destination, then swap it in, so a failed copy never
  // leaves a half-written bundle where Finder looks.
  const staging = path.join(services, `.${WORKFLOW_NAME}.${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.cp(templateDir, staging, { recursive: true, force: true, errorOnExist: false });
    // Other copies of the app can share its bundle id, so point at this one.
    if (appPath) await run('/usr/bin/plutil', ['-replace', 'actions.0.action.ActionParameters.COMMAND_STRING', '-string',
      `open -a '${appPath.replace(/'/g, `'\\''`)}' "$@"`, path.join(staging, 'Contents', 'document.wflow')]);
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(staging, destination);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return { installed: true, path: destination, ...(await refresh()) };
}

/**
 * Deletes the installed bundle, only if it carries our marker. Idempotent.
 *
 * @param {{ homeDir?: string, platform?: string, refresh?: () => Promise<object> }} [options]
 */
async function removeFinderQuickAction({ homeDir = os.homedir(), platform = process.platform, refresh = refreshServices } = {}) {
  if (platform !== 'darwin') return { removed: false, reason: 'unsupported-platform' };
  const destination = workflowPath(homeDir);
  if (!(await exists(destination))) return { removed: false, reason: 'not-installed', path: destination };
  if (!(await isOurBundle(destination))) return { removed: false, reason: 'foreign-bundle', path: destination };
  await fs.rm(destination, { recursive: true, force: true });
  return { removed: true, path: destination, ...(await refresh()) };
}

module.exports = { installFinderQuickAction, removeFinderQuickAction, templateDirectory, workflowPath, WORKFLOW_NAME, MARKER_KEY };
