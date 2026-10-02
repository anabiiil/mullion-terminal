'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function quoteToken(value, platform = process.platform) {
  const unsafe = platform === 'win32' ? /[^A-Za-z0-9_./:\\-]/ : /[^A-Za-z0-9_./:-]/;
  if (!value || unsafe.test(value)) {
    return platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
  }
  return value;
}

function directoryCommand(directory, platform = process.platform) {
  if (typeof directory !== 'string' || !directory || /[\0\r\n\x1b\x07]/.test(directory)) throw new Error('This directory cannot be inserted into the shell.');
  // Quoting is mandatory here, including paths that start with a dash.
  const quoted = platform === 'win32' ? `'${directory.replaceAll("'", "''")}'` : `'${directory.replaceAll("'", "'\\''")}'`;
  return platform === 'win32' ? `Set-Location -LiteralPath ${quoted}` : `builtin cd -- ${quoted}`;
}

// Mirrors the shapes directoryCommand() can produce, plus any other internal command the
// app types into the shell (anything using the `builtin` prefix or naming the `__mullion`
// hooks). The user never typed these, so they must never be learned as command history.
const INJECTED_COMMAND_PATTERN = /^builtin\b|^set-location\s+-literalpath\b|__mullion/i;

function isInjectedCommand(command) {
  return typeof command === 'string' && INJECTED_COMMAND_PATTERN.test(command.trim());
}

function tokenize(line, platform = process.platform) {
  const tokens = [];
  let start = -1;
  let decoded = '';
  let quote = null;
  let escape = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (start < 0 && /\s/.test(character)) continue;
    if (start < 0) start = index;
    if (escape) { decoded += character; escape = false; continue; }
    if ((platform !== 'win32' && character === '\\' && quote !== "'") || (platform === 'win32' && character === '`' && quote !== "'")) { escape = true; continue; }
    if (quote) {
      if (character === quote) {
        if (platform === 'win32' && quote === "'" && line[index + 1] === "'") { decoded += "'"; index++; }
        else quote = null;
      } else decoded += character;
    } else if (character === "'" || character === '"') quote = character;
    else if (/\s/.test(character)) { tokens.push({ start, end: index, decoded }); start = -1; decoded = ''; }
    else decoded += character;
  }
  if (escape) decoded += platform === 'win32' ? '`' : '\\';
  if (start >= 0) tokens.push({ start, end: line.length, decoded });
  else tokens.push({ start: line.length, end: line.length, decoded: '' });
  return tokens;
}

const UNIX_BUILTINS = ['alias', 'cd', 'command', 'echo', 'exit', 'export', 'history', 'popd', 'printf', 'pushd', 'pwd', 'source', 'type', 'unalias', 'unset'];
const WINDOWS_BUILTINS = ['cd', 'cls', 'dir', 'echo', 'exit', 'Get-ChildItem', 'Get-Content', 'Get-Location', 'Set-Location', 'Write-Output'];

async function commands(prefix, environmentPath, platform, cwd) {
  const names = new Set((platform === 'win32' ? WINDOWS_BUILTINS : UNIX_BUILTINS).filter(name => matches(name, prefix, platform)));
  const directories = [...new Set(environmentPath.split(platform === 'win32' ? ';' : ':').filter(Boolean))].slice(0, 100);
  await Promise.all(directories.map(async directory => {
    // Empty and relative PATH entries refer to the session cwd, not Electron's cwd.
    directory = path.resolve(cwd, directory);
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const matching = entries.filter(entry => !entry.isDirectory() && matches(entry.name, prefix, platform));
      await Promise.all(matching.map(async entry => {
        if (platform === 'win32') {
          const extension = path.extname(entry.name).toLowerCase();
          if (['.exe', '.cmd', '.bat', '.com', '.ps1'].includes(extension)) names.add(entry.name.slice(0, -extension.length));
        } else {
          try { await fs.access(path.join(directory, entry.name), require('node:fs').constants.X_OK); names.add(entry.name); } catch {}
        }
      }));
    } catch {}
  }));
  return [...names].sort((a, b) => a.localeCompare(b)).slice(0, 40).map(name => ({ value: quoteToken(name, platform), label: name, kind: 'command', detail: 'Command' }));
}

function matches(value, prefix, platform) {
  return platform === 'win32' ? value.toLowerCase().startsWith(prefix.toLowerCase()) : value.startsWith(prefix);
}

function filesystemPolicy(command, tokens, platform) {
  const windows = platform === 'win32';
  const name = windows ? command.toLowerCase() : command;
  const directories = ['cd', 'pushd', 'rmdir', ...(windows ? ['set-location', 'sl', 'remove-directory'] : [])];
  const files = ['cat', 'head', 'tail', 'source', 'less', 'more', ...(windows ? ['get-content', 'gc', 'type'] : [])];
  const both = ['ls', 'cp', 'mv', 'stat', 'file', ...(windows ? ['dir', 'get-childitem', 'gci', 'copy-item', 'move-item', 'copy', 'move', 'remove-item', 'ri'] : [])];
  const previous = tokens.slice(1, -1).map(token => token.decoded);
  const argument = previous.at(-1);
  if (['head', 'tail'].includes(name) && ['-n', '-c', '--lines', '--bytes'].includes(argument)) return null;
  if (directories.includes(name)) return { directories: true, files: false, bare: true, noSymlinks: name === 'rmdir' };
  if (files.includes(name)) return { directories: false, files: true, bare: true };
  if (both.includes(name)) {
    if (windows && ['ls', 'dir', 'get-childitem', 'gci'].includes(name)) {
      if (previous.some(value => value.toLowerCase() === '-directory')) return { directories: true, files: false, bare: true };
      if (previous.some(value => value.toLowerCase() === '-file')) return { directories: false, files: true, bare: true };
    }
    if (name === 'cp' && ['-t', '--target-directory'].includes(argument)) return { directories: true, files: false, bare: true };
    return { directories: true, files: true, bare: true };
  }
  if (name === 'rm') {
    const flags = [];
    for (const value of previous) { if (value === '--') break; if (value.startsWith('-')) flags.push(value); }
    const recursive = flags.some(value => /^-[^-]*[rRd]/.test(value) || ['--recursive', '--dir'].includes(value));
    return { directories: windows || recursive, files: true, bare: true, unlink: true };
  }
  // mkdir creates a new name. Existing directories help only after a parent path
  // has been supplied, rather than suggesting an already-existing current name.
  if (name === 'mkdir') return { directories: true, files: false, bare: false, parentRequired: true };
  return null;
}

function unsafeShellContext(line, platform) {
  let quote = null;
  let escape = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (escape) { escape = false; continue; }
    if (char === (platform === 'win32' ? '`' : '\\') && quote !== "'") { escape = true; continue; }
    if (quote === "'") {
      if (char === "'") {
        if (platform === 'win32' && line[index + 1] === "'") index++;
        else quote = null;
      }
      continue;
    }
    if (char === '$' || (platform !== 'win32' && char === '`')) return true;
    if (quote === '"') { if (char === '"') quote = null; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (/[;|&<>()]/.test(char)) return true;
  }
  return false;
}

async function complete({ line, cwd, platform = process.platform, environmentPath = process.env.PATH ?? '', home = os.homedir(), showHidden = false }) {
  if (typeof line !== 'string' || line.length > 8192 || /[\x00-\x1f\x7f-\x9f]/.test(line)) return [];
  const tokens = tokenize(line, platform);
  let token = tokens[tokens.length - 1];
  const first = tokens.length === 1;
  let raw = token.decoded;
  const isPath = /[\\/]/.test(raw) || raw.startsWith('.') || raw.startsWith('~');
  const policy = filesystemPolicy(tokens[0]?.decoded || '', tokens, platform);
  const bareCommand = first && !isPath && policy?.bare;
  // An exact filesystem command already has an unambiguous operand context.
  // Skip a redundant PATH scan before listing the current directory.
  const commandResults = first && !isPath && raw && !bareCommand ? await commands(raw, environmentPath, platform, cwd) : [];
  if (first && !isPath && !bareCommand) return commandResults;
  if (unsafeShellContext(line, platform)) return commandResults;
  let replacementPrefix = line.slice(0, token.start);
  if (bareCommand) {
    token = { start: line.length, end: line.length, decoded: '' };
    raw = '';
    replacementPrefix = `${line} `;
  }
  if (!raw && !policy) return commandResults;
  if (policy?.parentRequired && !/[\\/]/.test(raw)) return commandResults;
  // A filename starting with '-' is an operand only after '--' or an explicit
  // './' prefix. Do not mistake an option currently being typed for a filename.
  if (raw.startsWith('-') && !tokens.slice(1, -1).some(value => value.decoded === '--')) return commandResults;
  // Never expand shell substitutions, variables, operators, or wildcard expressions.
  if (/[\0\r\n$*?\[\]<>|;&]/.test(raw)) return commandResults;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const separator = platform === 'win32' ? '\\' : '/';
  const lastSeparator = Math.max(raw.lastIndexOf('/'), platform === 'win32' ? raw.lastIndexOf('\\') : -1);
  const visibleDirectory = lastSeparator >= 0 ? raw.slice(0, lastSeparator + 1) : '';
  const prefix = raw.slice(lastSeparator + 1);
  let directory = visibleDirectory || '.';
  if (directory === '~/' || directory === '~\\') directory = home;
  else if (directory.startsWith('~/') || directory.startsWith('~\\')) directory = pathApi.join(home, directory.slice(2));
  else directory = pathApi.resolve(cwd, directory);
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return commandResults; }
  const results = await Promise.all(entries.filter(entry => !/[\x00-\x1f\x7f-\x9f]/.test(entry.name) && matches(entry.name, prefix, platform) && (showHidden || prefix.startsWith('.') || !entry.name.startsWith('.'))).slice(0, 500).map(async entry => {
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { isDirectory = (await fs.stat(pathApi.join(directory, entry.name))).isDirectory(); } catch {}
      if (policy?.noSymlinks) return null;
      if (policy?.unlink) isDirectory = false;
    }
    if (policy && (isDirectory ? !policy.directories : !policy.files)) return null;
    const value = `${visibleDirectory || (entry.name.startsWith('-') ? `.${separator}` : '')}${entry.name}${isDirectory ? separator : ''}`;
    // A quoted tilde no longer expands in POSIX shells, so replace it with home.
    const insert = /^~[\\/]/.test(value) ? pathApi.join(home, value.slice(2).replace(/[\\/]+$/, '')) + (isDirectory ? separator : '') : value;
    return { value: `${replacementPrefix}${quoteToken(insert, platform)}`, label: `${entry.name}${isDirectory ? separator : ''}`, kind: isDirectory ? 'directory' : 'file', detail: isDirectory ? 'Folder' : 'File' };
  }));
  return results.filter(Boolean).sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.label.localeCompare(b.label)).slice(0, 40);
}

module.exports = { quoteToken, directoryCommand, tokenize, complete, isInjectedCommand };
