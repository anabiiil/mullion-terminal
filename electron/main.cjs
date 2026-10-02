'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell: desktopShell, session: electronSession } = require('electron');
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
const { defaultEnvironment, prepareShell, NAVIGATION_SEQUENCE, navigationRequest } = require('./shell.cjs');
const { complete } = require('./completions.cjs');
const { SubmissionTracker } = require('./submissions.cjs');
const { createEditorService } = require('./editors.cjs');
const { pathsFromArgv, resolveOpenTarget } = require('./open-paths.cjs');
const { installFinderQuickAction, removeFinderQuickAction, templateDirectory } = require('./finder-service.cjs');

app.setName('Mullion Terminal');
const sessions = new Map();
let window = null;
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

// "Open with Mullion Terminal" (Finder/Explorer/file-manager right-click, a
// file or folder dropped on the Dock icon, or `mullion-terminal <path>` from
// a shell) — a folder opens a tab there, a file opens a tab in its parent
// folder and then opens the file the same way the tree's double-click does.
// Targets are queued here and only ever sent to the renderer once it has
// bootstrapped (see the `bootstrap` handler below and `window`'s `closed`
// listener), since the very first one can arrive before any window exists.
// Keeps the macOS "Open in Mullion Terminal" Quick Action in step with the
// setting. Fire-and-forget: a failure here must never block startup or a
// settings save. Runs are chained so quick toggles apply in order.
let finderQuickActionQueue = Promise.resolve();
function syncFinderQuickAction(settings) {
  // Dev and test runs must not touch the user's real ~/Library/Services.
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  const enabled = settings?.finderQuickAction !== false;
  finderQuickActionQueue = finderQuickActionQueue.then(() => enabled
    ? installFinderQuickAction({ templateDir: templateDirectory({ isPackaged: app.isPackaged }), appPath: path.resolve(process.execPath, '../../..') })
    : removeFinderQuickAction()
  ).catch(error => console.warn('Could not update the Finder Quick Action:', error.message));
}

let rendererReady = false;
const pendingOpenPaths = [];
function queueOrOpenTargets(targets) {
  if (!targets.length) return;
  if (rendererReady) for (const target of targets) sendOpenPath(target);
  else pendingOpenPaths.push(...targets);
  if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
  // macOS keeps running with no window; Finder/Dock opens must bring one back.
  else if (app.isReady()) createWindow();
}
function sendOpenPath(target) {
  if (target.isDirectory) send({ type: 'open-path', path: target.path, isDirectory: true });
  else send({ type: 'open-path', path: path.dirname(target.path), isDirectory: false, filePath: target.path });
}
function flushPendingOpenPaths() {
  if (!rendererReady || !pendingOpenPaths.length) return;
  for (const target of pendingOpenPaths.splice(0, pendingOpenPaths.length)) sendOpenPath(target);
}
// A CLI launch (`mullion-terminal <path>`, or Windows/Linux "Open with
// Mullion Terminal") hands its paths as plain argv.
queueOrOpenTargets(pathsFromArgv(process.argv, { cwd: process.cwd(), isPackaged: app.isPackaged }));
// macOS hands Finder's "Open With" and a Dock drop through 'open-file'
// instead, which can fire before 'ready' — the listener must exist already.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  const target = resolveOpenTarget(filePath, process.cwd());
  if (target) queueOrOpenTargets([target]);
});

function trustedUrl(value) {
  if (development) {
    try { return new URL(value).origin === 'http://127.0.0.1:5173'; } catch { return false; }
  }
  return value.split('#')[0] === distUrl;
}

function assertSender(event) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !trustedUrl(event.senderFrame.url)) throw new Error('Unauthorized terminal request.');
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

function getSession(id) {
  text(id, 64);
  const session = sessions.get(id);
  if (!session || !session.info.alive) throw new Error('This terminal session has ended.');
  return session;
}

function send(event) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('terminal:event', event);
}

function state(session) { send({ type: 'state', session: { ...session.info } }); }

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

async function createSession(directory = startupDirectory) {
  if (sessions.size >= 20) throw new Error('Close a terminal tab before opening another one.');
  const cwd = resolvedPath(directory);
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error('The selected path is not a directory.');
  const id = randomUUID();
  const nonce = randomBytes(24).toString('hex');
  const integrationDirectory = path.join(integrationRoot, id);
  const launch = await prepareShell({ directory: integrationDirectory, nonce, home, env: defaultEnvironment(home) });
  let terminalProcess;
  try {
    terminalProcess = pty.spawn(launch.shell, launch.args, { name: 'xterm-256color', cols: 100, rows: 30, cwd, env: launch.env, useConpty: true });
  } catch (error) {
    await fs.rm(integrationDirectory, { recursive: true, force: true });
    throw new Error(`Could not start ${path.basename(launch.shell)}: ${error.message}`);
  }
  const session = {
    pty: terminalProcess,
    info: { id, cwd, shell: path.basename(launch.shell), platform: process.platform, ready: false, alive: true },
    environmentPath: launch.env.PATH || '',
    integrationDirectory,
    navigationFile: launch.navigationFile,
    navigationAvailable: false,
    navigationPending: null,
  };
  session.submissions = new SubmissionTracker(command => {
    store.record(command, session.info.cwd).then(history => send({ type: 'history', history })).catch(error => {
      // Disk failures must not interrupt a running shell.
      console.error('Could not save command history:', error.message);
    });
  });
  const parser = new PromptParser(nonce, prompt => {
    if (!session.info.alive) return;
    if (prompt.ready) session.submissions.finish(prompt.status);
    if (prompt.ready && path.isAbsolute(prompt.cwd)) session.info.cwd = path.normalize(prompt.cwd);
    if (typeof prompt.path === 'string') session.environmentPath = prompt.path;
    if (typeof prompt.navigation === 'boolean') session.navigationAvailable = prompt.navigation;
    session.info.ready = prompt.ready;
    state(session);
  }, command => {
    session.submissions.hook(command);
  }, navigation => {
    if (navigation.requestId !== session.navigationPending?.requestId) return;
    if (navigation.success && path.isAbsolute(navigation.cwd)) {
      session.info.cwd = path.normalize(navigation.cwd);
      state(session);
      finishNavigation(session);
    } else finishNavigation(session, new Error('Could not change directories. Check the folder permissions.'));
  });
  sessions.set(id, session);
  terminalProcess.onData(data => {
    const output = parser.feed(data);
    if (output) send({ type: 'data', id, data: output });
  });
  terminalProcess.onExit(({ exitCode }) => {
    finishNavigation(session, new Error('This terminal session has ended.'));
    session.submissions.finish();
    const remaining = parser.flush();
    if (remaining) send({ type: 'data', id, data: remaining });
    session.info.alive = false;
    session.info.ready = false;
    state(session);
    send({ type: 'exit', id, exitCode });
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

function registerIpc() {
  function handle(channel, handler) {
    ipcMain.handle(`terminal:${channel}`, (event, ...args) => { assertSender(event); return handler(...args); });
  }
  handle('bootstrap', () => {
    // The renderer's bootstrap call is also its "I'm ready for events" signal:
    // any open-path targets queued before now (startup argv, or a Finder
    // 'open-file' that arrived before the window existed) are flushed right
    // after, once this response's listeners are certainly attached.
    const openPathCount = pendingOpenPaths.length;
    rendererReady = true;
    setImmediate(flushPendingOpenPaths);
    return { home, platform: process.platform, openPathCount, ...store.snapshot() };
  });
  handle('create-session', createSession);
  handle('close-session', id => { text(id, 64); closeSession(id); });
  handle('change-directory', async (id, directory) => {
    const session = getSession(id);
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
      session.pty.write(NAVIGATION_SEQUENCE);
    } catch (error) { finishNavigation(session, error); }
    finally { fs.unlink(temporary).catch(() => {}); }
    return completion;
  });
  handle('list-directory', async (directory, showHidden = false) => {
    if (typeof showHidden !== 'boolean') throw new Error('Invalid visibility setting.');
    const folder = resolvedPath(directory);
    const entries = await fs.readdir(folder, { withFileTypes: true });
    const visible = entries.filter(entry => showHidden || !entry.name.startsWith('.')).slice(0, 5000);
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
  handle('completions', async (id, line) => {
    const session = getSession(id);
    if (!session.info.ready) return [];
    return complete({ line, cwd: session.info.cwd, environmentPath: session.environmentPath, home, showHidden: store.snapshot().settings.showHiddenFiles });
  });
  handle('project-editors', (id, refresh = false) => {
    if (typeof refresh !== 'boolean') throw new Error('Invalid editor refresh setting.');
    const session = getSession(id);
    return editorService.projectEditors(session.info.cwd, session.environmentPath, refresh);
  });
  handle('open-editor', (id, editorId) => {
    const session = getSession(id);
    return editorService.openEditor(session.info.cwd, session.environmentPath, text(editorId, 64));
  });
  handle('foreground-process', id => {
    // node-pty reports the terminal's foreground process name (macOS/Linux) or
    // the shell itself (Windows). Used only to offer editor shortcuts.
    const session = getSession(id);
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
  handle('record-command', (command, cwd) => store.record(text(command, 8192), resolvedPath(cwd)));
  handle('pin-command', (command, pinned) => {
    if (typeof pinned !== 'boolean') throw new Error('Invalid pin setting.');
    return store.pin(text(command, 8192), pinned);
  });
  handle('delete-command', command => store.deleteCommand(text(command, 8192)));
  handle('restore-command', entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid history entry.');
    return store.restoreCommand(entry);
  });
  handle('clear-history', () => store.clear());
  handle('save-settings', settings => {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings.');
    return store.saveSettings(settings).then(saved => { syncFinderQuickAction(saved); return saved; });
  });
  handle('choose-directory', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Open directory', defaultPath: home, properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('open-file', async file => {
    const target = resolvedPath(file);
    const details = await fs.stat(target);
    if (!details.isFile()) throw new Error('Select a file to open.');
    const error = await desktopShell.openPath(target);
    if (error) throw new Error(error);
  });
  handle('open-directory', async directory => {
    const target = resolvedPath(directory);
    if (!(await fs.stat(target)).isDirectory()) throw new Error('Select a directory to open.');
    const error = await desktopShell.openPath(target);
    if (error) throw new Error(error);
  });
  // The Markdown preview reads documents and their images only through these
  // size-limited handlers; the renderer never loads local files by URL.
  handle('read-text-file', async file => {
    const target = resolvedPath(file);
    const details = await fs.stat(target);
    if (!details.isFile()) throw new Error('Select a file to preview.');
    if (details.size > MAX_PREVIEW_TEXT_BYTES) throw new Error(`${path.basename(target)} is larger than 2 MiB, too large to preview.`);
    return fs.readFile(target, 'utf8');
  });
  handle('read-image', async file => {
    const target = resolvedPath(file);
    const type = PREVIEW_IMAGE_TYPES[path.extname(target).toLowerCase()];
    if (!type) throw new Error('Only image files can be shown in the preview.');
    const details = await fs.stat(target);
    if (!details.isFile()) throw new Error('Select an image file.');
    if (details.size > MAX_PREVIEW_IMAGE_BYTES) throw new Error(`${path.basename(target)} is larger than 8 MiB, too large to preview.`);
    return `data:${type};base64,${(await fs.readFile(target)).toString('base64')}`;
  });
  handle('open-external-link', async value => {
    let url;
    try { url = new URL(text(value, 8192)); } catch { throw new Error('Invalid link.'); }
    if (!EXTERNAL_LINK_PROTOCOLS.has(url.protocol)) throw new Error(`Links using ${url.protocol} can't be opened from the preview.`);
    await desktopShell.openExternal(url.href);
  });
  handle('copy-text', value => {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1048576) throw new Error('Clipboard text must be smaller than 1 MiB.');
    return clipboard.writeText(value);
  });
  handle('read-text', async () => String(await clipboard.readText()).slice(0, 1048576));
  ipcMain.on('terminal:write', (event, id, data, submittedCommand, record) => {
    try {
      assertSender(event);
      if (typeof data !== 'string' || !data || data.length > 1048576) return;
      // Only an explicit `false` ever suppresses recording; anything else keeps the default.
      write(getSession(id), data, submittedCommand, record === false ? false : undefined);
    } catch { /* Ignore stale writes from a closed tab. */ }
  });
  ipcMain.on('terminal:write-binary', (event, id, data) => {
    // xterm's X10/normal mouse reports are raw bytes (coordinates above 95
    // exceed ASCII), so they must not be UTF-8 encoded like typed text.
    try {
      assertSender(event);
      if (typeof data !== 'string' || !data || data.length > 4096 || /[^\x00-\xff]/.test(data)) return;
      const session = getSession(id);
      if (!session.navigationPending) session.pty.write(Buffer.from(data, 'latin1'));
    } catch { /* Ignore stale writes from a closed tab. */ }
  });
  ipcMain.on('terminal:resize', (event, id, cols, rows) => {
    try {
      assertSender(event);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 1000 || rows < 1 || rows > 1000) return;
      getSession(id).pty.resize(cols, rows);
    } catch { /* A tab can close between fitting and this message. */ }
  });
  ipcMain.on('terminal:window-action', (event, action) => {
    try {
      assertSender(event);
      if (action === 'minimize') window.minimize();
      if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
      if (action === 'close') window.close();
    } catch {}
  });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1320, height: 860, minWidth: 820, minHeight: 540,
    frame: process.platform === 'darwin',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 19 } } : {}),
    backgroundColor: '#0c1018', title: 'Mullion Terminal', show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!trustedUrl(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('ready-to-show', () => window?.show());
  window.on('closed', () => { for (const id of [...sessions.keys()]) closeSession(id); window = null; rendererReady = false; });
  window.loadURL(appUrl).catch(error => {
    dialog.showErrorBox('Could not open Mullion Terminal', `${error.message}\n\nRun npm run build before starting the application.`);
    app.quit();
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const targets = pathsFromArgv(argv, { cwd: workingDirectory, isPackaged: app.isPackaged });
    if (!window) { pendingOpenPaths.push(...targets); createWindow(); return; }
    if (window.isMinimized()) window.restore();
    window.focus();
    if (targets.length) queueOrOpenTargets(targets);
  });
  app.whenReady().then(async () => {
    store = new LocalStore(app.getPath('userData'));
    await store.load();
    syncFinderQuickAction(store.snapshot().settings);
    integrationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-terminal-'));
    electronSession.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    electronSession.defaultSession.setPermissionCheckHandler(() => false);
    registerIpc();
    createWindow();
    app.on('activate', () => { if (!window) createWindow(); });
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
