import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Builds a realistic demo environment and captures polished, README-quality
// screenshots of the app. Run after `npm run build`. Reuses the launch
// technique from scripts/smoke.mjs (a temp HOME with ZDOTDIR + a themed
// .zshrc PROMPT, --user-data-dir, --cwd, hiding the window before screenshots).

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'docs', 'screenshots');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mullion-screenshots-')));
const home = path.join(temporary, 'home');
const projects = path.join(home, 'Projects');
const shopApi = path.join(projects, 'shop-api');
const storefront = path.join(projects, 'storefront');
const bin = path.join(home, '.bin');

await fs.mkdir(outDir, { recursive: true });

// --- Demo project: shop-api (PHP / Laravel-style) ---------------------------
await fs.mkdir(path.join(shopApi, 'app', 'Models'), { recursive: true });
await fs.mkdir(path.join(shopApi, 'app', 'Http', 'Controllers'), { recursive: true });
await fs.mkdir(path.join(shopApi, 'routes'), { recursive: true });
await fs.mkdir(path.join(shopApi, 'public'), { recursive: true });
await fs.writeFile(path.join(shopApi, 'composer.json'), JSON.stringify({
  name: 'acme/shop-api',
  type: 'project',
  require: { php: '^8.2', 'laravel/framework': '^11.0' },
}, null, 2) + '\n');
await fs.writeFile(path.join(shopApi, 'README.md'), '# shop-api\n\nInventory and checkout API for the storefront.\n');
await fs.writeFile(path.join(shopApi, 'app', 'Models', 'Product.php'), [
  '<?php', '', 'namespace App\\Models;', '', 'use Illuminate\\Database\\Eloquent\\Model;', '', 'class Product extends Model', '{',
  '    protected $fillable = [\'name\', \'price\', \'sku\'];', '}', '',
].join('\n'));
await fs.writeFile(path.join(shopApi, 'app', 'Http', 'Controllers', 'ProductController.php'), [
  '<?php', '', 'namespace App\\Http\\Controllers;', '', 'use App\\Models\\Product;', '', 'class ProductController extends Controller', '{',
  '    public function index()', '    {', '        return Product::query()->paginate(20);', '    }', '}', '',
].join('\n'));
await fs.writeFile(path.join(shopApi, 'routes', 'web.php'), "<?php\n\nRoute::get('/', fn () => view('welcome'));\n");
await fs.writeFile(path.join(shopApi, 'routes', 'api.php'), "<?php\n\nRoute::apiResource('products', ProductController::class);\n");
await fs.writeFile(path.join(shopApi, 'public', 'index.php'), "<?php\n\nrequire __DIR__.'/../vendor/autoload.php';\n");

// --- Demo project: storefront (React / Vite) --------------------------------
await fs.mkdir(path.join(storefront, 'src', 'components'), { recursive: true });
await fs.mkdir(path.join(storefront, 'public'), { recursive: true });
await fs.writeFile(path.join(storefront, 'package.json'), JSON.stringify({
  name: 'storefront',
  version: '1.0.0',
  scripts: { dev: 'vite', build: 'vite build', test: 'vitest' },
  dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
}, null, 2) + '\n');
await fs.writeFile(path.join(storefront, 'README.md'), '# storefront\n\nCustomer-facing shop built with React and Vite.\n');
await fs.writeFile(path.join(storefront, 'src', 'index.js'), "import './App';\n");
await fs.writeFile(path.join(storefront, 'src', 'App.jsx'), [
  "import ProductCard from './components/ProductCard';", "import Cart from './components/Cart';", '',
  'export default function App() {', '  return (', '    <main>', '      <ProductCard />', '      <Cart />', '    </main>', '  );', '}', '',
].join('\n'));
await fs.writeFile(path.join(storefront, 'src', 'components', 'ProductCard.jsx'), 'export default function ProductCard() { return <div className="product-card" />; }\n');
await fs.writeFile(path.join(storefront, 'src', 'components', 'Cart.jsx'), 'export default function Cart() { return <aside className="cart" />; }\n');
await fs.writeFile(path.join(storefront, 'public', 'index.html'), '<!doctype html><title>storefront</title>\n');

// --- Fake `git` / `npm` binaries so output looks real without touching the network.
await fs.mkdir(bin, { recursive: true });
await fs.writeFile(path.join(bin, 'git'), [
  '#!/bin/sh', 'case "$1" in', '  status)',
  "    printf 'On branch main\\nYour branch is up to date with '\\''origin/main'\\''.\\n\\nnothing to commit, working tree clean\\n'",
  '    ;;', '  log)',
  "    printf 'a3f9c12 Polish checkout flow styling\\n7b2e441 Add product filters to catalog page\\ne819f3d Fix cart total rounding\\n'",
  '    ;;', '  *) exit 0 ;;', 'esac', '',
].join('\n'), { mode: 0o700 });
await fs.writeFile(path.join(bin, 'npm'), [
  '#!/bin/sh', 'case "$1" in', '  install)',
  "    printf 'up to date, audited 214 packages in 1s\\n\\nfound 0 vulnerabilities\\n'",
  '    ;;', '  run)',
  "    printf '\\n> storefront@1.0.0 build\\n> vite build\\n\\nvite v5.4.0 building for production...\\n\\xe2\\x9c\\x93 42 modules transformed.\\ndist/index.html                  0.46 kB\\ndist/assets/index-C8f2a1.js     88.21 kB\\n\\xe2\\x9c\\x93 built in 612ms\\n'",
  '    ;;', '  test)',
  "    printf 'PASS  src/App.test.jsx\\n  \\xe2\\x9c\\x93 renders storefront header (12 ms)\\n  \\xe2\\x9c\\x93 adds item to cart (8 ms)\\n\\nTests: 2 passed, 2 total\\n'",
  '    ;;', '  *) exit 0 ;;', 'esac', '',
].join('\n'), { mode: 0o700 });

// A pretty, realistic prompt: cyan path relative to HOME + yellow chevron.
await fs.writeFile(path.join(home, '.zshrc'), [
  `export PATH='${bin}:/usr/bin:/bin'`,
  "HISTFILE=''", 'SAVEHIST=0', 'HISTSIZE=0',
  'PROMPT="%F{cyan}%~%f %F{yellow}❯%f "', "RPROMPT=''", '',
].join('\n'));

const executablePath = process.env.MULLION_SMOKE_EXECUTABLE;
const app = await electron.launch({
  executablePath,
  args: [
    ...(executablePath ? [] : [root]),
    `--user-data-dir=${path.join(temporary, 'preferences')}`,
    `--cwd=${projects}`,
  ],
  env: { ...process.env, HOME: home, ZDOTDIR: home, SHELL: '/bin/zsh', HISTCONTROL: 'ignoredups', TERMINAL_DEV_URL: '' },
  timeout: 30000,
});

let page;
try {
  // Guard against the window not existing yet (racing app startup) the same
  // way scripts/smoke.mjs does, since indexing an empty array and calling a
  // method on `undefined` here would throw inside the main process and hang
  // the rest of the script waiting on a window that is never created.
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) { window.removeAllListeners('ready-to-show'); window.hide(); }
  });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800); });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  const term = page.locator('.shell-pane.active .xterm-helper-textarea');
  const bar = page.locator('.editor-launcher[aria-label="Project editors"]');

  async function ready() {
    await page.locator('.shell-state.ready').waitFor({ timeout: 15000 });
    await page.waitForTimeout(180);
  }
  const history = () => page.evaluate(() => window.terminalAPI.bootstrap().then(value => value.history));
  async function waitHistory(predicate) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const entries = await history();
      if (predicate(entries)) return entries;
      await page.waitForTimeout(50);
    }
    throw new Error('Command history did not reach the expected state within 15 seconds');
  }
  async function run(command) {
    await ready();
    const previousCount = (await history()).find(value => value.command === command)?.count ?? 0;
    await term.focus();
    await page.keyboard.type(command, { delay: 15 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await waitHistory(entries => entries.some(value => value.command === command && value.count > previousCount));
    await ready();
  }
  async function waitEditors() {
    await page.waitForFunction(() => document.querySelector('.editor-launcher')?.getAttribute('aria-busy') === 'false', undefined, { timeout: 15000 });
  }
  async function openSidebar(which) {
    const label = which === 'files' ? 'Toggle files sidebar' : 'Command history';
    const button = page.getByRole('button', { name: label, exact: true });
    const pressed = await button.getAttribute('aria-pressed');
    if (pressed !== 'true') await button.click();
    await page.waitForTimeout(150);
  }
  async function closeSidebar(which) {
    const label = which === 'files' ? 'Toggle files sidebar' : 'Command history';
    const button = page.getByRole('button', { name: label, exact: true });
    const pressed = await button.getAttribute('aria-pressed');
    if (pressed === 'true') await button.click();
    await page.waitForTimeout(150);
  }
  async function openSettings() {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.waitForTimeout(150);
  }
  async function closeSettings() {
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.waitForTimeout(150);
  }
  async function shot(name) {
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(outDir, name) });
    console.log(`captured ${name}`);
  }

  await ready();
  await term.focus();
  await page.keyboard.press('Control+c');
  await ready();

  // Build a believable history: a browsable checkout project with real tool output.
  await openSidebar('files');
  await run('cd storefront');
  await run('git status');
  await run('npm install');
  await run('npm run build');
  await run('npm test');
  await run('npm test');
  await run('ls');
  await run('git status');
  await waitEditors();
  await shot('hero.png');

  // Light theme, same pleasant state.
  await openSettings();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await closeSettings();
  await shot('light-theme.png');
  await openSettings();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await closeSettings();

  // Auto-complete ON: suggestion popup with several learned commands.
  await closeSidebar('files');
  await term.focus();
  await page.keyboard.type('npm', { delay: 35 });
  await page.getByRole('listbox', { name: 'Command suggestions' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(160);
  await shot('autocomplete.png');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+u');
  await ready();

  // Auto-complete OFF: faint inline ghost-text completion.
  await run('cd ..');
  await openSettings();
  await page.getByRole('checkbox', { name: 'Auto-complete', exact: true }).uncheck();
  await closeSettings();
  await term.focus();
  await page.keyboard.type('cd sto', { delay: 35 });
  await page.locator('.shell-pane.active .inline-suggestion').waitFor({ timeout: 10000 });
  await page.waitForTimeout(160);
  await shot('inline-suggestions.png');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+u');
  await ready();
  await openSettings();
  await page.getByRole('checkbox', { name: 'Auto-complete', exact: true }).check();
  await closeSettings();

  // Sidebar tree: nested folder selected, ancestors expanded.
  await openSidebar('files');
  await run('cd storefront/src');
  await shot('sidebar-tree.png');

  // Editor icons + path chip for a recognized coding project.
  await run('cd ../../shop-api');
  await run('ls');
  await waitEditors();
  await shot('editors.png');

  // History sidebar: most-used commands, one pinned.
  await openSidebar('history');
  await page.getByRole('button', { name: 'Pin npm test', exact: true }).click();
  await page.waitForTimeout(150);
  await shot('history.png');

  // Settings panel.
  await closeSidebar('history');
  await openSettings();
  await shot('settings.png');
  await closeSettings();

  if (errors.length) throw new Error(`Renderer errors during capture: ${errors.join(', ')}`);
  console.log(`Wrote 8 screenshots to ${outDir}`);
} catch (error) {
  await page?.screenshot({ path: path.join(outDir, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
