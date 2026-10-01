<p align="center">
  <img src="build/icon.svg" alt="Mullion Terminal" width="96">
</p>

<h1 align="center">Mullion Terminal</h1>

<p align="center">
  <strong>A standalone desktop terminal with Mullion's familiar look.</strong><br>
  Local command learning, a directory sidebar, and one-click editors — for macOS, Windows and Linux.
</p>

<p align="center">
  <a href="https://github.com/anabiiil/mullion-terminal/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/anabiiil/mullion-terminal?color=FF6B4A&label=release"></a>
  <img alt="Platforms: macOS, Windows, Linux" src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-1C2333">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/anabiiil/mullion-terminal?color=1C2333"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#features">Features</a> ·
  <a href="#keyboard-shortcuts">Keyboard shortcuts</a> ·
  <a href="https://github.com/anabiiil/mullion-terminal/wiki">Wiki</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img src="docs/screenshots/hero.png" alt="Mullion Terminal with the directory sidebar open and a shell session running" width="820">
</p>

Mullion Terminal is a real interactive shell in a window that looks and feels like [Mullion](https://github.com/anabiiil/mullion), the author's local dev environment. Every tab runs your actual zsh, bash or PowerShell session — not an emulation — with suggestions learned from your own history, a directory tree that changes folders without restarting the shell, and one click into the editor or IDE that matches the project you're in.

## Why

- **It's your shell, not a wrapper.** Tabs run a real zsh/bash/PowerShell process through [node-pty](https://github.com/microsoft/node-pty). Interactive programs, resizing, and normal shell editing all work as expected.
- **It learns from you, locally.** Suggestions blend commands you've typed before with paths and filenames from the current directory. Nothing leaves the device.
- **The sidebar doesn't interrupt the shell.** Clicking a folder changes directory quietly, in the same session — scrollback, shell variables and pending input stay put.
- **The right editor, one click away.** Open the current folder in VS Code, a JetBrains IDE, Xcode and more — icons appear only when the folder looks like a coding project.

## Features

<p align="center">
  <img src="docs/screenshots/autocomplete.png" alt="Auto-complete on: a suggestion popup below the prompt" width="760">
</p>

**Terminal & tabs**
- The terminal fills the window beneath a compact titlebar; no separate "terminal" panel inside a bigger app.
- The `+` button and `Cmd/Ctrl+T` open a new, independent tab at your home directory.
- A compact path chip in the titlebar shows the current folder; click it to copy the absolute path.
- The adjacent folder button opens the current directory in Finder, File Explorer or the Linux file manager.
- An **Open folder** button lets you start or move a tab to any directory.

**Suggestions & auto-complete**
- Suggestions combine shell commands, filesystem paths, and commands you've previously run in this app.
- A slim row along the terminal's bottom edge keeps your most-used and pinned commands within reach, even before you've built any history.
- With **auto-complete on**, a suggestion list appears near the prompt; with it **off**, the best match appears as faint inline ghost text instead. See [Suggestions & auto-complete](#suggestions--auto-complete) below.

<p align="center">
  <img src="docs/screenshots/sidebar-tree.png" alt="The Files sidebar showing a directory tree with the current folder selected" width="760">
</p>

**Directory tree**
- A sidebar (closed by default; `Cmd/Ctrl+B` or the Files icon toggles it) shows a folder tree.
- Clicking a folder changes directory in the same shell session, quietly — the tree doesn't "dive into" the folder, it just shows it selected in place.
- Typing `cd` in the shell selects that directory in the tree and expands its ancestors.
- Clicking a file changes to its containing directory; double-clicking opens it with the system's default application.

<p align="center">
  <img src="docs/screenshots/editors.png" alt="Editor icons in the titlebar for a detected code project" width="760">
</p>

**Editors & IDEs**
- Coding folders show installed editor icons in the titlebar: hover for the name, click to open the current folder.
- General-purpose editors (VS Code, Cursor, Antigravity, VSCodium, Zed, Sublime Text) appear for any detected project; specialized IDEs only appear when their language matches.
- Ordinary folders — like your home directory — never show editor icons, and a folder doesn't inherit editors from unrelated projects nested inside it.
- A refresh button rescans installed editors after you install a new one.

<p align="center">
  <img src="docs/screenshots/history.png" alt="The command history sidebar with search and pinning" width="760">
</p>

**Command history**
- The History sidebar lists every saved command, with search, and sorting by most-used or most-recent.
- Pin commands to keep them at the top and in the quick-commands bar.
- Clicking a command fills the prompt without running it.

<p align="center">
  <img src="docs/screenshots/settings.png" alt="The Settings panel" width="420">
  <img src="docs/screenshots/light-theme.png" alt="Mullion Terminal in light mode" width="420">
</p>

**Settings & appearance**
- Light and dark themes, in Mullion's palette.
- Adjustable terminal font size, and a toggle to show hidden files in the tree.
- Learning stays on this device — see [Where data is stored](#where-data-is-stored).

## Install

Download the latest build from **[Releases](https://github.com/anabiiil/mullion-terminal/releases/latest)**.

### macOS

Download `Mullion-Terminal-<version>-mac-arm64.dmg` (Apple Silicon), open it, and drag **Mullion Terminal** to the Applications shortcut.

The app isn't code-signed or notarized, so the first launch needs one extra step. Either:

- Right-click (or Control-click) **Mullion Terminal** in Applications and choose **Open**, then confirm in the dialog that appears, or
- Clear the quarantine flag from a terminal:
  ```sh
  xattr -dr com.apple.quarantine "/Applications/Mullion Terminal.app"
  ```

### Windows

Download `Mullion-Terminal-<version>-win-x64.exe` and run it. It's an NSIS installer that lets you choose the install directory.

The installer isn't signed, so Windows SmartScreen may show **Windows protected your PC** the first time. Click **More info**, then **Run anyway**.

### Linux

- **AppImage:** download `Mullion-Terminal-<version>-linux-x86_64.AppImage`, make it executable, then run it:
  ```sh
  chmod +x Mullion-Terminal-*-linux-x86_64.AppImage
  ./Mullion-Terminal-*-linux-x86_64.AppImage
  ```
- **Debian/Ubuntu (.deb):** download `Mullion-Terminal-<version>-linux-amd64.deb` and install it:
  ```sh
  sudo apt install ./Mullion-Terminal-*-linux-amd64.deb
  ```

## Quick start

```sh
npm ci
npm run dev
```

`npm run dev` starts the desktop app with its Vite development server. The app opens with one tab already running at your home directory.

- `Cmd/Ctrl+T` — open a new tab at Home
- `Cmd/Ctrl+B` — toggle the Files sidebar
- Click a folder in the sidebar to change into it, or type `cd` in the shell to select it there
- Start typing a command to see suggestions; `Tab` accepts, `Enter` runs

## Suggestions & auto-complete

<p align="center">
  <img src="docs/screenshots/inline-suggestions.png" alt="Auto-complete off: faint inline ghost text with no popup" width="760">
</p>

Toggle **Auto-complete** in Settings to switch between two modes:

| | Auto-complete **on** | Auto-complete **off** |
| --- | --- | --- |
| Display | A suggestion list appears near the prompt | A single best match appears as faint inline ghost text — no popup |
| `Tab` | Accepts the highlighted suggestion, without running it | Accepts the inline text |
| `Enter` | Accepts the highlighted suggestion **and runs it** | Runs exactly what you typed |
| `↑` / `↓` | Choose a different suggestion | Not used — shell history, once suggestions are closed |
| `Esc` | Dismiss the suggestion list | Dismiss the inline suggestion |
| Empty history, filesystem commands (`cd`, `rm`, `ls`, `cat`, `cp`, `mv`, …) | Waits for a filename prefix before suggesting operands | Suggests files or folders from the current directory immediately, even with nothing typed yet |

In both modes, suggestions blend your command history (ranked by frequency and recency, with pinned and current-directory commands first) with filesystem paths and shell commands.

## Keyboard shortcuts

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| New terminal tab | `Cmd+T` / `Ctrl+T` | `Ctrl+T` |
| Close active tab | `Cmd+W` / `Ctrl+W` | `Ctrl+W` |
| Toggle Files sidebar | `Cmd+B` / `Ctrl+B` | `Ctrl+B` |
| Settings | `Cmd+,` / `Ctrl+,` | `Ctrl+,` |
| Copy selected terminal text | `Cmd+C` / `Ctrl+C` | `Ctrl+C` / `Ctrl+Shift+C` |
| Paste | `Cmd+V` / `Ctrl+V` / `Ctrl+Shift+V` | `Ctrl+V` / `Ctrl+Shift+V` |
| Clear terminal scrollback | `Cmd+K` / `Ctrl+Shift+K` | `Ctrl+Shift+K` |
| Accept suggestion | `Tab` | `Tab` |
| Dismiss suggestions | `Escape` | `Escape` |
| Shell history, with suggestions closed | `↑` / `↓` | `↑` / `↓` |

`Ctrl+C` keeps the shell's normal interrupt behavior when nothing is selected — it only copies when there's a selection. Ctrl shortcuts work on every platform, including macOS; `Ctrl+A`, `Ctrl+E`, `Ctrl+U` and unshifted `Ctrl+K` keep their normal shell-editing behavior (readline/ZLE), rather than being captured by the app.

## Editors & IDEs

Coding folders show installed editor icons in the titlebar, detected by scanning the folder (two levels deep) for recognizable source files and project manifests. General editors appear for any detected language:

- Visual Studio Code, Cursor, Antigravity, VSCodium, Zed, Sublime Text

Specialized IDEs appear only when their language is present:

- PyCharm, WebStorm, PhpStorm, IntelliJ IDEA, Rider, CLion, GoLand, RustRover
- Xcode (macOS only), Android Studio
- Visual Studio (Windows only)

Discovery looks in the usual install locations for each platform — macOS `/Applications` and app bundles, Windows Program Files and JetBrains Toolbox, Linux `PATH` and common install directories — and the refresh button rescans on demand.

## Settings

Open Settings with the gear icon or `Cmd/Ctrl+,`:

- **Auto-complete** — popup suggestions vs. inline ghost text (see [above](#suggestions--auto-complete)).
- **Suggestions while typing** — turn suggestions off entirely.
- **Theme** — light or dark, in Mullion's palette.
- **Terminal font size** — 11–20px.
- **Show hidden files** — include dotfiles in the directory tree.
- **Clear history** — removes the app's saved commands (two-step confirmation).

## Where data is stored

Settings and up to 1,000 saved commands are stored locally in `preferences.json`, under Electron's `userData` directory for the app. Each saved command keeps its text, use count, last-used time, directory and pin state. There is no cloud sync and no external shell-history import — everything stays on the device, and **Settings → Clear history** removes it.

## FAQ & troubleshooting

**macOS says the app is damaged or can't be opened.**
The app isn't notarized. Right-click it in Applications and choose **Open** once, or run `xattr -dr com.apple.quarantine "/Applications/Mullion Terminal.app"` in a terminal.

**Windows SmartScreen blocks the installer.**
The installer isn't signed. Click **More info**, then **Run anyway**.

**The AppImage won't run on Linux.**
Make sure it's executable: `chmod +x Mullion-Terminal-*.AppImage`. Some distributions also need `libfuse2` installed for AppImages in general.

**Editor icons aren't showing up.**
They only appear for folders that look like coding projects (manifests like `package.json` or `composer.json`, or recognizable source files). Ordinary folders, like your home directory, never show them. If you just installed an editor, click the refresh icon next to the editor buttons.

**Suggestions aren't appearing.**
Check that **Suggestions while typing** is on in Settings. The popup or inline hint only appears once the shell prompt is ready and idle.

**Which shells are supported?**
zsh or bash on macOS and Linux, and PowerShell 7 (or Windows PowerShell as a fallback) on Windows. Shell integration is loaded through temporary configuration files — the app doesn't modify your shell profiles. Fish and `cmd.exe` aren't supported by the current prompt integration.

## Building from source

Requires Node.js 24 and npm. Building the native `node-pty` dependency may need Xcode Command Line Tools on macOS, Visual Studio C++ Build Tools on Windows, or Python and a C++ toolchain on Linux.

```sh
npm ci              # install dependencies and rebuild native modules
npm run dev          # desktop app + Vite dev server
npm run check        # tests, TypeScript, and a production build
npm run dist:mac     # macOS: DMG and ZIP
npm run dist:win     # Windows: NSIS installer (run on Windows)
npm run dist:linux   # Linux: AppImage and DEB (run on Linux)
npm run screenshots  # regenerate the images in docs/screenshots/
```

Each installer is built on its matching OS, since `node-pty` is a native dependency. Output is written to `release/`.

## Releasing

Pushing a tag of the form `vX.Y.Z` triggers the GitHub Actions workflow, which builds the macOS, Windows and Linux installers and publishes them to a GitHub Release with that tag — the assets land on the **[latest release page](https://github.com/anabiiil/mullion-terminal/releases/latest)**. CI builds are unsigned; production code-signing and notarization are left to whoever distributes a signed build.

## License

[MIT](LICENSE) © 2026 Abdelrahman Nabil

## استخدام سريع

شغّل `npm run dev` لفتح التطبيق. التيرمنال بيملأ النافذة، وأزرار المسار والمجلدات والمحررات والإعدادات في الشريط العلوي. الـ sidebar مقفولة افتراضيًا؛ افتحها من أيقونة الملفات أو سجل الأوامر. الضغط على فولدر يغير المجلد بهدوء داخل نفس جلسة الـ shell، و`cd` يحدد المجلد مكانه في الشجرة. زرار `+` يفتح تاب جديدة في الـ Home. لو Auto-complete شغّال بيظهر بوكس اقتراحات وEnter يختار وينفّذ؛ لو مقفول بتظهر تكملة خفيفة في نفس السطر، Tab يقبلها وEnter ينفّذ اللي كتبته. أيقونات المحررات بتظهر حسب ملفات المشروع الحالي، والأوامر الأكثر استخدامًا موجودة في سطر صغير جوّه التيرمنال من تحت خالص. الضغط على أي أمر بيكتبه في سطر الأوامر من غير تنفيذ.

## Related

Mullion Terminal shares its look with [Mullion](https://github.com/anabiiil/mullion), a local PHP & Node development environment by the same author.

