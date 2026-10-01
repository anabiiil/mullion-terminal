# Changelog

All notable changes to Mullion Terminal are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
