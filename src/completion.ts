import type { CompletionCandidate, HistoryEntry, Suggestion } from './types';

/** Starter hints are suggestions, never fabricated usage history. */
const COMMON_COMMANDS: CompletionCandidate[] = [
  { value: 'cd', label: 'cd', kind: 'command', detail: 'Change directory' },
  { value: 'ls', label: 'ls', kind: 'command', detail: 'List directory contents' },
  { value: 'pwd', label: 'pwd', kind: 'command', detail: 'Show the current directory' },
  { value: 'clear', label: 'clear', kind: 'command', detail: 'Clear the terminal screen' },
  { value: 'cat', label: 'cat', kind: 'command', detail: 'Print file contents' },
  { value: 'mkdir', label: 'mkdir', kind: 'command', detail: 'Create a directory' },
  { value: 'git', label: 'git', kind: 'command', detail: 'Git version control' },
  { value: 'npm', label: 'npm', kind: 'command', detail: 'Node package manager' },
  { value: 'node', label: 'node', kind: 'command', detail: 'Run JavaScript' },
  { value: 'python', label: 'python', kind: 'command', detail: 'Run Python' },
  { value: 'ssh', label: 'ssh', kind: 'command', detail: 'Connect to a remote shell' },
  { value: 'curl', label: 'curl', kind: 'command', detail: 'Transfer data from a URL' },
];

interface LearnedCommand extends HistoryEntry { local: boolean }

// Mirrors electron/completions.cjs's detector: anything the app types into the shell on
// the user's behalf (sidebar folder navigation, internal hooks), never something the
// user actually typed.
const INJECTED_COMMAND_PATTERN = /^builtin\b|^set-location\s+-literalpath\b|__mullion/i;

/** True for an app-injected command that must never be treated as learned user history. */
export function isInjectedCommand(command: string): boolean {
  return INJECTED_COMMAND_PATTERN.test(command.trim());
}

// Whole-command matches: the entire trimmed input, not just its first word.
const BASIC_EXACT = new Set(['..', '~']);

// Any command whose first word is one of these is routine/system shell use,
// never "your commands" — regardless of arguments. Covers navigation, listing,
// file management, basic editors, and their PowerShell equivalents.
const BASIC_COMMANDS = new Set([
  'cd', 'pushd', 'popd', 'ls', 'll', 'la', 'l', 'dir', 'pwd', 'clear', 'cls', 'reset', 'exit', 'logout',
  'history', 'rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'cat', 'less', 'more', 'head', 'tail', 'open',
  'xdg-open', 'start', 'explorer', 'nano', 'rnano', 'pico', 'vi', 'vim', 'nvim', 'view', 'emacs', 'echo',
  'printf', 'arch', 'uname', 'whoami', 'hostname', 'date', 'cal', 'which', 'where', 'type', 'man', 'help',
  'chmod', 'chown', 'ln', 'file', 'stat', 'du', 'df', 'tree', 'sleep', 'true', 'false', 'yes',
  // PowerShell equivalents.
  'set-location', 'sl', 'chdir', 'get-location', 'gl', 'get-childitem', 'gci', 'remove-item', 'ri', 'del',
  'erase', 'move-item', 'mi', 'move', 'copy-item', 'ci', 'copy', 'new-item', 'ni', 'md', 'get-content', 'gc',
  'clear-host', 'write-output', 'write-host',
]);

/** Directory-changing commands, used to keep learned suggestions from ever offering a `cd …`. */
const NAVIGATION_COMMANDS = new Set(['cd', 'pushd', 'popd', 'set-location', 'sl', 'chdir']);

/** True when `command`'s first word changes the shell's directory (cd, pushd/popd, and
 * their PowerShell equivalents). A learned command like this is never a useful suggestion:
 * directory completion after a freshly typed `cd ` is handled separately, from the live
 * filesystem rather than history. */
function isNavigationCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  return NAVIGATION_COMMANDS.has(meaningfulTokens(trimmed)[0]?.toLowerCase() ?? '');
}

const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const COMMAND_PREFIX_WORDS = new Set(['sudo', 'command', 'builtin']);
// A single token made only of non-ASCII characters (e.g. a mistyped word the
// shell reported as "command not found") is noise, never a command worth surfacing.
const NON_ASCII_ONLY = /^[^\x00-\x7f]+$/;

/** The command's real first word, after stripping leading env assignments (`FOO=1`) and
 * `sudo`/`command`/`builtin` wrappers that don't change what's actually being run. */
function meaningfulTokens(trimmed: string): string[] {
  const tokens = trimmed.split(/\s+/);
  while (tokens.length > 1 && (ENVIRONMENT_ASSIGNMENT.test(tokens[0]) || COMMAND_PREFIX_WORDS.has(tokens[0].toLowerCase()))) tokens.shift();
  return tokens;
}

/**
 * Commands too routine, or too garbled, to be worth surfacing as "your commands": plain
 * navigation, file management, basic editors, and system info, in any shell dialect this
 * app supports, plus single-token non-ASCII noise. These are still kept in history for
 * suggestion ranking (so typing `rm ` still offers a learned path), but are hidden from the
 * history sidebar, the quick-commands bar, and "most used" ranking. App-injected commands
 * are always basic.
 */
export function isBasicCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || isInjectedCommand(trimmed)) return true;
  if (BASIC_EXACT.has(trimmed.toLowerCase())) return true;
  const tokens = meaningfulTokens(trimmed);
  const first = tokens[0].toLowerCase();
  if (BASIC_COMMANDS.has(first)) return true;
  if (tokens.length === 1 && NON_ASCII_ONLY.test(tokens[0])) return true;
  // A bare `sudo` or `exec` (no command after it) does nothing worth learning; `sudo <cmd>`
  // and `exec <cmd>` are unaffected, since meaningfulTokens already strips a leading `sudo`
  // wrapper when there's a real command after it.
  if (tokens.length === 1 && (first === 'sudo' || first === 'exec')) return true;
  return false;
}

/** @deprecated Use {@link isBasicCommand}. Kept as an alias for existing call sites. */
export const isTrivialCommand = isBasicCommand;

const WINDOWS_COMMANDS: CompletionCandidate[] = [
  { value: 'Get-ChildItem', label: 'Get-ChildItem', kind: 'command', detail: 'List directory contents' },
  { value: 'Get-Location', label: 'Get-Location', kind: 'command', detail: 'Show the current directory' },
  { value: 'Set-Location', label: 'Set-Location', kind: 'command', detail: 'Change directory' },
  { value: 'Get-Content', label: 'Get-Content', kind: 'command', detail: 'Print file contents' },
  { value: 'Clear-Host', label: 'Clear-Host', kind: 'command', detail: 'Clear the terminal screen' },
  { value: 'New-Item', label: 'New-Item', kind: 'command', detail: 'Create a file or directory' },
  { value: 'Select-String', label: 'Select-String', kind: 'command', detail: 'Find text in files' },
];

function comparable(value: string, platform: string): string {
  return platform === 'win32' ? value.toLowerCase() : value;
}

/** Case folding for filesystem *path* comparisons specifically: the filesystem itself is
 * case-insensitive by default on both Windows and macOS, unlike ordinary shell text matching
 * (`comparable()` above, used for command/argument text generally), which only folds case on
 * Windows. Used only when matching a previously visited directory's full-path label. */
function pathComparable(value: string, platform: string): string {
  return platform === 'win32' || platform === 'darwin' ? value.toLowerCase() : value;
}

function sameDirectory(a: string, b: string | undefined, platform: string): boolean {
  if (b === undefined) return false;
  const normalize = (value: string) => platform === 'win32'
    ? value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : value;
  return normalize(a) === normalize(b);
}

function safeCount(value: number): number {
  return Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0;
}

function safeTime(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function aggregateHistory(history: HistoryEntry[], cwd?: string, platform = 'unix'): LearnedCommand[] {
  const commands = new Map<string, LearnedCommand>();
  for (const entry of history) {
    // A suggestion is always one input line, even if an imported history is malformed.
    if (!entry.command.trim() || /[\x00-\x1f\x7f-\x9f]/.test(entry.command)) continue;
    const old = commands.get(entry.command);
    const count = safeCount(entry.count);
    const lastUsed = safeTime(entry.lastUsed);
    if (!old) {
      commands.set(entry.command, {
        ...entry, count, lastUsed, pinned: Boolean(entry.pinned), local: sameDirectory(entry.cwd, cwd, platform),
      });
    } else {
      old.count = Math.min(Number.MAX_SAFE_INTEGER, old.count + count);
      old.pinned ||= Boolean(entry.pinned);
      old.local ||= sameDirectory(entry.cwd, cwd, platform);
      if (lastUsed > old.lastUsed) {
        old.lastUsed = lastUsed;
        old.cwd = entry.cwd;
      }
    }
  }
  return [...commands.values()];
}

/** Most-used commands only: the starter command hints and basic/system commands
 * (cd, ls, pwd, clear, …) never enter this list, even though they remain in history for
 * suggestion ranking. */
export function frequentCommands(history: HistoryEntry[], limit = 8): HistoryEntry[] {
  return aggregateHistory(history)
    .filter(entry => !isBasicCommand(entry.command))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned)
      || b.count - a.count || b.lastUsed - a.lastUsed || a.command.localeCompare(b.command))
    .slice(0, Math.max(0, Math.floor(limit)))
    .map(({ local: _local, ...entry }) => entry);
}

/** Locate and decode the token being typed without evaluating shell syntax. */
function finalToken(line: string, platform = 'unix'): { start: number; value: string } {
  let start = 0;
  let value = '';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (escaped) { value += char; escaped = false; continue; }
    if (char === (platform === 'win32' ? '`' : '\\') && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote && platform === 'win32' && line[index + 1] === quote) {
        value += quote;
        index++;
      } else if (char === quote) quote = '';
      else value += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      start = index + 1;
      value = '';
    } else {
      value += char;
    }
  }
  // A trailing backslash is an incomplete escape, not a literal path character.
  return { start, value };
}

const FILESYSTEM_COMMANDS = new Set(['cd', 'pushd', 'rmdir', 'rm', 'cat', 'head', 'tail', 'source', 'less', 'more', 'ls', 'cp', 'mv', 'stat', 'file']);
const WINDOWS_FILESYSTEM_COMMANDS = new Set(['set-location', 'sl', 'remove-directory', 'get-content', 'gc', 'type', 'dir', 'get-childitem', 'gci', 'copy-item', 'move-item', 'copy', 'move', 'remove-item', 'ri']);

function filesystemCommand(line: string, platform: string): { recognized: boolean; bare: boolean } {
  const first = line.trimStart().split(/\s+/)[0];
  const name = platform === 'win32' ? first.toLowerCase() : first;
  const recognized = FILESYSTEM_COMMANDS.has(name) || (platform === 'win32' && WINDOWS_FILESYSTEM_COMMANDS.has(name));
  return { recognized, bare: recognized && line.trim() === first && !/\s$/.test(line) };
}

const PATH_SEPARATOR = /[\\/]/;

/** True for a directory/file candidate's label that is itself a full (possibly `~`-abbreviated)
 * path — a previously visited directory offered from history — rather than a single filesystem
 * entry's bare name. The live filesystem backend never produces one of these: its labels are
 * always just `entry.name` (plus a trailing separator for a folder). */
function isFullPathLabel(label: string): boolean {
  const stripped = label.replace(/[\\/]+$/, '');
  return PATH_SEPARATOR.test(stripped) || stripped.startsWith('~');
}

/**
 * Matches (and measures) a full-path label against the token actually typed, for the one case
 * the ordinary value-prefix comparison can't handle: a visited directory's on-disk `value` has
 * been expanded to an absolute path, so it no longer shares a literal prefix with a typed `~/…`
 * token, and a bare directory name (no slash at all) is matched against the *current* directory's
 * children by value, never a deep ancestor's basename. Returns the unmatched remainder of the
 * label (for the inline ghost), or null when this candidate doesn't match this way.
 */
function matchFullPathLabel(typedValue: string, label: string, platform: string): string | null {
  if (!isFullPathLabel(label)) return null;
  const compare = (value: string) => pathComparable(value, platform);
  if (typedValue.startsWith('~')) {
    return compare(label).startsWith(compare(typedValue)) ? label.slice(typedValue.length) : null;
  }
  if (!typedValue || PATH_SEPARATOR.test(typedValue)) return null;
  const stripped = label.replace(/[\\/]+$/, '');
  const basename = stripped.split(PATH_SEPARATOR).at(-1) ?? '';
  if (!compare(basename).startsWith(compare(typedValue))) return null;
  return label.slice(label.lastIndexOf(basename) + typedValue.length);
}

/** Last-resort match/measure for a directory/file candidate once the ordinary value-prefix
 * comparison fails to see past a server-side rewrite of what was typed (most commonly: a typed
 * `~/…` path expanded to an absolute value). Tries the full-path label first (a previously
 * visited directory), then falls back to comparing basenames — the typed token's last segment
 * against the candidate's (bare-name) label — which is what a single filesystem entry's label
 * always is. Returns the unmatched label remainder, or null if neither matches. */
function matchByLabel(typedValue: string, label: string, platform: string): string | null {
  const fullPath = matchFullPathLabel(typedValue, label, platform);
  if (fullPath !== null) return fullPath;
  const basename = typedValue.split(platform === 'win32' ? /[\\/]/ : /\//).at(-1) ?? '';
  return comparable(label, platform).startsWith(comparable(basename, platform)) ? label.slice(basename.length) : null;
}

function candidateMatches(line: string, candidate: CompletionCandidate, platform: string, autoComplete: boolean): boolean {
  const compare = (value: string) => comparable(value, platform);
  if (compare(candidate.value.trimEnd()) === compare(line.trimEnd())) return false;
  if (candidate.kind === 'directory' || candidate.kind === 'file') {
    const typed = finalToken(line, platform);
    const context = filesystemCommand(line, platform);
    if (context.bare) {
      // Bare `cd` can offer an optional OFF-mode path, including the missing
      // separating space. ON-mode Enter must keep the shell's ordinary behavior.
      return !autoComplete && compare(candidate.value).startsWith(compare(line) + ' ');
    }
    if (!typed.value && (autoComplete || !context.recognized)) return false;
    if (compare(candidate.value).startsWith(compare(line))) return true;
    const completed = finalToken(candidate.value.trimEnd(), platform);
    if (compare(line.slice(0, typed.start)) !== compare(candidate.value.slice(0, completed.start))) return false;
    // Backends may quote/escape a filename when constructing a full replacement.
    const completedPath = completed.value.replace(platform === 'win32' ? /^\.\\(?=-)/ : /^\.\/(?=-)/, '');
    if (compare(completed.value).startsWith(compare(typed.value)) || compare(completedPath).startsWith(compare(typed.value))) return true;
    return matchByLabel(typed.value, candidate.label, platform) !== null;
  }
  return compare(candidate.value).startsWith(compare(line));
}

/** Display-only suffix. Tab still inserts the backend's complete, safely quoted value. */
export function inlineCompletion(line: string, candidate: CompletionCandidate, platform = 'unix'): string {
  if (comparable(candidate.value, platform).startsWith(comparable(line, platform))) return candidate.value.slice(line.length);
  if (candidate.kind !== 'directory' && candidate.kind !== 'file') return '';
  const typed = finalToken(line, platform);
  const completed = finalToken(candidate.value.trimEnd(), platform);
  if (comparable(completed.value, platform).startsWith(comparable(typed.value, platform)))
    return completed.value.slice(typed.value.length);
  // Quoted ~/ paths may be expanded to home in the actual replacement, and a previously visited
  // directory's full-path label diverges from a typed `~/…` or bare name the same way: match by
  // label instead of value, so the ghost still supplies the missing suffix in either case.
  return matchByLabel(typed.value, candidate.label, platform) ?? '';
}

/**
 * Every `value` is a complete replacement for `line`, never an executable suffix.
 * Matching is prefix-only, case-insensitive on Windows. History wins over PATH/file hints;
 * pinned, frequently used, recent, and current-directory commands rank first.
 */
export function rankSuggestions(
  line: string,
  history: HistoryEntry[],
  candidates: CompletionCandidate[],
  cwd: string,
  limit = 8,
  platform = 'unix',
  autoComplete = true,
): Suggestion[] {
  if (!line.trim() || /[\x00-\x1f\x7f-\x9f]/.test(line) || limit <= 0) return [];
  const ranked = new Map<string, Suggestion>();
  const prioritizeFilesystem = !autoComplete && filesystemCommand(line, platform).bare;
  const add = (candidate: CompletionCandidate, score: number) => {
    if (!candidate.value.trim() || /[\x00-\x1f\x7f-\x9f]/.test(candidate.value)
      || !candidateMatches(line, candidate, platform, autoComplete)) return;
    const key = comparable(candidate.value.trimEnd(), platform);
    const previous = ranked.get(key);
    if (!previous || previous.score < score) ranked.set(key, { ...candidate, score });
  };

  const typedToken = finalToken(line, platform).value;
  const typedIsAbsoluteOrHome = typedToken.startsWith('/') || typedToken.startsWith('~')
    || (platform === 'win32' && /^[A-Za-z]:[\\/]/.test(typedToken));

  const now = Date.now();
  for (const entry of aggregateHistory(history, cwd, platform)) {
    // Never offer a learned `cd …`/`pushd …` as a suggestion, and app-injected
    // commands should already be absent from history, but never trust that blindly.
    if (isInjectedCommand(entry.command) || isNavigationCommand(entry.command)) continue;
    const ageInDays = Math.max(0, now - entry.lastUsed) / 86_400_000;
    const recency = 30 / (1 + ageInDays / 7);
    const score = 1_000 + (entry.pinned ? 10_000 : 0)
      + Math.log2(1 + entry.count) * 35 + recency + (entry.local ? 70 : 0);
    add({
      value: entry.command,
      label: entry.command,
      kind: 'history',
      detail: `${entry.pinned ? 'Pinned · ' : ''}Used ${entry.count}×${entry.local ? ' here' : ''}`,
    }, score);
  }

  for (const candidate of candidates) {
    const filesystem = candidate.kind === 'directory' || candidate.kind === 'file';
    let score = candidate.kind === 'command' ? 120 : (prioritizeFilesystem && filesystem ? 100 : 0)
      + (candidate.kind === 'directory' ? 110 : 100);
    // A previously visited directory's full-path label extends what was typed by more than a
    // single next segment; rank it above the live filesystem's plain next-segment listings —
    // but only when the typed token is itself an absolute/`~` path, so the full path genuinely
    // extends what was typed. For a bare name or a relative path, the full path is a different,
    // unrelated replacement of the typed token: it must rank below every relative candidate
    // (the live filesystem backend already drops it outright when it's reachable from cwd, but
    // this keeps ranking itself safe even if a full-path candidate reaches here some other way).
    if (candidate.kind === 'directory' && isFullPathLabel(candidate.label)) score += typedIsAbsoluteOrHome ? 15 : -15;
    add(candidate, score);
  }
  // Starter hints only complete the first word, never a command's arguments.
  if (finalToken(line, platform).start === 0) {
    for (const candidate of COMMON_COMMANDS) add(candidate, 50);
    if (platform === 'win32') for (const candidate of WINDOWS_COMMANDS) add(candidate, 50);
  }

  return [...ranked.values()]
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, Math.max(0, Math.floor(limit)));
}
