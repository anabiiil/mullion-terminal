'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, screen, shell: desktopShell, session: electronSession } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const EDITOR_PROCESS = /^(?:n?vim|vi|view|r?nano|pico)$/i;
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { randomUUID, randomBytes } = require('node:crypto');
const pty = require('node-pty');
const { LocalStore } = require('./store.cjs');
const { PromptParser } = require('./osc.cjs');
const { defaultEnvironment, prepareShell, navigationRequest } = require('./shell.cjs');
const { complete } = require('./completions.cjs');
const { hiddenNames } = require('./hidden-files.cjs');
const { SubmissionTracker } = require('./submissions.cjs');
const { createEditorService } = require('./editors.cjs');
const { createGitStatusService } = require('./git-status.cjs');
const { pathsFromArgv, resolveOpenTarget, openModeFromArgv, urlsFromArgv } = require('./open-paths.cjs');
const { PROTOCOL, parseOpenUrl, createRateLimiter } = require('./open-url.cjs');
const { installFinderQuickActions, removeFinderQuickActions, templateDirectory } = require('./finder-service.cjs');
const { writeShellThemes } = require('./appearance.cjs');

app.setName('Mullion Terminal');
// Every pty session records the webContents id of the window that owns it:
// its output, state and exit go only to that window, and only that window
// may write to, resize, navigate or close it.
const sessions = new Map();
// webContents id -> { id, window, ready, pending }. Map order doubles as
// focus order: a window moves to the end whenever it gains focus, so the
// last entry is the most recently focused (or created) window.
const windows = new Map();
const MAX_WINDOWS = 20;
const MAX_SESSIONS_PER_WINDOW = 20;
const MAX_SESSIONS = 60;
const CASCADE_OFFSET = 28;
let store;
let integrationRoot;
let quitting = false;
const home = os.homedir();
const editorService = createEditorService({ platform: process.platform, home, getIcon: async target => {
  try {
    if (process.platform === 'darwin') return await require('./editor-icon.cjs').loadMacApplicationIcon(target);
    const icon = await app.getFileIcon(target, { size: 'normal' });
    return icon.isEmpty() ? undefined : icon.toDataURL();
  } catch { return undefined; }
} });
const gitStatusService = createGitStatusService();
const requestedStartupDirectory = app.commandLine.getSwitchValue('cwd');
const startupDirectory = requestedStartupDirectory ? resolvedPath(requestedStartupDirectory, process.cwd()) : home;
const distUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
const development = !app.isPackaged && process.env.TERMINAL_DEV_URL === 'http://127.0.0.1:5173';
const appUrl = development ? 'http://127.0.0.1:5173/' : distUrl;

// Explicit CLI profiles get their own preferences and single-instance lock.
const requestedUserData = app.commandLine.getSwitchValue('user-data-dir');
if (requestedUserData) {
  const testingDirectory = path.resolve(requestedUserData);
  require('node:fs').mkdirSync(testingDirectory, { recursive: true, mode: 0o700 });
  app.setPath('userData', testingDirectory);
}

// Keeps the macOS "New Mullion Terminal Tab/Window Here" Quick Actions in
// step with the setting. Fire-and-forget: a failure here must never block
// startup or a settings save. Runs are chained so quick toggles apply in order.
let finderQuickActionQueue = Promise.resolve();
function syncFinderQuickAction(settings) {
  // Dev and test runs must not touch the user's real ~/Library/Services.
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  const enabled = settings?.finderQuickAction !== false;
  const templateDirs = { tab: templateDirectory({ mode: 'tab', isPackaged: true }), window: templateDirectory({ mode: 'window', isPackaged: true }) };
  finderQuickActionQueue = finderQuickActionQueue.then(() => enabled
    ? installFinderQuickActions({ templateDirs, appPath: path.resolve(process.execPath, '../../..') })
    : removeFinderQuickActions()
  ).catch(error => console.warn('Could not update the Finder Quick Actions:', error.message));
}

// The prompt colors every shell re-reads at its next prompt (see appearance.cjs). Writes are
// chained so a burst of saves lands in order; a failure only leaves the previous colors.
let shellThemeQueue = Promise.resolve();
function syncShellThemes(settings) {
  if (!integrationRoot) return shellThemeQueue;
  shellThemeQueue = shellThemeQueue.then(() => writeShellThemes(integrationRoot, settings.appearance))
    .catch(error => console.warn('Could not update the prompt colors:', error.message));
  return shellThemeQueue;
}

// "Open with Mullion Terminal" (Finder/Explorer/file-manager right-click, a
// file or folder dropped on the Dock icon, a `mullion-terminal://open` link
// from a Quick Action, or `mullion-terminal <path>` from a shell) — a folder
// opens a tab there, a file opens a tab in its parent folder and then opens
// the file the same way the tree's double-click does. A request either adds
// tabs to the most recently focused window ("tab") or opens a new window
// whose only tabs are its targets ("window"); without an explicit mode the
// `openWithTarget` setting decides. Requests that arrive before the app is
// ready (a launch's own argv, macOS's early 'open-file'/'open-url') wait in
// `startupRequests`; targets for a window whose renderer hasn't bootstrapped
// yet wait in that window's `pending` list (see the `bootstrap` handler).
let started = false;
const startupRequests = [];
function openTargets(targets, mode = null) {
  if (!targets.length) return;
  if (!started) { startupRequests.push({ targets, mode }); return; }
  const target = mode ?? store.snapshot().settings.openWithTarget;
  const recent = mostRecentWindow();
  if (!recent || (target === 'window' && windows.size < MAX_WINDOWS)) { createWindow({ targets }); return; }
  if (recent.ready) for (const item of targets) sendOpenPath(recent, item);
  else recent.pending.push(...targets);
  showWindow(recent.window);
}
function sendOpenPath(record, target) {
  if (target.isDirectory) sendTo(record.id, { type: 'open-path', path: target.path, isDirectory: true });
  else sendTo(record.id, { type: 'open-path', path: path.dirname(target.path), isDirectory: false, filePath: target.path });
}
function flushPendingOpenPaths(record) {
  if (!record.ready || !windows.has(record.id) || !record.pending.length) return;
  for (const target of record.pending.splice(0, record.pending.length)) sendOpenPath(record, target);
}
// Links can be triggered by any web page, so besides parseOpenUrl's strict
// validation a burst of them is capped rather than opening without bound.
const allowOpenUrl = createRateLimiter({ limit: 8, interval: 10000 });
function openUrl(value) {
  if (!allowOpenUrl()) { console.warn('Ignored a mullion-terminal link: too many in a short time.'); return; }
  const request = parseOpenUrl(value);
  if (!request) { console.warn('Ignored an invalid mullion-terminal link.'); return; }
  openTargets(request.targets, request.mode);
}
// A CLI launch (`mullion-terminal [--open-mode=tab|window] <path>…`, Windows
// Explorer's verbs, a Linux file manager) hands its paths as plain argv; on
// Windows a `mullion-terminal://` link arrives the same way.
// Returns whether the argv asked for anything.
function openFromArgv(argv, cwd) {
  const urls = urlsFromArgv(argv, { isPackaged: app.isPackaged });
  for (const url of urls) openUrl(url);
  const targets = pathsFromArgv(argv, { cwd, isPackaged: app.isPackaged });
  const mode = openModeFromArgv(argv);
  openTargets(targets, mode);
  if (urls.length || targets.length) return true;
  // `--open-mode=window` with nothing to open (the Linux launcher's "New
  // Window" action) asks for a fresh window at Home.
  if (mode === 'window' && started && windows.size < MAX_WINDOWS) { createWindow(); return true; }
  return false;
}
openFromArgv(process.argv, process.cwd());
// macOS hands Finder's "Open With" and a Dock drop through 'open-file', and
// links through 'open-url'; both can fire before 'ready', so the listeners
// must exist already.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  const target = resolveOpenTarget(filePath, process.cwd());
  if (target) openTargets([target]);
});
app.on('open-url', (event, url) => {
  event.preventDefault();
  openUrl(url);
});

function trustedUrl(value) {
  if (development) {
    try { return new URL(value).origin === 'http://127.0.0.1:5173'; } catch { return false; }
  }
  return value.split('#')[0] === distUrl;
}

/** Returns the window record for an IPC sender that is one of our windows' main frames, or throws. */
function assertSender(event) {
  const record = windows.get(event.sender?.id);
  if (!record || record.window.isDestroyed() || event.sender !== record.window.webContents || event.senderFrame !== record.window.webContents.mainFrame || !trustedUrl(event.senderFrame.url)) throw new Error('Unauthorized terminal request.');
  return record;
}

function text(value, maximum = 32768) {
  if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0')) throw new Error('Invalid text argument.');
  return value;
}

const MAX_PREVIEW_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_IMAGE_BYTES = 8 * 1024 * 1024;
const EXTERNAL_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const PREVIEW_IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

function resolvedPath(value, base = home) {
  const input = text(value);
  return path.resolve(base, input === '~' ? home : input.startsWith(`~${path.sep}`) ? path.join(home, input.slice(2)) : input);
}

/** A live session owned by `owner` (a window record); another window's session is treated as ended. */
function getSession(id, owner) {
  text(id, 64);
  const session = sessions.get(id);
  if (!session || !session.info.alive || session.owner !== owner.id) throw new Error('This terminal session has ended.');
  return session;
}

function sendTo(windowId, event) {
  const record = windows.get(windowId);
  if (record && !record.window.isDestroyed() && !record.window.webContents.isDestroyed()) record.window.webContents.send('terminal:event', event);
}

/** Shared state (history, settings) goes to every window, optionally except the one that changed it. */
function broadcast(event, exceptId) {
  for (const id of windows.keys()) if (id !== exceptId) sendTo(id, event);
}

function state(session) { sendTo(session.owner, { type: 'state', session: { ...session.info } }); }

// Remembers a directory the user actually navigated to, so a full previously visited path can
// be suggested later (not just its next segment). Disk failures must never interrupt a running
// shell, so this is always fire-and-forget.
function rememberDirectory(directory) {
  store.recordDirectory(directory).catch(error => console.error('Could not save visited directory:', error.message));
}

function ready(session, value) {
  if (session.info.ready === value) return;
  session.info.ready = value;
  state(session);
}

function write(session, data, submittedCommand, record) {
  if (session.navigationPending) {
    session.navigationPending.input.push({ data, submittedCommand, record });
    return;
  }
  // Readline owns editing, history navigation, signals, and interactive programs.
  // Any submitted line or Ctrl-C is busy until the real shell renders a prompt.
  if (session.info.ready && /[\r\n]/.test(data)) session.submissions.submit(data === '\r' ? submittedCommand : undefined, { record });
  if (/[\r\n\x03]/.test(data)) ready(session, false);
  session.pty.write(data);
}

function finishNavigation(session, error) {
  const request = session.navigationPending;
  if (!request) return;
  clearTimeout(request.timeout);
  session.navigationPending = null;
  // Successful widgets already remove their request. On failure, hold off the
  // next request until cleanup finishes so it cannot delete a newer target.
  if (error) session.navigationCleanup = fs.unlink(session.navigationFile).catch(() => {});
  if (error) request.reject(error);
  else request.resolve();
  // Flush only after the widget's prompt redraw has reached the renderer.
  setImmediate(() => {
    if (!session.info.alive) return;
    for (const input of request.input) {
      // On failure retain typed text for inspection rather than execute a queued
      // Enter in the directory the user was trying to leave.
      const data = error ? input.data.replace(/[\r\n]/g, '') : input.data;
      if (data) write(session, data, error ? undefined : input.submittedCommand, error ? undefined : input.record);
    }
  });
}

async function createSession(owner, directory = startupDirectory) {
  if (sessions.size >= MAX_SESSIONS || [...sessions.values()].filter(item => item.owner === owner.id).length >= MAX_SESSIONS_PER_WINDOW) throw new Error('Close a terminal tab before opening another one.');
  const cwd = resolvedPath(directory);
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error('The selected path is not a directory.');
  rememberDirectory(cwd);
  const id = randomUUID();
  const nonce = randomBytes(24).toString('hex');
  const integrationDirectory = path.join(integrationRoot, id);
  const launch = await prepareShell({ directory: integrationDirectory, nonce, home, env: defaultEnvironment(home), themeDirectory: integrationRoot });
  let terminalProcess;
  try {
    terminalProcess = pty.spawn(launch.shell, launch.args, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: launch.env, useConpty: true });
  } catch (error) {
    await fs.rm(integrationDirectory, { recursive: true, force: true });
    throw new Error(`Could not start ${path.basename(launch.shell)}: ${error.message}`);
  }
  if (!windows.has(owner.id)) {
    // The window closed while the shell was being prepared.
    try { terminalProcess.kill(); } catch {}
    await fs.rm(integrationDirectory, { recursive: true, force: true });
    throw new Error('The window was closed.');
  }
  const session = {
    owner: owner.id,
    pty: terminalProcess,
    info: { id, cwd, shell: path.basename(launch.shell), platform: process.platform, ready: false, alive: true, lineReset: launch.lineReset },
    environmentPath: launch.env.PATH || '',
    integrationDirectory,
    navigationFile: launch.navigationFile,
    navigationSequence: launch.navigationSequence,
    navigationAvailable: false,
    navigationPending: null,
  };
  session.submissions = new SubmissionTracker((command, options) => {
    store.record(command, session.info.cwd, options).then(history => broadcast({ type: 'history', history })).catch(error => {
      // Disk failures must not interrupt a running shell.
      console.error('Could not save command history:', error.message);
    });
  });
  const parser = new PromptParser(nonce, prompt => {
    if (!session.info.alive) return;
    if (prompt.ready) session.submissions.finish(prompt.status);
    if (prompt.ready && path.isAbsolute(prompt.cwd)) {
      const normalized = path.normalize(prompt.cwd);
      if (normalized !== session.info.cwd) rememberDirectory(normalized);
      session.info.cwd = normalized;
    }
    if (typeof prompt.path === 'string') session.environmentPath = prompt.path;
    if (typeof prompt.navigation === 'boolean') session.navigationAvailable = prompt.navigation;
    session.info.ready = prompt.ready;
    state(session);
  }, command => {
    session.submissions.hook(command);
  }, navigation => {
    if (navigation.requestId !== session.navigationPending?.requestId) return;
    if (navigation.success && path.isAbsolute(navigation.cwd)) {
      const normalized = path.normalize(navigation.cwd);
      if (normalized !== session.info.cwd) rememberDirectory(normalized);
      session.info.cwd = normalized;
      state(session);
      finishNavigation(session);
    } else finishNavigation(session, new Error('Could not change directories. Check the folder permissions.'));
  });
  sessions.set(id, session);
  terminalProcess.onData(data => {
    const output = parser.feed(data);
    if (output) sendTo(session.owner, { type: 'data', id, data: output });
  });
  terminalProcess.onExit(({ exitCode }) => {
    finishNavigation(session, new Error('This terminal session has ended.'));
    session.submissions.finish();
    const remaining = parser.flush();
    if (remaining) sendTo(session.owner, { type: 'data', id, data: remaining });
    session.info.alive = false;
    session.info.ready = false;
    state(session);
    sendTo(session.owner, { type: 'exit', id, exitCode });
    sessions.delete(id);
    fs.rm(integrationDirectory, { recursive: true, force: true }).catch(() => {});
  });
  return { ...session.info };
}

function closeSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  session.submissions.finish();
  session.info.alive = false;
  finishNavigation(session, new Error('This terminal session has ended.'));
  session.info.ready = false;
  try { session.pty.kill(); } catch {}
  sessions.delete(id);
  fs.rm(session.integrationDirectory, { recursive: true, force: true }).catch(() => {});
}

function closeWindowSessions(windowId) {
  for (const [id, session] of [...sessions]) if (session.owner === windowId) closeSession(id);
}

function registerIpc() {
  // Every handler receives the calling window's record first.
  function handle(channel, handler) {
    ipcMain.handle(`terminal:${channel}`, (event, ...args) => handler(assertSender(event), ...args));
  }
  // History is shared by every window: whichever one changed it, the others follow.
  const sharedHistory = owner => history => { broadcast({ type: 'history', history }, owner.id); return history; };
  handle('bootstrap', owner => {
    // The renderer's bootstrap call is also its "I'm ready for events" signal:
    // any open-path targets queued for this window before now (startup argv,
    // a Finder 'open-file', or the request that opened this window) are
    // flushed right after, once this response's listeners are certainly attached.
    const openPathCount = owner.pending.length;
    owner.ready = true;
    setImmediate(() => flushPendingOpenPaths(owner));
    // Visited directories are an internal completion-ranking signal (merged into `completions`
    // results in the main process); they never need to cross into the renderer.
    const { directories: _directories, ...snapshot } = store.snapshot();
    return { home, platform: process.platform, openPathCount, ...snapshot };
  });
  handle('create-session', (owner, directory) => createSession(owner, directory));
  handle('close-session', (owner, id) => {
    text(id, 64);
    if (sessions.get(id)?.owner === owner.id) closeSession(id);
  });
  handle('new-window', () => {
    if (windows.size >= MAX_WINDOWS) throw new Error('Close a window before opening another one.');
    createWindow();
  });
  handle('change-directory', async (owner, id, directory) => {
    const session = getSession(id, owner);
    if (!session.info.ready) throw new Error('Wait until the command finishes before changing directories.');
    if (session.navigationCleanup) await session.navigationCleanup;
    const cwd = resolvedPath(directory, session.info.cwd);
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error('The selected path is not a directory.');
    if (!session.info.ready || !session.info.alive) throw new Error('The shell is busy.');
    if (!session.navigationAvailable) throw new Error('Folder navigation requires the shell line editor. Enable ZLE, Readline, or PSReadLine.');
    if (session.navigationPending) throw new Error('A folder change is already in progress.');
    const requestId = randomUUID();
    let resolve;
    let reject;
    const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Observe rejection immediately if an asynchronous file write races exit.
    completion.catch(() => {});
    session.navigationPending = { requestId, resolve, reject, input: [], timeout: setTimeout(() => {
      finishNavigation(session, new Error('The shell did not accept the folder change. Its navigation key binding may have been changed.'));
    }, 5000) };
    const temporary = path.join(session.integrationDirectory, `.navigation-${requestId}.tmp`);
    try {
      await fs.writeFile(temporary, navigationRequest(requestId, cwd), { mode: 0o600 });
      if (!session.info.alive || session.navigationPending?.requestId !== requestId) throw new Error('This terminal session has ended.');
      await fs.rename(temporary, session.navigationFile);
      if (!session.info.alive || session.navigationPending?.requestId !== requestId) throw new Error('The folder change was canceled.');
      session.pty.write(session.navigationSequence);
    } catch (error) { finishNavigation(session, error); }
    finally { fs.unlink(temporary).catch(() => {}); }
    return completion;
  });
  handle('list-directory', async (_owner, directory, showHidden = false) => {
    if (typeof showHidden !== 'boolean') throw new Error('Invalid visibility setting.');
    const folder = resolvedPath(directory);
    const [entries, hidden] = await Promise.all([fs.readdir(folder, { withFileTypes: true }), showHidden ? new Set() : hiddenNames(folder)]);
    const visible = entries.filter(entry => showHidden || (!entry.name.startsWith('.') && !hidden.has(entry.name))).slice(0, 5000);
    const output = await Promise.all(visible.map(async entry => {
      const file = path.join(folder, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { isDirectory = (await fs.stat(file)).isDirectory(); } catch {}
      }
      return { name: entry.name, path: file, isDirectory, isSymbolicLink: entry.isSymbolicLink() };
    }));
    return output.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  });
  handle('completions', async (owner, id, line) => {
    const session = getSession(id, owner);
    if (!session.info.ready) return [];
    const snapshot = store.snapshot();
    return complete({ line, cwd: session.info.cwd, environmentPath: session.environmentPath, home, showHidden: snapshot.settings.showHiddenFiles, visitedDirectories: snapshot.directories });
  });
  handle('project-editors', (owner, id, refresh = false) => {
    if (typeof refresh !== 'boolean') throw new Error('Invalid editor refresh setting.');
    const session = getSession(id, owner);
    return editorService.projectEditors(session.info.cwd, session.environmentPath, refresh);
  });
  handle('open-editor', (owner, id, editorId) => {
    const session = getSession(id, owner);
    return editorService.openEditor(session.info.cwd, session.environmentPath, text(editorId, 64));
  });
  // `null` means "not a git repository" (or git is unavailable) — the renderer hides the
  // branch/changes chips in that case rather than treating it as an error.
  handle('git-status', (owner, id) => {
    const session = getSession(id, owner);
    return gitStatusService.status(session.info.cwd, session.environmentPath).catch(() => null);
  });
  handle('git-branches', (owner, id, refresh = false) => {
    if (typeof refresh !== 'boolean') throw new Error('Invalid refresh setting.');
    const session = getSession(id, owner);
    return gitStatusService.branches(session.info.cwd, session.environmentPath, refresh).catch(() => null);
  });
  handle('foreground-process', (owner, id) => {
    // node-pty reports the terminal's foreground process name (macOS/Linux) or
    // the shell itself (Windows). Used only to offer editor shortcuts.
    const session = getSession(id, owner);
    let name = '';
    try { name = String(session.pty.process || ''); } catch { return ''; }
    const tty = typeof session.pty._pty === 'string' ? session.pty._pty.replace(/^\/dev\//, '') : '';
    // git starts its editor in its own foreground process group, so the group
    // leader is still "git"; look for an editor among the foreground members.
    if (process.platform === 'win32' || !tty || EDITOR_PROCESS.test(path.basename(name))) return name;
    return new Promise(resolve => {
      execFile('ps', ['-t', tty, '-o', 'stat=,comm='], { timeout: 1000 }, (error, stdout) => {
        if (error) return resolve(name);
        const editor = String(stdout).split('\n').map(line => line.trim().split(/\s+/))
          .find(([stat, command]) => stat?.includes('+') && command && EDITOR_PROCESS.test(path.basename(command)));
        resolve(editor ? path.basename(editor[1]) : name);
      });
    });
  });
  handle('record-command', (owner, command, cwd) => store.record(text(command, 8192), resolvedPath(cwd)).then(sharedHistory(owner)));
  handle('pin-command', (owner, command, pinned) => {
    if (typeof pinned !== 'boolean') throw new Error('Invalid pin setting.');
    return store.pin(text(command, 8192), pinned).then(sharedHistory(owner));
  });
  handle('delete-command', (owner, command) => store.deleteCommand(text(command, 8192)).then(sharedHistory(owner)));
  handle('restore-command', (owner, entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid history entry.');
    return store.restoreCommand(entry).then(sharedHistory(owner));
  });
  handle('clear-history', owner => store.clear().then(sharedHistory(owner)));
  handle('save-settings', (owner, settings) => {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings.');
    return store.saveSettings(settings).then(saved => {
      syncFinderQuickAction(saved);
      syncShellThemes(saved);
      broadcast({ type: 'settings', settings: saved }, owner.id);
      return saved;
    });
  });
  handle('choose-directory', async owner => {
    const result = await dialog.showOpenDialog(owner.window, { title: 'Open directory', defaultPath: home, properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('open-file', async (_owner, file) => {
    const target = resolvedPath(file);
    const details = await fs.stat(target);
    if (!details.isFile()) throw new Error('Select a file to open.');
    const error = await desktopShell.openPath(target);
    if (error) throw new Error(error);
  });
  handle('open-directory', async (_owner, directory) => {
    const target = resolvedPath(directory);
    if (!(await fs.stat(target)).isDirectory()) throw new Error('Select a directory to open.');
    const error = await desktopShell.openPath(target);
    if (error) throw new Error(error);
  });
  // The Markdown preview reads documents and their images only through these
  // size-limited handlers; the renderer never loads local files by URL.
  handle('read-text-file', async (_owner, file) => {
    const target = resolvedPath(file);
    const details = await fs.stat(target);
    if (!details.isFile()) throw new Error('Select a file to preview.');
    if (details.size > MAX_PREVIEW_TEXT_BYTES) throw new Error(`${path.basename(target)} is larger than 2 MiB, too large to preview.`);
    return fs.readFile(target, 'utf8');
  });
  handle('read-image', async (_owner, file) => {
    const target = resolvedPath(file);
    const type = PREVIEW_IMAGE_TYPES[path.extname(target).toLowerCase()];
    if (!type) throw new Error('Only image files can be shown in the preview.');
    const details = await fs.stat(target);
    if (!details.isFile()) throw new Error('Select an image file.');
    if (details.size > MAX_PREVIEW_IMAGE_BYTES) throw new Error(`${path.basename(target)} is larger than 8 MiB, too large to preview.`);
    return `data:${type};base64,${(await fs.readFile(target)).toString('base64')}`;
  });
  handle('open-external-link', async (_owner, value) => {
    let url;
    try { url = new URL(text(value, 8192)); } catch { throw new Error('Invalid link.'); }
    if (!EXTERNAL_LINK_PROTOCOLS.has(url.protocol)) throw new Error(`Links using ${url.protocol} can't be opened from the preview.`);
    await desktopShell.openExternal(url.href);
  });
  handle('copy-text', (_owner, value) => {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1048576) throw new Error('Clipboard text must be smaller than 1 MiB.');
    return clipboard.writeText(value);
  });
  handle('read-text', async () => String(await clipboard.readText()).slice(0, 1048576));
  ipcMain.on('terminal:write', (event, id, data, submittedCommand, record) => {
    try {
      const owner = assertSender(event);
      if (typeof data !== 'string' || !data || data.length > 1048576) return;
      // Only an explicit `false` ever suppresses recording; anything else keeps the default.
      write(getSession(id, owner), data, submittedCommand, record === false ? false : undefined);
    } catch { /* Ignore stale writes from a closed tab. */ }
  });
  ipcMain.on('terminal:write-binary', (event, id, data) => {
    // xterm's X10/normal mouse reports are raw bytes (coordinates above 95
    // exceed ASCII), so they must not be UTF-8 encoded like typed text.
    try {
      const owner = assertSender(event);
      if (typeof data !== 'string' || !data || data.length > 4096 || /[^\x00-\xff]/.test(data)) return;
      const session = getSession(id, owner);
      if (!session.navigationPending) session.pty.write(Buffer.from(data, 'latin1'));
    } catch { /* Ignore stale writes from a closed tab. */ }
  });
  ipcMain.on('terminal:resize', (event, id, cols, rows) => {
    try {
      const owner = assertSender(event);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 1000 || rows < 1 || rows > 1000) return;
      getSession(id, owner).pty.resize(cols, rows);
    } catch { /* A tab can close between fitting and this message. */ }
  });
  ipcMain.on('terminal:window-action', (event, action) => {
    try {
      const { window } = assertSender(event);
      if (action === 'minimize') window.minimize();
      if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
      if (action === 'close') window.close();
    } catch {}
  });
}

function mostRecentWindow() {
  let recent = null;
  for (const record of windows.values()) if (!record.window.isDestroyed()) recent = record;
  return recent;
}

function showWindow(window) {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.focus();
}

// A new window steps down and right from the one the user was in, keeping
// its size, and starts over at the work area's corner when it would spill
// off the display.
function cascadeBounds(anchor) {
  if (!anchor || anchor.isDestroyed()) return { width: 1320, height: 860 };
  const bounds = anchor.isMaximized() || anchor.isFullScreen() ? anchor.getNormalBounds() : anchor.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  let x = bounds.x + CASCADE_OFFSET;
  let y = bounds.y + CASCADE_OFFSET;
  if (x + width > area.x + area.width || y + height > area.y + area.height) { x = area.x; y = area.y; }
  return { x, y, width, height };
}

/** Opens a window; `targets` become its first tabs instead of the usual one at Home. */
function createWindow({ targets = [] } = {}) {
  const window = new BrowserWindow({
    ...cascadeBounds(BrowserWindow.getFocusedWindow() ?? mostRecentWindow()?.window), minWidth: 820, minHeight: 540,
    frame: process.platform === 'darwin',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 19 } } : {}),
    backgroundColor: '#0c1018', title: 'Mullion Terminal', show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  const id = window.webContents.id;
  const record = { id, window, ready: false, pending: [...targets] };
  windows.set(id, record);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!trustedUrl(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
  window.on('focus', () => { if (windows.delete(id)) windows.set(id, record); });
  // Closing a window ends only its own shells.
  window.on('closed', () => { closeWindowSessions(id); windows.delete(id); });
  window.loadURL(appUrl).catch(error => {
    dialog.showErrorBox('Could not open Mullion Terminal', `${error.message}\n\nRun npm run build before starting the application.`);
    app.quit();
  });
  return record;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    if (openFromArgv(argv, workingDirectory) || !started) return;
    // A bare second launch just brings the app forward.
    const recent = mostRecentWindow();
    if (recent) showWindow(recent.window);
    else createWindow();
  });
  app.whenReady().then(async () => {
    store = new LocalStore(app.getPath('userData'));
    await store.load();
    syncFinderQuickAction(store.snapshot().settings);
    integrationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-terminal-'));
    await syncShellThemes(store.snapshot().settings);
    electronSession.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    electronSession.defaultSession.setPermissionCheckHandler(() => false);
    registerIpc();
    // macOS learns the scheme from the app's CFBundleURLTypes (package.json's
    // mac.protocols); the installed Windows app registers it for the current
    // user. Linux file managers launch the app with %F (local files only), so
    // links aren't registered there.
    if (app.isPackaged && process.platform === 'win32' && !app.isDefaultProtocolClient(PROTOCOL)) app.setAsDefaultProtocolClient(PROTOCOL);
    started = true;
    // The first request that arrived during startup (whatever its mode)
    // becomes the first window's tabs; any others are routed as usual.
    const [first, ...rest] = startupRequests.splice(0, startupRequests.length);
    createWindow({ targets: first?.targets ?? [] });
    for (const request of rest) openTargets(request.targets, request.mode);
    app.on('activate', () => { if (!windows.size) createWindow(); });
  }).catch(error => { dialog.showErrorBox('Could not start Mullion Terminal', error.message); app.quit(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    for (const id of [...sessions.keys()]) closeSession(id);
    if (!quitting && store) {
      event.preventDefault();
      quitting = true;
      store.queue.finally(() => app.quit());
    }
  });
  app.on('will-quit', () => {
    if (integrationRoot) {
      try { require('node:fs').rmSync(integrationRoot, { recursive: true, force: true }); } catch {}
    }
  });
}
