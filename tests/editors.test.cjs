'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { classifyFilename, scanLanguages, discoverEditors, rankEditors, launchEditor, createEditorService } = require('../electron/editors.cjs');

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-editors-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function file(target, executable = false) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '', { mode: executable ? 0o755 : 0o600 });
}

const emptyRoots = () => ({ applications: [], programFiles: [], localPrograms: [], linuxRoots: [], toolboxRoots: [] });

test('programming filenames and manifests classify web, PHP, Python and typed projects', () => {
  for (const [filename, expected] of Object.entries({ 'index.HTML': 'HTML', 'styles.scss': 'CSS', 'controller.php': 'PHP', 'composer.json': 'PHP', 'pyproject.toml': 'Python', 'requirements-dev.txt': 'Python', 'app.py': 'Python', 'tsconfig.json': 'TypeScript', 'Cargo.toml': 'Rust', 'app.csproj': 'C#', 'AndroidManifest.xml': 'Android' })) assert.equal(classifyFilename(filename), expected);
  assert.equal(classifyFilename('README.md'), null);
  assert.equal(classifyFilename('data.json'), null);
});

test('project scan reads names only, follows depth two, and ignores generated/dependency folders', async t => {
  const root = await temporary(t);
  await file(path.join(root, 'index.html'));
  await file(path.join(root, 'composer.json'));
  await file(path.join(root, 'src', 'server.py'));
  await file(path.join(root, 'src', 'components', 'App.tsx'));
  await file(path.join(root, 'src', 'components', 'deep', 'ignored.rs'));
  await file(path.join(root, 'node_modules', 'dependency.go'));
  await file(path.join(root, 'venv', 'ignored.java'));
  await file(path.join(root, 'build', 'ignored.swift'));
  await file(path.join(root, '.git', 'ignored.rb'));
  const fileSystem = { ...fs, readFile: () => { throw new Error('Project file contents must not be read.'); } };
  assert.deepEqual(await scanLanguages(root, { fileSystem }), ['HTML', 'PHP', 'Python', 'TypeScript']);
  let opened = 0;
  const bounded = { ...fs, opendir: (...args) => { opened++; return fs.opendir(...args); } };
  await scanLanguages(root, { fileSystem: bounded, maxDirectories: 1 });
  assert.equal(opened, 1);
});

test('macOS discovers real app bundles, includes Antigravity, and ignores Xcode OS stub', async t => {
  const root = await temporary(t);
  const applications = path.join(root, 'Applications');
  for (const name of ['Visual Studio Code.app', 'PhpStorm.app', 'Antigravity.app']) await file(path.join(applications, name, 'Contents', 'Info.plist'));
  await fs.mkdir(path.join(applications, 'Zed.app'));
  const bin = path.join(root, 'bin');
  await file(path.join(bin, 'xed'), true);
  const editors = await discoverEditors({ platform: 'darwin', pathApi: path, home: root, cwd: root, environmentPath: bin, roots: { ...emptyRoots(), applications: [applications] } });
  assert.deepEqual(editors.map(editor => editor.id).sort(), ['antigravity', 'phpstorm', 'vscode']);
  assert.equal(rankEditors(editors, ['PHP', 'HTML'])[0].id, 'phpstorm');
  assert(editors.every(editor => editor.kind === 'app'));
});

test('Linux PATH executables and versioned Toolbox installs are verified; absent editors stay absent', { skip: process.platform === 'win32' }, async t => {
  const root = await temporary(t);
  const bin = path.join(root, 'bin');
  await file(path.join(bin, 'code'), true);
  await file(path.join(bin, 'cursor')); // Not executable on Unix.
  const toolbox = path.join(root, 'toolbox');
  await file(path.join(toolbox, 'pycharm', 'ch-0', '2026.2', 'bin', 'pycharm.sh'), true);
  const editors = await discoverEditors({ platform: 'linux', home: root, cwd: root, environmentPath: bin, roots: { ...emptyRoots(), linuxRoots: [toolbox] } });
  assert(editors.some(editor => editor.id === 'vscode'));
  assert(editors.some(editor => editor.id === 'pycharm'));
  assert(!editors.some(editor => editor.id === 'cursor'));
  assert(!editors.some(editor => editor.id === 'webstorm'));
  assert.equal(rankEditors(editors, ['Python'])[0].id, 'pycharm');
});

test('Windows .cmd shims resolve only to known actual exe; specialized IDE and VS installations are found', async t => {
  const root = await temporary(t);
  const codeRoot = path.join(root, 'Microsoft VS Code');
  const codeBin = path.join(codeRoot, 'bin');
  await file(path.join(codeBin, 'code.cmd'));
  const options = { platform: 'win32', pathApi: path, home: root, cwd: root, environmentPath: codeBin, roots: emptyRoots() };
  assert(!((await discoverEditors(options)).some(editor => editor.id === 'vscode')));
  await file(path.join(codeRoot, 'Code.exe'));
  const programFiles = path.join(root, 'Program Files');
  await file(path.join(programFiles, 'JetBrains', 'WebStorm 2026.2', 'bin', 'webstorm64.exe'));
  await file(path.join(programFiles, 'Microsoft Visual Studio', '2022', 'Community', 'Common7', 'IDE', 'devenv.exe'));
  const editors = await discoverEditors({ ...options, roots: { ...emptyRoots(), programFiles: [programFiles] } });
  assert.equal(editors.find(editor => editor.id === 'vscode').target, path.join(codeRoot, 'Code.exe'));
  assert(editors.some(editor => editor.id === 'webstorm'));
  assert(editors.some(editor => editor.id === 'visual-studio'));
  assert.equal(rankEditors(editors, ['HTML', 'JavaScript'])[0].id, 'webstorm');
  assert(editors.every(editor => editor.target.endsWith('.exe')));
});

test('editor launch passes folder literally without a shell and macOS launch checks open exit', async () => {
  const cwd = "/project's folder/$(do not execute); words";
  const calls = [];
  const spawnProcess = (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 0); });
    return child;
  };
  await launchEditor({ id: 'vscode', name: 'VS Code', kind: 'executable', target: '/installed/code' }, cwd, { spawnProcess, platform: 'linux', environmentPath: '/installed' });
  await launchEditor({ id: 'phpstorm', name: 'PhpStorm', kind: 'app', target: '/Applications/PhpStorm.app' }, cwd, { spawnProcess, platform: 'darwin' });
  assert.deepEqual(calls[0].args, [cwd]);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[1].args, ['-a', '/Applications/PhpStorm.app', cwd]);
  assert.equal(calls[1].executable, '/usr/bin/open');
  assert(calls.every(call => call.options.stdio === 'ignore'));
});

test('service caches briefly, refreshes on request, and rejects unknown or removed editors', async t => {
  const root = await temporary(t);
  const target = path.join(root, 'code');
  await file(target, true);
  let discoveries = 0;
  let clock = 1;
  let launched = 0;
  const service = createEditorService({ platform: 'linux', home: root, now: () => clock, discover: async () => { discoveries++; return [{ id: 'vscode', name: 'Visual Studio Code', general: true, target, kind: 'executable' }]; }, scan: async () => ['HTML'], launch: async () => { launched++; } });
  assert.deepEqual(await service.projectEditors(root, '/bin'), { languages: ['HTML'], editors: [{ id: 'vscode', name: 'Visual Studio Code' }] });
  await service.projectEditors(root, '/bin');
  assert.equal(discoveries, 1);
  await service.projectEditors(root, '/bin', true);
  assert.equal(discoveries, 2);
  clock += 31000;
  await service.projectEditors(root, '/bin');
  assert.equal(discoveries, 3);
  await assert.rejects(service.openEditor(root, '/bin', '../bin/sh'), /Unknown editor/);
  await assert.rejects(service.openEditor(root, '/bin', 'cursor'), /not installed/);
  await service.openEditor(root, '/bin', 'vscode');
  assert.equal(launched, 1);
  await fs.unlink(target);
  await assert.rejects(service.openEditor(root, '/bin', 'vscode'));
  assert.equal(launched, 1);
});

test('ordinary parent folders do not inherit unrelated projects; source containers qualify code', async t => {
  const root = await temporary(t);
  await file(path.join(root, 'projects', 'website', 'index.html'));
  await file(path.join(root, 'projects', 'python-tool', 'main.py'));
  await file(path.join(root, '.setup.sh'));
  assert.deepEqual(await scanLanguages(root), []);
  await file(path.join(root, 'src', 'components', 'index.html'));
  assert.deepEqual(await scanLanguages(root), ['HTML']);
});

test('a root project marker qualifies nested source layout without scanning dependency output', async t => {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, '.git'));
  await file(path.join(root, 'cmd', 'server', 'main.go'));
  await file(path.join(root, 'vendor', 'library.php'));
  assert.deepEqual(await scanLanguages(root), ['Go']);
});

test('project editor results include only installed general editors and matching specialized IDEs', async t => {
  const root = await temporary(t);
  const python = path.join(root, 'python');
  const php = path.join(root, 'php');
  const notes = path.join(root, 'notes');
  await file(path.join(python, 'main.py'));
  await file(path.join(php, 'index.php'));
  await file(path.join(notes, 'README.md'));
  const installed = [
    { id: 'vscode', name: 'Visual Studio Code', general: true, target: path.join(root, 'code') },
    { id: 'pycharm', name: 'PyCharm', languages: ['Python'], target: path.join(root, 'pycharm') },
    { id: 'phpstorm', name: 'PhpStorm', languages: ['PHP', 'JavaScript', 'HTML'], target: path.join(root, 'phpstorm') },
    { id: 'webstorm', name: 'WebStorm', languages: ['JavaScript', 'TypeScript', 'HTML'], target: path.join(root, 'webstorm') },
  ];
  const service = createEditorService({ platform: 'linux', home: root, discover: async () => installed });
  assert.deepEqual((await service.projectEditors(python, '')).editors.map(editor => editor.id), ['pycharm', 'vscode']);
  assert.deepEqual((await service.projectEditors(php, '')).editors.map(editor => editor.id), ['phpstorm', 'vscode']);
  assert.deepEqual((await service.projectEditors(notes, '')).editors, []);
  assert.deepEqual((await service.projectEditors(root, '')).editors, []);
});

test('native app icons are cached across directories, refreshed explicitly and never expose targets', async t => {
  const root = await temporary(t);
  const target = path.join(root, 'Visual Studio Code.app');
  await file(path.join(target, 'Contents', 'Info.plist'));
  const icon = 'data:image/png;base64,iVBORw0KGgo=';
  const requested = [];
  const service = createEditorService({
    platform: 'darwin', home: root, scan: async () => ['TypeScript'],
    discover: async () => [{ id: 'vscode', name: 'Visual Studio Code', general: true, target, kind: 'app' }],
    getIcon: async verifiedTarget => { requested.push(verifiedTarget); return icon; },
  });
  const result = await service.projectEditors(root, '');
  assert.deepEqual(result.editors, [{ id: 'vscode', name: 'Visual Studio Code', icon }]);
  const verifiedTarget = await fs.realpath(target);
  await service.projectEditors(path.join(root, 'other-project'), '');
  assert.deepEqual(requested, [verifiedTarget]);
  await service.projectEditors(root, '', true);
  assert.deepEqual(requested, [verifiedTarget, verifiedTarget]);
});

test('Linux uses actual installed product icon assets before generic native file icons', { skip: process.platform === 'win32' }, async t => {
  const root = await temporary(t);
  const target = path.join(root, 'pycharm', 'bin', 'pycharm.sh');
  await file(target, true);
  const asset = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M0 0h32v32H0Z"/></svg>';
  await fs.writeFile(path.join(path.dirname(target), 'pycharm.svg'), asset);
  let nativeRequests = 0;
  const service = createEditorService({
    platform: 'linux', home: root, scan: async () => ['Python'],
    discover: async () => [{ id: 'pycharm', name: 'PyCharm', languages: ['Python'], target, kind: 'executable' }],
    getIcon: async () => { nativeRequests++; return undefined; },
  });
  const result = await service.projectEditors(root, '');
  assert.equal(result.editors[0].icon, `data:image/svg+xml;base64,${Buffer.from(asset).toString('base64')}`);
  assert.equal(nativeRequests, 0);
});

test('macOS CLI symlinks request the installed app bundle icon rather than a generic script icon', { skip: process.platform === 'win32' }, async t => {
  const root = await temporary(t);
  const bundle = path.join(root, 'Visual Studio Code.app');
  const executable = path.join(bundle, 'Contents', 'Resources', 'app', 'bin', 'code');
  await file(path.join(bundle, 'Contents', 'Info.plist'));
  await file(executable, true);
  const shim = path.join(root, 'code');
  await fs.symlink(executable, shim);
  let requested;
  const service = createEditorService({
    platform: 'darwin', home: root, scan: async () => ['HTML'],
    discover: async () => [{ id: 'vscode', name: 'Visual Studio Code', general: true, target: shim, kind: 'executable' }],
    getIcon: async target => { requested = target; return undefined; },
  });
  await service.projectEditors(root, '');
  assert.equal(requested, await fs.realpath(bundle));
});

test('native icon failure does not hide a matching installed editor', async t => {
  const root = await temporary(t);
  const service = createEditorService({
    platform: 'darwin', home: root, scan: async () => ['HTML'],
    discover: async () => [{ id: 'vscode', name: 'Visual Studio Code', general: true, target: '/Applications/Visual Studio Code.app', kind: 'app' }],
    getIcon: async () => { throw new Error('Native icon unavailable'); },
  });
  assert.deepEqual((await service.projectEditors(root, '')).editors, [{ id: 'vscode', name: 'Visual Studio Code' }]);
});

test('opening an editor rechecks language compatibility after the project contents change', async t => {
  const root = await temporary(t);
  const project = path.join(root, 'project');
  await file(path.join(project, 'main.py'));
  const editors = [
    { id: 'pycharm', name: 'PyCharm', languages: ['Python'], target: path.join(root, 'pycharm'), kind: 'executable' },
    { id: 'phpstorm', name: 'PhpStorm', languages: ['PHP'], target: path.join(root, 'phpstorm'), kind: 'executable' },
    { id: 'vscode', name: 'Visual Studio Code', general: true, target: path.join(root, 'code'), kind: 'executable' },
  ];
  for (const editor of editors) await file(editor.target, true);
  let launches = 0;
  const service = createEditorService({ platform: 'linux', home: root, discover: async () => editors, launch: async () => { launches++; } });
  await service.projectEditors(project, '');
  await fs.unlink(path.join(project, 'main.py'));
  await file(path.join(project, 'index.php'));
  await assert.rejects(service.openEditor(project, '', 'pycharm'), /does not match/);
  assert.equal(launches, 0);
  await service.openEditor(project, '', 'phpstorm');
  await service.openEditor(project, '', 'vscode');
  assert.equal(launches, 2);
  await fs.unlink(path.join(project, 'index.php'));
  await file(path.join(project, 'README.md'));
  await assert.rejects(service.openEditor(project, '', 'vscode'), /does not match/);
  assert.equal(launches, 2);
});
