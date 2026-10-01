'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { constants } = require('node:fs');

const IGNORED = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'venv', '.venv', 'env', '.env', '__pycache__', '.next', '.nuxt', '.cache', '.idea', '.vscode', 'coverage', 'bin', 'obj', '.gradle', 'pods', '.build']);
const SOURCE_CONTAINERS = new Set(['src', 'source', 'sources', 'app', 'public', 'lib', 'templates', 'components', 'pages', 'routes', 'resources', 'assets', 'styles', 'scripts', 'tests', 'test', 'include', 'server', 'client']);
const EXTENSIONS = { js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', vue: 'JavaScript', svelte: 'JavaScript', astro: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', pyi: 'Python', php: 'PHP', phtml: 'PHP', html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'CSS', sass: 'CSS', less: 'CSS', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', cs: 'C#', csproj: 'C#', fs: '.NET', fsproj: '.NET', vb: '.NET', vbproj: '.NET', sln: '.NET', slnx: '.NET', razor: 'C#', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', hxx: 'C++', swift: 'Swift', m: 'Objective-C', mm: 'Objective-C', rb: 'Ruby', r: 'R', jl: 'Julia', lua: 'Lua', sql: 'SQL', sh: 'Shell', ps1: 'PowerShell' };
const MANIFESTS = { 'package.json': 'JavaScript', 'package-lock.json': 'JavaScript', 'yarn.lock': 'JavaScript', 'pnpm-lock.yaml': 'JavaScript', 'tsconfig.json': 'TypeScript', 'composer.json': 'PHP', 'composer.lock': 'PHP', 'pyproject.toml': 'Python', 'setup.py': 'Python', 'setup.cfg': 'Python', 'pipfile': 'Python', 'poetry.lock': 'Python', 'cargo.toml': 'Rust', 'go.mod': 'Go', 'pom.xml': 'Java', 'build.gradle': 'Java', 'build.gradle.kts': 'Kotlin', 'androidmanifest.xml': 'Android', 'gemfile': 'Ruby', 'cmakelists.txt': 'C++', 'package.swift': 'Swift' };

const CATALOG = [
  { id: 'vscode', name: 'Visual Studio Code', general: true, cli: ['code', 'code-insiders'], app: /^Visual Studio Code(?: - Insiders)?\.app$/i, windows: ['Microsoft VS Code/Code.exe', 'Microsoft VS Code Insiders/Code - Insiders.exe'], wrapperExe: ['Code.exe', 'Code - Insiders.exe'], linux: ['/usr/share/code/code', '/usr/share/code-insiders/code-insiders'] },
  { id: 'cursor', name: 'Cursor', general: true, cli: ['cursor'], app: /^Cursor\.app$/i, windows: ['Cursor/Cursor.exe', 'cursor/Cursor.exe'], wrapperExe: ['Cursor.exe'], linux: ['/opt/Cursor/cursor', '/opt/cursor/cursor'] },
  { id: 'antigravity', name: 'Antigravity', general: true, cli: ['antigravity'], app: /^Antigravity\.app$/i, windows: ['Antigravity/Antigravity.exe'], wrapperExe: ['Antigravity.exe'], linux: ['/opt/antigravity/antigravity', '/usr/share/antigravity/antigravity'] },
  { id: 'vscodium', name: 'VSCodium', general: true, cli: ['codium'], app: /^VSCodium\.app$/i, windows: ['VSCodium/VSCodium.exe'], wrapperExe: ['VSCodium.exe'], linux: ['/usr/share/codium/codium'] },
  { id: 'zed', name: 'Zed', general: true, cli: ['zed', 'zeditor'], app: /^Zed(?: Preview)?\.app$/i, windows: ['Zed/zed.exe'], linux: [] },
  { id: 'sublime', name: 'Sublime Text', general: true, cli: ['subl', 'sublime_text'], app: /^Sublime Text(?: [34])?\.app$/i, windows: ['Sublime Text/sublime_text.exe', 'Sublime Text 3/sublime_text.exe'], linux: ['/opt/sublime_text/sublime_text'] },
  { id: 'pycharm', name: 'PyCharm', cli: ['pycharm', 'pycharm.sh', 'pycharm64.exe'], app: /^PyCharm(?:[ .-].*)?\.app$/i, folder: /^pycharm/i, binary: 'pycharm', languages: ['Python'] },
  { id: 'webstorm', name: 'WebStorm', cli: ['webstorm', 'webstorm.sh', 'webstorm64.exe'], app: /^WebStorm(?:[ .-].*)?\.app$/i, folder: /^webstorm/i, binary: 'webstorm', languages: ['JavaScript', 'TypeScript', 'HTML', 'CSS'] },
  { id: 'phpstorm', name: 'PhpStorm', cli: ['phpstorm', 'phpstorm.sh', 'phpstorm64.exe'], app: /^PhpStorm(?:[ .-].*)?\.app$/i, folder: /^phpstorm/i, binary: 'phpstorm', languages: ['PHP', 'JavaScript', 'TypeScript', 'HTML', 'CSS'] },
  { id: 'intellij', name: 'IntelliJ IDEA', cli: ['idea', 'idea.sh', 'idea64.exe'], app: /^IntelliJ IDEA(?:[ .-].*)?\.app$/i, folder: /^(?:intellij|idea)/i, binary: 'idea', languages: ['Java', 'Kotlin'] },
  { id: 'rider', name: 'Rider', cli: ['rider', 'rider.sh', 'rider64.exe'], app: /^Rider(?:[ .-].*)?\.app$/i, folder: /^rider/i, binary: 'rider', languages: ['C#', '.NET'] },
  { id: 'clion', name: 'CLion', cli: ['clion', 'clion.sh', 'clion64.exe'], app: /^CLion(?:[ .-].*)?\.app$/i, folder: /^clion/i, binary: 'clion', languages: ['C', 'C++'] },
  { id: 'goland', name: 'GoLand', cli: ['goland', 'goland.sh', 'goland64.exe'], app: /^GoLand(?:[ .-].*)?\.app$/i, folder: /^goland/i, binary: 'goland', languages: ['Go'] },
  { id: 'rustrover', name: 'RustRover', cli: ['rustrover', 'rustrover.sh', 'rustrover64.exe'], app: /^RustRover(?:[ .-].*)?\.app$/i, folder: /^rustrover/i, binary: 'rustrover', languages: ['Rust'] },
  // /usr/bin/xed is an OS stub even when Xcode is absent; require its app bundle.
  { id: 'xcode', name: 'Xcode', cli: [], app: /^Xcode(?:[ .-].*)?\.app$/i, platforms: ['darwin'], languages: ['Swift', 'Objective-C'] },
  { id: 'android-studio', name: 'Android Studio', cli: ['studio', 'studio.sh', 'studio64.exe'], app: /^Android Studio(?:[ .-].*)?\.app$/i, folder: /^android[ -]?studio/i, binary: 'studio', windows: ['Android/Android Studio/bin/studio64.exe'], languages: ['Android', 'Java', 'Kotlin'] },
  { id: 'visual-studio', name: 'Visual Studio', cli: ['devenv'], platforms: ['win32'], languages: ['C#', '.NET', 'C', 'C++'] },
];

function classifyFilename(name) {
  const lower = name.toLowerCase();
  return MANIFESTS[lower] || (/^requirements(?:[.-].*)?\.txt$/.test(lower) ? 'Python' : EXTENSIONS[lower.split('.').pop()]) || null;
}

async function scanLanguages(cwd, { fileSystem = fs, maxEntries = 1500, maxDirectories = 80, maxDepth = 2 } = {}) {
  const languages = new Set();
  const queue = [{ directory: cwd, depth: 0 }];
  let seen = 0;
  let directories = 0;
  while (queue.length && directories < maxDirectories && seen < maxEntries) {
    const { directory, depth } = queue.shift();
    directories++;
    try {
      const handle = await fileSystem.opendir(directory);
      const children = [];
      let marker = false;
      for await (const entry of handle) {
        if (++seen > maxEntries) break;
        const lower = entry.name.toLowerCase();
        if (depth === 0 && ['.git', '.idea', '.vscode'].includes(lower) && (entry.isDirectory() || entry.isFile())) marker = true;
        if (entry.isDirectory() && !entry.isSymbolicLink() && depth < maxDepth && !IGNORED.has(lower)) children.push(entry);
        if (entry.isFile()) {
          const language = classifyFilename(entry.name);
          // A home folder containing shell configuration is not a coding project.
          if (language && !(entry.name.startsWith('.') && ['Shell', 'PowerShell'].includes(language))) languages.add(language);
        }
      }
      const qualified = depth > 0 || marker || languages.size > 0;
      for (const entry of children) {
        // Ordinary parent folders never inherit languages from unrelated nested
        // projects. Recognized source containers can qualify an otherwise plain root.
        if (!qualified && !SOURCE_CONTAINERS.has(entry.name.toLowerCase())) continue;
        if (queue.length + directories >= maxDirectories) break;
        queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
      }
    } catch { /* Unreadable folders do not block the terminal. */ }
  }
  return [...languages].sort((a, b) => a.localeCompare(b));
}

function platformRoots({ platform = process.platform, home = os.homedir(), environment = process.env, pathApi = platform === 'win32' ? path.win32 : path.posix } = {}) {
  const localAppData = environment.LOCALAPPDATA || pathApi.join(home, 'AppData', 'Local');
  return {
    applications: platform === 'darwin' ? ['/Applications', pathApi.join(home, 'Applications')] : [],
    programFiles: platform === 'win32' ? [...new Set([environment.ProgramFiles, environment['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean))] : [],
    localPrograms: platform === 'win32' ? [pathApi.join(localAppData, 'Programs')] : [],
    linuxRoots: platform === 'linux' ? ['/opt', '/opt/jetbrains', pathApi.join(home, '.local', 'share', 'JetBrains', 'Toolbox', 'apps')] : [],
    toolboxRoots: platform === 'win32' ? [pathApi.join(localAppData, 'JetBrains', 'Toolbox', 'apps')] : platform === 'darwin' ? [pathApi.join(home, 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'apps')] : [],
  };
}

async function discoverEditors({ platform = process.platform, home = os.homedir(), environmentPath = process.env.PATH || '', cwd = home, environment = process.env, fileSystem = fs, pathApi = platform === 'win32' ? path.win32 : path.posix, roots = platformRoots({ platform, home, environment, pathApi }) } = {}) {
  const catalog = CATALOG.filter(editor => !editor.platforms || editor.platforms.includes(platform));
  const found = new Map();
  async function executable(target) {
    try {
      if (!(await fileSystem.stat(target)).isFile()) return false;
      if (platform !== 'win32') await fileSystem.access(target, constants.X_OK);
      return true;
    } catch { return false; }
  }
  async function appBundle(target) {
    try { return (await fileSystem.stat(target)).isDirectory() && (await fileSystem.stat(pathApi.join(target, 'Contents', 'Info.plist'))).isFile(); } catch { return false; }
  }
  async function add(editor, target, kind = 'executable') {
    if (found.has(editor.id)) return;
    if (kind === 'app' ? await appBundle(target) : await executable(target)) found.set(editor.id, { ...editor, target, kind });
  }
  async function children(directory) {
    try { return (await fileSystem.readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).slice(0, 100); } catch { return []; }
  }
  // App bundles are the normal macOS installation entry points, even without CLI shims.
  for (const directory of roots.applications || []) {
    for (const entry of await children(directory)) {
      const editor = catalog.find(candidate => candidate.app?.test(entry.name));
      if (editor) await add(editor, pathApi.join(directory, entry.name), 'app');
    }
  }
  const pathDirectories = [...new Set(environmentPath.split(platform === 'win32' ? ';' : ':').filter(Boolean).map(directory => pathApi.resolve(cwd, directory)))].slice(0, 100);
  for (const editor of catalog) {
    for (const directory of pathDirectories) {
      for (const command of editor.cli) {
        if (platform === 'win32') {
          if (command.endsWith('.sh')) continue;
          await add(editor, pathApi.join(directory, command.endsWith('.exe') ? command : `${command}.exe`));
          // Never execute .cmd through cmd.exe. Resolve known vendor CLI shims to their GUI exe.
          const wrapper = pathApi.join(directory, `${command}.cmd`);
          try {
            if ((await fileSystem.stat(wrapper)).isFile()) {
              for (const filename of editor.wrapperExe || []) await add(editor, pathApi.join(directory, '..', filename));
            }
          } catch {}
        } else await add(editor, pathApi.join(directory, command));
        if (found.has(editor.id)) break;
      }
      if (found.has(editor.id)) break;
    }
  }
  if (platform === 'win32') {
    for (const directory of [...(roots.programFiles || []), ...(roots.localPrograms || [])]) {
      for (const editor of catalog) for (const relative of editor.windows || []) await add(editor, pathApi.join(directory, ...relative.split('/')));
      for (const entry of await children(pathApi.join(directory, 'JetBrains'))) {
        const editor = catalog.find(candidate => candidate.folder?.test(entry.name));
        if (editor) for (const binary of [`${editor.binary}64.exe`, `${editor.binary}.exe`]) await add(editor, pathApi.join(directory, 'JetBrains', entry.name, 'bin', binary));
      }
      const visualStudio = catalog.find(editor => editor.id === 'visual-studio');
      const vsRoot = pathApi.join(directory, 'Microsoft Visual Studio');
      for (const version of await children(vsRoot)) {
        for (const edition of ['Community', 'Professional', 'Enterprise']) await add(visualStudio, pathApi.join(vsRoot, version.name, edition, 'Common7', 'IDE', 'devenv.exe'));
      }
    }
  }
  if (platform === 'linux') for (const editor of catalog) for (const target of editor.linux || []) await add(editor, target);
  // Toolbox and /opt installs use product/version/channel directories. Walk only
  // these known installation roots, bounded independently of project scanning.
  for (const root of [...(roots.linuxRoots || []), ...(roots.toolboxRoots || [])]) {
    let examined = 0;
    const queue = [{ directory: root, depth: 0, editor: null }];
    while (queue.length && examined++ < 150) {
      const item = queue.shift();
      if (item.editor?.binary) {
        const binaries = platform === 'win32' ? [`${item.editor.binary}64.exe`, `${item.editor.binary}.exe`] : [item.editor.binary, `${item.editor.binary}.sh`];
        for (const binary of binaries) await add(item.editor, pathApi.join(item.directory, 'bin', binary));
      }
      if (item.depth >= 4) continue;
      for (const entry of await children(item.directory)) {
        if (['plugins', 'lib', 'jbr', 'cache', 'bin'].includes(entry.name.toLowerCase())) continue;
        const editor = item.editor || catalog.find(candidate => candidate.folder?.test(entry.name));
        if (!editor && item.depth > 0) continue;
        const target = pathApi.join(item.directory, entry.name);
        if (platform === 'darwin' && editor?.app?.test(entry.name)) await add(editor, target, 'app');
        if (queue.length < 150) queue.push({ directory: target, depth: item.depth + 1, editor });
      }
    }
  }
  return [...found.values()];
}

function rankEditors(editors, languages) {
  const score = editor => (editor.languages || []).filter(language => languages.includes(language)).length * 200 + (editor.general ? 100 : 0);
  return [...editors].sort((a, b) => score(b) - score(a) || CATALOG.findIndex(editor => editor.id === a.id) - CATALOG.findIndex(editor => editor.id === b.id));
}

function contextualEditors(editors, languages) {
  if (!languages.length) return [];
  return rankEditors(editors.filter(editor => editor.general || (editor.languages || []).some(language => languages.includes(language))), languages);
}

/** Read only known installed product assets; never a path supplied by the renderer. */
async function installedIcon(editor, { platform, fileSystem, pathApi, getIcon }) {
  let target = editor.target;
  try { target = await fileSystem.realpath(target); } catch { /* The verified discovery path remains usable. */ }
  if (platform === 'darwin' && editor.kind !== 'app') {
    const bundleEnd = target.toLowerCase().indexOf('.app/');
    if (bundleEnd >= 0) {
      const bundle = target.slice(0, bundleEnd + 4);
      try {
        if ((await fileSystem.stat(pathApi.join(bundle, 'Contents', 'Info.plist'))).isFile()) target = bundle;
      } catch {}
    }
  }
  if (platform === 'linux') {
    const directory = pathApi.dirname(target);
    const names = {
      vscode: ['code.png', 'vscode.png'], vscodium: ['codium.png', 'vscodium.png', 'code.png'],
      cursor: ['cursor.png', 'code.png'], antigravity: ['antigravity.png', 'code.png'],
      zed: ['zed.png', 'zed.svg'], sublime: ['sublime-text.png'],
      pycharm: ['pycharm.svg', 'pycharm.png'], webstorm: ['webstorm.svg', 'webstorm.png'],
      phpstorm: ['phpstorm.svg', 'phpstorm.png'], intellij: ['idea.svg', 'idea.png'],
      rider: ['rider.svg', 'rider.png'], clion: ['clion.svg', 'clion.png'], goland: ['goland.svg', 'goland.png'],
      rustrover: ['rustrover.svg', 'rustrover.png'], 'android-studio': ['studio.svg', 'studio.png'],
    }[editor.id] || [];
    const directories = [directory, pathApi.join(directory, 'resources', 'app', 'resources', 'linux'), pathApi.join(directory, '..', 'resources', 'app', 'resources', 'linux'), pathApi.join(directory, 'Icon', '256x256'), '/usr/share/pixmaps', '/usr/share/icons/hicolor/256x256/apps', '/usr/share/icons/hicolor/scalable/apps'];
    for (const directory of directories) for (const name of names) {
      const iconPath = pathApi.join(directory, name);
      try {
        const stat = await fileSystem.stat(iconPath);
        if (!stat.isFile() || stat.size > 1_048_576) continue;
        const bytes = await fileSystem.readFile(iconPath);
        const png = name.endsWith('.png') && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const svg = name.endsWith('.svg') && /<svg[\s>]/i.test(bytes.subarray(0, 1024).toString('utf8'));
        if (png || svg) return `data:image/${png ? 'png' : 'svg+xml'};base64,${bytes.toString('base64')}`;
      } catch { /* Try the next installed asset or the native app icon. */ }
    }
  }
  try {
    const icon = await getIcon?.(target);
    if (typeof icon === 'string' && icon.startsWith('data:image/') && icon.length <= 1_500_000) return icon;
  } catch { /* The renderer uses the product's branded vector fallback. */ }
  return undefined;
}

function launchEditor(editor, cwd, { platform = process.platform, spawnProcess = spawn, environmentPath = process.env.PATH || '' } = {}) {
  const bundle = editor.kind === 'app';
  const executable = bundle ? '/usr/bin/open' : editor.target;
  const args = bundle ? ['-a', editor.target, cwd] : [cwd];
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnProcess(executable, args, { shell: false, detached: !bundle, stdio: 'ignore', windowsHide: false, env: { ...process.env, PATH: environmentPath } }); } catch (error) { reject(error); return; }
    child.once('error', reject);
    if (bundle) child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Could not open ${editor.name}.`)));
    else child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function createEditorService({ platform = process.platform, home = os.homedir(), fileSystem = fs, now = Date.now, discover = discoverEditors, scan = scanLanguages, launch = launchEditor, getIcon, ttl = 30000, ...discoveryOptions } = {}) {
  const cache = new Map();
  const iconCache = new Map();
  const pathApi = discoveryOptions.pathApi || (platform === 'win32' ? path.win32 : path.posix);
  async function installed(cwd, environmentPath, refresh = false) {
    const key = `${cwd}\0${environmentPath}`;
    const previous = cache.get(key);
    if (!refresh && previous && now() - previous.time < ttl) return previous.value;
    const value = await discover({ ...discoveryOptions, platform, home, cwd, environmentPath, fileSystem });
    cache.set(key, { time: now(), value });
    if (cache.size > 32) cache.delete(cache.keys().next().value);
    return value;
  }
  return {
    async projectEditors(cwd, environmentPath, refresh = false) {
      const [languages, editors] = await Promise.all([scan(cwd, { fileSystem }), installed(cwd, environmentPath, refresh)]);
      const relevant = contextualEditors(editors, languages);
      return { languages, editors: await Promise.all(relevant.map(async editor => {
        if (refresh) iconCache.delete(editor.target);
        if (!iconCache.has(editor.target)) {
          iconCache.set(editor.target, installedIcon(editor, { platform, fileSystem, pathApi, getIcon }));
          if (iconCache.size > 64) iconCache.delete(iconCache.keys().next().value);
        }
        const icon = await iconCache.get(editor.target);
        return icon ? { id: editor.id, name: editor.name, icon } : { id: editor.id, name: editor.name };
      })) };
    },
    async openEditor(cwd, environmentPath, editorId) {
      if (typeof editorId !== 'string' || !CATALOG.some(editor => editor.id === editorId)) throw new Error('Unknown editor.');
      if (!(await fileSystem.stat(cwd)).isDirectory()) throw new Error('The current path is not a directory.');
      const editor = (await installed(cwd, environmentPath)).find(editor => editor.id === editorId);
      if (!editor) throw new Error('This editor is not installed. Refresh the editor list.');
      const languages = await scan(cwd, { fileSystem });
      if (!contextualEditors([editor], languages).length) throw new Error('This editor does not match the current coding folder.');
      // Recheck the target before using a cached discovery result.
      const target = await fileSystem.stat(editor.target);
      if (editor.kind === 'app' ? !target.isDirectory() : !target.isFile()) throw new Error('The selected editor is unavailable.');
      if (editor.kind !== 'app' && platform !== 'win32') await fileSystem.access(editor.target, constants.X_OK);
      return launch(editor, cwd, { platform, environmentPath });
    },
  };
}

module.exports = { classifyFilename, scanLanguages, platformRoots, discoverEditors, rankEditors, contextualEditors, launchEditor, createEditorService };
