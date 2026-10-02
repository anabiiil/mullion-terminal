// Foreground editor detection and the key sequences the editor bar sends.

export type EditorKind = 'nano' | 'vim' | null;

// GNU nano, its restricted mode, and UW pico (macOS installs nano -> pico).
const NANO_NAMES = new Set(['nano', 'rnano', 'pico']);
// vi is vim on macOS/Linux; nvim and view (read-only vim) behave the same way
// for our purposes (Escape + a command-line command).
const VIM_NAMES = new Set(['vim', 'vi', 'nvim', 'view']);

/** node-pty reports a process name or path; Windows names may end in .exe. */
function baseName(name: string | null | undefined): string {
  if (!name) return '';
  return name.trim().split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
}

/** Which editor bar (if any) a node-pty foreground process name should show. */
export function editorKind(name: string | null | undefined): EditorKind {
  const base = baseName(name);
  if (NANO_NAMES.has(base)) return 'nano';
  if (VIM_NAMES.has(base)) return 'vim';
  return null;
}

/** @deprecated use `editorKind(name) === 'nano'` */
export function isNanoProcess(name: string | null | undefined): boolean {
  return editorKind(name) === 'nano';
}

// Ctrl+O writes out; both nano and pico then confirm the current file name
// with Enter. Ctrl+X exits (and prompts first if the buffer is still modified).
export const NANO_KEYS = {
  save: '\x0f\r',
  saveAndExit: '\x0f\r\x18',
  exit: '\x18',
} as const;

// Vim commands run from Normal mode, so every sequence below is sent as a
// trailing Escape (handled separately, see ESC_DELAY_MS) followed by a
// command-line command and Enter. `:qa!` discards changes in every buffer,
// which matches what a user types by hand to get out of a git commit/rebase
// editor; `:wq` accepts the message/todo list and exits.
export const VIM_KEYS = {
  save: ':w\r',
  saveAndExit: ':wq\r',
  exit: ':qa!\r',
} as const;

// Git runs the user's editor (vim by default) as a plain child process
// rather than its own process group leader, so node-pty's foreground-process
// lookup (which reads the terminal's foreground process group) keeps
// reporting "git" for as long as the editor is open — editorKind(name)
// alone can never see "vim" in that case. As a fallback, once the terminal
// has switched to the alternate screen (something full-screen is drawing)
// and the process name didn't already resolve to a known editor, recognise
// git's own commit/rebase/merge message templates by their first lines:
// they always carry one of a handful of standard English comment banners,
// or — for an interactive rebase todo list — "pick <sha> ..." lines.
const GIT_EDITOR_MARKERS: readonly RegExp[] = [
  /please enter the commit message/i,
  /please enter a commit message/i,
  /^#.*rebase.*onto\b/i,
  /^#\s*conflicts:/i,
  /this is a combination of \d+ commits/i,
  /^(pick|reword|edit|squash|fixup|drop|p|r|e|s|f|d)\s+[0-9a-f]{7,40}\s+\S/,
];

/** True when the visible terminal lines look like a commit/rebase/merge message git handed an editor. */
export function looksLikeGitEditorBuffer(lines: readonly string[]): boolean {
  return lines.some(line => GIT_EDITOR_MARKERS.some(pattern => pattern.test(line.trim())));
}

// Sending "\x1b:wq\r" in one write usually works, but vim's key-code timeout
// (ttimeoutlen, default ~50ms, only relevant while still in Insert mode) can
// momentarily treat Escape as the start of a Meta/Alt chord rather than a
// plain mode switch. Writing Escape on its own, waiting this long, then
// writing the command avoids that ambiguity entirely.
export const ESC_DELAY_MS = 50;
