'use strict';

// Installs (or removes) the per-user macOS Quick Actions "New Mullion
// Terminal Tab Here" and "New Mullion Terminal Window Here" at
// ~/Library/Services. Finder lists them under right-click → Quick Actions
// (and the Services menu) for any file or folder, whatever its type — unlike
// "Open With", which only offers apps that claim the item's UTI.
//
// Each action hands the selected items to the app as one
// `mullion-terminal://open?mode=tab|window&path=…` link (see open-url.cjs),
// because `open -a` can't pass an "open in a new window" flag to an app
// that's already running.
//
// Only a bundle carrying the `MullionTerminalQuickAction` marker in its
// Contents/Info.plist is ever overwritten or deleted; anything else under
// ~/Library/Services — including an unrelated bundle that happens to share
// a name — is left untouched. The single "Open in Mullion Terminal" action
// earlier releases installed is removed (again, only if it carries the
// marker) whenever the new ones are installed or removed.

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const QUICK_ACTIONS = Object.freeze([
  Object.freeze({ mode: 'tab', name: 'New Mullion Terminal Tab Here', workflow: 'New Mullion Terminal Tab Here.workflow' }),
  Object.freeze({ mode: 'window', name: 'New Mullion Terminal Window Here', workflow: 'New Mullion Terminal Window Here.workflow' }),
]);
const LEGACY_WORKFLOW_NAME = 'Open in Mullion Terminal.workflow';
const MARKER_KEY = 'MullionTerminalQuickAction';
const BUNDLE_ID = 'dev.mullion.terminal';
const PBS_PATH = '/System/Library/CoreServices/pbs';
const COMMAND_KEY_PATH = 'actions.0.action.ActionParameters.COMMAND_STRING';

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

function quickAction(mode) {
  const action = QUICK_ACTIONS.find(item => item.mode === mode);
  if (!action) throw new Error(`Unknown Quick Action mode: ${mode}`);
  return action;
}

/** Where a template bundle ships: next to this module from source, under `process.resourcesPath` once packaged. */
function templateDirectory({ mode = 'tab', isPackaged = false, resourcesPath = process.resourcesPath } = {}) {
  const { workflow } = quickAction(mode);
  return isPackaged ? path.join(resourcesPath, workflow) : path.join(__dirname, 'resources', workflow);
}

function workflowPath(mode = 'tab', homeDir = os.homedir()) {
  return path.join(homeDir, 'Library', 'Services', quickAction(mode).workflow);
}

function legacyWorkflowPath(homeDir = os.homedir()) {
  return path.join(homeDir, 'Library', 'Services', LEGACY_WORKFLOW_NAME);
}

/**
 * The zsh script a Quick Action runs on Finder's selection. Every selected
 * path is percent-encoded byte by byte (no python/perl dependency) into one
 * link per batch of ten, which the app validates before acting on it. With
 * `appPath` it targets that exact copy of the app (other copies can share its
 * bundle id); without, it targets the bundle id.
 *
 * @param {{ mode: 'tab' | 'window', appPath?: string }} options
 */
function quickActionScript({ mode, appPath } = {}) {
  quickAction(mode);
  const opener = appPath ? `open -a '${appPath.replace(/'/g, `'\\''`)}'` : `open -b ${BUNDLE_ID}`;
  return [
    'encode() {',
    '  setopt localoptions nomultibyte',
    '  local LC_ALL=C value=$1 encoded= char index',
    '  for (( index = 1; index <= ${#value}; index++ )); do',
    '    char=${value[index]}',
    '    case $char in',
    '      [A-Za-z0-9._~/-]) encoded+=$char ;;',
    "      *) encoded+=$(printf '%%%02X' \"'$char\") ;;",
    '    esac',
    '  done',
    '  print -r -- $encoded',
    '}',
    `base='mullion-terminal://open?mode=${mode}'`,
    'url=$base',
    'count=0',
    'for item in "$@"; do',
    '  url+="&path=$(encode "$item")"',
    '  (( ++count % 10 == 0 )) && { ' + opener + ' "$url"; url=$base; }',
    'done',
    '(( count % 10 )) && ' + opener + ' "$url"',
    'exit 0',
  ].join('\n');
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

/** Deletes the single Quick Action earlier releases installed, only if it carries our marker. */
async function removeLegacy(homeDir) {
  const legacy = legacyWorkflowPath(homeDir);
  if (!(await exists(legacy)) || !(await isOurBundle(legacy))) return false;
  await fs.rm(legacy, { recursive: true, force: true });
  return true;
}

async function installOne({ mode, templateDir, appPath, homeDir }) {
  if (!templateDir || !(await isOurBundle(templateDir))) return { mode, installed: false, reason: 'missing-template' };
  const destination = workflowPath(mode, homeDir);
  if (await exists(destination) && !(await isOurBundle(destination))) return { mode, installed: false, reason: 'foreign-bundle', path: destination };
  const services = path.dirname(destination);
  await fs.mkdir(services, { recursive: true });
  // Stage beside the destination, then swap it in, so a failed copy never
  // leaves a half-written bundle where Finder looks.
  const staging = path.join(services, `.${path.basename(destination)}.${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.cp(templateDir, staging, { recursive: true, force: true, errorOnExist: false });
    if (appPath) await run('/usr/bin/plutil', ['-replace', COMMAND_KEY_PATH, '-string', quickActionScript({ mode, appPath }), path.join(staging, 'Contents', 'document.wflow')]);
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(staging, destination);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return { mode, installed: true, path: destination };
}

/**
 * Copies both template bundles to ~/Library/Services and removes the legacy
 * one. Idempotent: an existing marked bundle is replaced; an unmarked one of
 * the same name is left alone. `templateDirs` maps each mode to its template;
 * by default they're looked up next to this module.
 *
 * @param {{ templateDirs?: { tab?: string, window?: string }, appPath?: string, homeDir?: string, platform?: string, refresh?: () => Promise<object> }} options
 */
async function installFinderQuickActions({ templateDirs, appPath, homeDir = os.homedir(), platform = process.platform, refresh = refreshServices } = {}) {
  if (platform !== 'darwin') return { installed: false, reason: 'unsupported-platform' };
  const dirs = templateDirs ?? { tab: templateDirectory({ mode: 'tab' }), window: templateDirectory({ mode: 'window' }) };
  const actions = [];
  for (const { mode } of QUICK_ACTIONS) actions.push(await installOne({ mode, templateDir: dirs[mode], appPath, homeDir }));
  const legacyRemoved = await removeLegacy(homeDir);
  const changed = legacyRemoved || actions.some(action => action.installed);
  return { installed: actions.every(action => action.installed), actions, legacyRemoved, ...(changed ? await refresh() : {}) };
}

/**
 * Deletes both installed bundles and the legacy one, each only if it carries
 * our marker. Idempotent.
 *
 * @param {{ homeDir?: string, platform?: string, refresh?: () => Promise<object> }} [options]
 */
async function removeFinderQuickActions({ homeDir = os.homedir(), platform = process.platform, refresh = refreshServices } = {}) {
  if (platform !== 'darwin') return { removed: false, reason: 'unsupported-platform' };
  const actions = [];
  for (const { mode } of QUICK_ACTIONS) {
    const destination = workflowPath(mode, homeDir);
    if (!(await exists(destination))) actions.push({ mode, removed: false, reason: 'not-installed', path: destination });
    else if (!(await isOurBundle(destination))) actions.push({ mode, removed: false, reason: 'foreign-bundle', path: destination });
    else {
      await fs.rm(destination, { recursive: true, force: true });
      actions.push({ mode, removed: true, path: destination });
    }
  }
  const legacyRemoved = await removeLegacy(homeDir);
  const changed = legacyRemoved || actions.some(action => action.removed);
  return { removed: actions.some(action => action.removed), actions, legacyRemoved, ...(changed ? await refresh() : {}) };
}

module.exports = {
  installFinderQuickActions, removeFinderQuickActions, quickActionScript, templateDirectory, workflowPath, legacyWorkflowPath,
  QUICK_ACTIONS, LEGACY_WORKFLOW_NAME, MARKER_KEY,
};
