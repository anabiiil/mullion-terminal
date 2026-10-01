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

/** Most-used commands only: the starter command hints never enter this list. */
export function frequentCommands(history: HistoryEntry[], limit = 8): HistoryEntry[] {
  return aggregateHistory(history)
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
    // Backends may quote/escape a filename when constructing a full replacement.
    const completedPath = completed.value.replace(platform === 'win32' ? /^\.\\(?=-)/ : /^\.\/(?=-)/, '');
    return compare(line.slice(0, typed.start)) === compare(candidate.value.slice(0, completed.start))
      && (compare(completed.value).startsWith(compare(typed.value)) || compare(completedPath).startsWith(compare(typed.value)));
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
  // Quoted ~/ paths may be expanded to home in the actual replacement. The label
  // still supplies the filename suffix without displaying the absolute home path.
  const basename = typed.value.split(platform === 'win32' ? /[\\/]/ : /\//).at(-1) ?? '';
  return comparable(candidate.label, platform).startsWith(comparable(basename, platform))
    ? candidate.label.slice(basename.length) : '';
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

  const now = Date.now();
  for (const entry of aggregateHistory(history, cwd, platform)) {
    const ageInDays = Math.max(0, now - entry.lastUsed) / 86_400_000;
    const recency = 30 / (1 + ageInDays / 7);
    const score = 1_000 + (entry.pinned ? 10_000 : 0)
      + Math.log2(1 + entry.count) * 35 + recency + (entry.local ? 70 : 0);
    add({
      value: entry.command,
      label: entry.command,
      kind: 'history',
      detail: `${entry.pinned ? 'Pinned · ' : ''}Used ${entry.count} ${entry.count === 1 ? 'time' : 'times'}${entry.local ? ' · This directory' : ''}`,
    }, score);
  }

  for (const candidate of candidates) {
    const filesystem = candidate.kind === 'directory' || candidate.kind === 'file';
    add(candidate, candidate.kind === 'command' ? 120 : (prioritizeFilesystem && filesystem ? 100 : 0)
      + (candidate.kind === 'directory' ? 110 : 100));
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
