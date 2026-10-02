# Changelog

All notable changes to Mullion Terminal are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.7] - 2026-10-02

### Fixed
- Windows: double-clicking a folder in the directory tree failed with "Folder navigation requires the shell line editor" on Windows PowerShell 5.1, and accepting a suggestion or a quick command left the old input in place with a stray letter from the keyboard layout (e.g. `ع` on an Arabic layout). PSReadLine 2.0, which ships with Windows, lacks the editing function the app bound to `Ctrl+U`, and that one failure skipped every other binding.
- Windows: switching input language while a tab is open (e.g. Arabic ⇄ English) no longer breaks folder navigation ("The shell did not accept the folder change") or line replacement (which typed letters like `ءل` / `ثع`). The app now uses function-key chords for its own shell commands in PowerShell, which match under any keyboard layout, and `Ctrl+X` stays PSReadLine's Cut.
- Windows: after a folder change, the prompt's `❯` is no longer drawn as `?`. After the terminal is resized (for example, by opening the sidebar), a folder change no longer overwrites the last line of output or leaves the old prompt behind.
- Windows: PowerShell now reports each command's result, so a mistyped command ("is not recognized") or one that never succeeded is no longer learned into history, matching macOS and Linux.
- Windows: with PowerShell 7, suggestions while typing never appeared, because PSReadLine's own gray prediction sat after the cursor. Those predictions are now turned off in the app's tabs.
- Windows: the directory tree and path suggestions no longer list items File Explorer hides (`NTUSER.DAT`, `ntuser.ini`, and junctions like `Application Data` or `Cookies` that deny access); **Show hidden files** still includes them.
- Windows: the window can be dragged from the whole empty title bar instead of only the app name.
- Windows: `npm install` no longer requires Python and the Visual Studio C++ tools (node-pty's prebuilt Windows binaries are used as they are), and no longer fails when the project path contains a space and `node` is a `.cmd` wrapper from a Node version manager. `npm run dist:win` doesn't rebuild native modules either.
- Settings lists Windows shortcuts without macOS `⌘` symbols.

## [0.1.6] - 2026-10-02

### Changed
- A command that fails on its own terms the first time it's run (a typo like `git psuh` or `brew upgrde`, exiting non-zero) is no longer learned as a brand-new history entry — only a command that has succeeded at least once can have its use count bumped by a later failed run. "Command not found" (status 127) and "not executable" (status 126) are still never learned, and stopping a long-running command on purpose (`Ctrl+C`, `SIGTERM`) still counts as learned, same as a normal exit.
- The exit status a shell reports after each command is now captured by a dedicated hook kept at the very front of zsh's `precmd` chain (and the front of bash's `PROMPT_COMMAND`), so a prompt theme's own hooks can no longer leave Mullion reading the wrong status.
- A bare `sudo` or `exec` (nothing after it) and the `yes` command are now treated as basic/routine, like `true`/`false`, and stay out of the History sidebar and quick-commands bar.
- The bottom quick-commands bar now shows a small "Most used" label in front of your learned commands, once there are any.

### Fixed
- The macOS download no longer opens with "Mullion Terminal is damaged": the whole app bundle is now properly signed (ad-hoc), so macOS shows its usual first-launch prompt for apps from outside the App Store instead.
- The History sidebar's command count only counts the commands it lists, not the routine ones (`cd`, `ls`, `clear`…) that are kept only for suggestions.

## [0.1.5] - 2026-10-02

### Added
- Markdown preview: double-clicking a `.md`, `.markdown` or `.mdx` file in the directory tree shows it rendered over the terminal, with **Edit** (opens `nano`, or the default application on Windows), **Open externally** and Close (`Esc`). Web and `mailto:` links open in your browser or mail app, links to other Markdown files open in the same preview, and embedded scripts and unsafe markup are stripped.
- Mouse support for `nano`/`pico`: click to place the cursor, scroll with the mouse wheel to move around a long file, and Option/Alt+drag still selects text to copy (nano's own mark, `Ctrl+^`, selects text to cut). A floating Save / Save & Exit / Exit bar appears while they're running. Opt out with the `MULLION_EDITOR_MOUSE=0` environment variable; an existing `nano`/`pico` alias or shell function always takes precedence.
- A floating editor bar for `vim`/`vi`/`nvim` too, including when it's opened by `git` for a commit, rebase or merge message: **Save & Close** writes and exits (`:wq`), **Close** discards and exits (`:qa!`) — no more typing `:qa!` by hand to get past a rebase editor. `Cmd+S` / `Ctrl+S` also saves (`:w`) while vim is in the foreground.
- **Open with Mullion Terminal** from the OS right-click menu, on macOS, Windows and Linux, and from dropping a file or folder on the app: a folder opens a new tab there, a file opens a new tab in its parent folder with the file opened the same way the sidebar's double-click does. Also works from the command line, e.g. `mullion-terminal ~/code/project`. The app never becomes the default handler for anything. On macOS this includes an **Open in Mullion Terminal** Quick Action in Finder's right-click menu (and the Services menu) that works for any file or folder whatever its type, installed for the current user and toggleable in Settings; **Open With** is offered for folders and for specific text and source file types, instead of claiming every file (which made Finder leave the app out of **Open With** entirely).
- Delete any single command from the History sidebar or the quick-commands bar: a trash button next to each sidebar row's pin star (or Delete/Backspace on a focused command), and a right-click menu on quick commands with Pin/Unpin and Remove from history. A "Removed · Undo" toast brings a deleted command back for a few seconds. This only affects Mullion's own learned history and suggestions, never your shell's own history file.

### Changed
- App shortcuts for a new tab, closing a tab, and toggling the Files sidebar are now `Cmd+T` / `Cmd+W` / `Cmd+B` on macOS and `Ctrl+Shift+T` / `Ctrl+Shift+W` / `Ctrl+Shift+B` on Windows and Linux — plain `Ctrl+T` / `Ctrl+W` / `Ctrl+B` now reach the shell and full-screen editors instead. Settings keeps `Cmd+,` / `Ctrl+,` on every platform.
- `Cmd+C` / `Ctrl+C` copies only when there's a selection (including inside nano/vim) and otherwise keeps the shell's interrupt behavior; `Ctrl+Shift+C` / `Ctrl+Shift+V` always copy/paste. `Ctrl+V` pastes at the shell prompt but passes through unchanged to full-screen programs like nano and vim. `Cmd+S` / `Ctrl+S` now saves while nano/pico is in the foreground.
- Internal navigation commands triggered by clicking the folder tree, and files the tree opens with `nano` on a double-click, are never saved to history, and any already saved are purged automatically on startup. Basic, routine commands — navigation (`cd`, `pushd`, `pwd`, …), listing (`ls`, `dir`, …), file management (`rm`, `cp`, `mv`, `mkdir`, …), basic editors (`nano`, `vim`, …), system info (`whoami`, `date`, `arch`, …) and their PowerShell equivalents — no longer appear in the History sidebar or the quick-commands bar, though most still inform suggestions while typing; `cd`/`pushd`/`popd` and their PowerShell equivalents are never offered as a *learned* suggestion (folder-name completion right after typing `cd ` is unaffected). A command the shell reports as "command not found" is no longer learned either. Suggestion labels now read "Used 3× here", "Command", "Folder" and "File".
- A single click in the directory tree now only expands or collapses a folder, or selects a file, without changing directory. Double-clicking a folder still changes into it (and makes sure it's expanded); double-clicking a file now opens it with `nano` in the active shell on macOS/Linux instead of the system's default application (Windows keeps opening files externally, since PowerShell shells rarely have `nano`).

### Fixed
- Pasting with `Cmd+V` / `Ctrl+V` no longer fails with a "terminal:read-text … slice is not a function" error.
- Shells now start with the same environment as the system terminal when the app is opened from Finder or the Dock: bash on macOS gets `LANG` (a UTF-8 locale for your region, as Terminal.app sets it) instead of the bare C locale, zsh no longer falls back to `C.UTF-8`, and app-internal variables (`ELECTRON_*`, `XPC_SERVICE_NAME`, `MallocNanoZone`, another terminal's `TERM_PROGRAM_VERSION`/`SHLVL`) no longer leak into the shell and every program it runs. `TERM_PROGRAM_VERSION` now reports the app's version. Homebrew, `sudo`, `ssh-agent` and login-shell PATH setup work as in Terminal.app.

## [0.1.4] - 2026-10-02

### Fixed
- `Cmd/Ctrl+V` paste now works reliably in the terminal.

### Added
- Windows and Linux release builds, produced by GitHub Actions alongside the existing macOS build.

## [0.1.3] - 2026-10-02

### Added
- File-name suggestions for `cd` and `rm` (and other filesystem commands) even before any command history exists, so the directory tree isn't the only way to navigate.
- Ctrl-based keyboard shortcuts now work consistently on every platform, including macOS, alongside the Cmd equivalents.

### Changed
- The editor/IDE launcher is now icon-only and appears solely when the current folder looks like a code project; it no longer shows for ordinary folders.
- Command suggestions now render inside the terminal's own bottom edge instead of as a separate overlay.

## [0.1.2] - 2026-10-01

### Added
- Tabs with a `+` button to open new, independent terminal sessions at Home.
- A compact path chip in the titlebar in place of a full path display.

### Changed
- The terminal now fills the entire window beneath a compact titlebar, rather than sitting in a smaller panel.
- Navigating the directory tree changes the shell's working directory in place, without reloading or restarting the terminal session.

## [0.1.1] - 2026-10-01

### Added
- Inline ghost-text suggestions when auto-complete is turned off, as a lighter-weight alternative to the suggestion popup.
- Automatic detection of installed editors and IDEs for the current folder.

### Changed
- The directory sidebar is now closed by default.
- Selecting a directory in the tree now follows a typed `cd` in the shell.

### Fixed
- Corrected the on-screen position of the suggestion popup.

## [0.1.0] - 2026-10-01

### Added
- Initial release: a standalone Electron terminal with Mullion's look, built on React, xterm.js and node-pty.
- Tabbed real shell sessions (zsh/bash on macOS and Linux, PowerShell on Windows).
- A directory tree sidebar, local command-history learning, and light/dark themes.
