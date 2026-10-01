'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell: desktopShell, session: electronSession } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
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

function write(session, data, submittedCommand) {
  if (session.navigationPending) {
    session.navigationPending.input.push({ data, submittedCommand });
    return;
  }
  // Readline owns editing, history navigation, signals, and interactive programs.
  // Any submitted line or Ctrl-C is busy until the real shell renders a prompt.
  if (session.info.ready && /[\r\n]/.test(data)) session.submissions.submit(data === '\r' ? submittedCommand : undefined);
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
      if (data) write(session, data, error ? undefined : input.submittedCommand);
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
    if (prompt.ready) session.submissions.finish();
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
  handle('bootstrap', () => ({ home, platform: process.platform, ...store.snapshot() }));
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
  handle('record-command', (command, cwd) => store.record(text(command, 8192), resolvedPath(cwd)));
  handle('pin-command', (command, pinned) => {
    if (typeof pinned !== 'boolean') throw new Error('Invalid pin setting.');
    return store.pin(text(command, 8192), pinned);
  });
  handle('clear-history', () => store.clear());
  handle('save-settings', settings => {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings.');
    return store.saveSettings(settings);
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
  handle('copy-text', value => {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1048576) throw new Error('Clipboard text must be smaller than 1 MiB.');
    return clipboard.writeText(value);
  });
  handle('read-text', () => clipboard.readText().slice(0, 1048576));
  ipcMain.on('terminal:write', (event, id, data, submittedCommand) => {
    try {
      assertSender(event);
      if (typeof data !== 'string' || !data || data.length > 1048576) return;
      write(getSession(id), data, submittedCommand);
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
  window.on('closed', () => { for (const id of [...sessions.keys()]) closeSession(id); window = null; });
  window.loadURL(appUrl).catch(error => {
    dialog.showErrorBox('Could not open Mullion Terminal', `${error.message}\n\nRun npm run build before starting the application.`);
    app.quit();
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } else createWindow(); });
  app.whenReady().then(async () => {
    store = new LocalStore(app.getPath('userData'));
    await store.load();
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
