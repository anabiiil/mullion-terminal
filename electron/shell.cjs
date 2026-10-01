'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { quoteToken } = require('./completions.cjs');
const NAVIGATION_SEQUENCE = '\x18\x07'; // Ctrl+X, Ctrl+G; private chord within app-owned editors.

function navigationRequest(requestId, target) {
  if (!/^[a-f0-9-]{36}$/.test(requestId) || typeof target !== 'string' || !target || target.includes('\0')) throw new Error('Invalid directory navigation request.');
  return Buffer.from(`${requestId}\0${target}\0`, 'utf8');
}

function unixNavigation(nonce, shell, navigationFile) {
  const file = quoteToken(navigationFile, 'linux');
  const restoreReadline = shell === 'bash' ? `
  # Bash 3.2 bind-x saves its temporary no-echo editor mode as the baseline.
  # Restore only echo that was enabled at the preceding ordinary prompt, so
  # a later Ctrl-C cannot silently disable Readline's character redisplay.
  if [[ $__mullion_legacy_readline == 1 && $__mullion_readline_echo == 1 ]]; then
    command stty echo 2>/dev/null
  fi` : '';
  const common = `
__mullion_apply_navigation() {
  local __mullion_request __mullion_target __mullion_ok=0
  [[ -f ${file} ]] || return
  { IFS= read -r -d '' __mullion_request; IFS= read -r -d '' __mullion_target; } < ${file}
  command rm -f -- ${file}
  if builtin cd -- "$__mullion_target" >/dev/null 2>&1; then __mullion_ok=1; fi
${restoreReadline}
  __mullion_ready${shell === 'bash' ? ' navigation' : ''}
  printf '\\033]777;Mullion;${nonce};navigate;%s;%s;%s\\007' "$__mullion_request" "$__mullion_ok" "$(printf '%s' "$PWD" | command base64 | command tr -d '\\r\\n')"
}
__mullion_navigation_available=0
`;
  if (shell === 'zsh') return `${common}
__mullion_navigate_widget() { __mullion_apply_navigation; zle reset-prompt; }
zle -N __mullion_navigate_widget
bindkey -M emacs '^X^G' __mullion_navigate_widget
bindkey -M viins '^X^G' __mullion_navigate_widget
bindkey -M vicmd '^X^G' __mullion_navigate_widget
__mullion_navigation_available=1
`;
  return `${common}
if [[ -o emacs || -o vi ]]; then
  bind -m emacs-standard -x '"\\C-x\\C-g":__mullion_apply_navigation' 2>/dev/null
  bind -m vi-insertion -x '"\\C-x\\C-g":__mullion_apply_navigation' 2>/dev/null
  bind -m vi-command -x '"\\C-x\\C-g":__mullion_apply_navigation' 2>/dev/null
  __mullion_navigation_available=1
fi
`;
}

function executable(file) {
  try { fsSync.accessSync(file, process.platform === 'win32' ? fsSync.constants.F_OK : fsSync.constants.X_OK); return fsSync.statSync(file).isFile(); } catch { return false; }
}

function findExecutable(name, environmentPath = process.env.PATH ?? '', platform = process.platform) {
  for (const directory of environmentPath.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    const file = path.join(directory, name);
    if (executable(file)) return file;
  }
  return null;
}

function defaultEnvironment(home = os.homedir()) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Mullion-Terminal';
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TERMINAL_DEV_URL;
  if (process.platform !== 'win32') {
    const common = [path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    env.PATH = [...new Set([...(env.PATH ?? '').split(':').filter(Boolean), ...common.filter(executableDirectory)])].join(':');
  }
  return env;
}

function executableDirectory(directory) {
  try { return fsSync.statSync(directory).isDirectory(); } catch { return false; }
}

function selectShell(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
    const powershell7 = path.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
    const powershell = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return findExecutable('pwsh.exe', env.PATH, platform) || (executable(powershell7) ? powershell7 : powershell);
  }
  let preferred;
  try { preferred = env.SHELL || os.userInfo().shell; } catch { preferred = env.SHELL; }
  if (preferred && ['zsh', 'bash'].includes(path.basename(preferred)) && executable(preferred)) return preferred;
  return (platform === 'darwin' && executable('/bin/zsh')) ? '/bin/zsh' : executable('/bin/bash') ? '/bin/bash' : findExecutable('bash', env.PATH, platform);
}

function unixHooks(nonce, shell, navigationFile) {
  const ready = `printf '\\033]777;Mullion;${nonce};ready;%s;%s;%s\\007' "$(printf '%s' "$PWD" | command base64 | command tr -d '\\r\\n')" "$(printf '%s' "$PATH" | command base64 | command tr -d '\\r\\n')" "$__mullion_navigation_available"`;
  const busy = `printf '\\033]777;Mullion;${nonce};busy\\007'`;
  const record = `printf '\\033]777;Mullion;${nonce};command;%s\\007' "$(printf '%s' "$__mullion_line" | command base64 | command tr -d '\\r\\n')"`;
  if (shell === 'zsh') return `
__mullion_ready() {
  local __mullion_status=$?
  PROMPT='%F{cyan}%1~%f %F{yellow}❯%f '
  RPROMPT=''
  ${ready}
  return $__mullion_status
}
__mullion_busy() { local __mullion_line="$1"; ${record}; ${busy}; }
autoload -Uz add-zsh-hook
add-zsh-hook -d precmd __mullion_ready 2>/dev/null
add-zsh-hook -d preexec __mullion_busy 2>/dev/null
add-zsh-hook precmd __mullion_ready
add-zsh-hook preexec __mullion_busy
${navigationFile ? unixNavigation(nonce, shell, navigationFile) : ''}
`;
  return `
__mullion_command() {
  local __mullion_line
  __mullion_line="$(HISTTIMEFORMAT= builtin history 1)"
  if [[ "$__mullion_line" =~ ^[[:space:]]*([0-9]+)[[:space:]]+(.*)$ ]]; then
    if [[ "\x24{BASH_REMATCH[1]}" == "$__mullion_histcmd" ]]; then return; fi
    __mullion_histcmd="\x24{BASH_REMATCH[1]}"
    __mullion_line="\x24{BASH_REMATCH[2]}"
    if [[ "$1" != silent ]]; then ${record}; fi
  fi
}
__mullion_first_prompt=1
__mullion_histcmd=$HISTCMD
__mullion_legacy_readline=0
__mullion_readline_echo=0
(( BASH_VERSINFO[0] == 3 )) && __mullion_legacy_readline=1
__mullion_ready() {
  local __mullion_status=$?
  if [[ $__mullion_legacy_readline == 1 && "$1" != navigation ]]; then
    local __mullion_terminal_flags
    if __mullion_terminal_flags="$(command stty -a 2>/dev/null)"; then
      case " $__mullion_terminal_flags " in
        *' -echo '*) __mullion_readline_echo=0 ;;
        *) __mullion_readline_echo=1 ;;
      esac
    fi
  fi
  if [[ $__mullion_first_prompt == 1 ]]; then
    __mullion_first_prompt=0
    __mullion_histcmd=$((HISTCMD - 1))
  elif [[ $__mullion_legacy_history == 1 ]]; then __mullion_command
  else __mullion_command silent
  fi
  PS1='\\[\\e[33m\\]❯\\[\\e[0m\\] '
  ${ready}
  return "$__mullion_status"
}
# Bash 4.4+ expands PS0 after reading a command and before running it.
# Older bash reports only newly added native history entries at the next prompt.
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  PS0="\x24{PS0-}"'$(__mullion_command)'
  __mullion_legacy_history=0
else
  __mullion_legacy_history=1
fi
# Append instead of replacing PROMPT_COMMAND; preserve user integrations.
if declare -p PROMPT_COMMAND 2>/dev/null | command grep -q 'declare -a'; then
  PROMPT_COMMAND+=(__mullion_ready)
else
  PROMPT_COMMAND="\x24{PROMPT_COMMAND:+\x24PROMPT_COMMAND; }__mullion_ready"
fi
${navigationFile ? unixNavigation(nonce, shell, navigationFile) : ''}
`;
}

async function prepareShell({ directory, nonce, home = os.homedir(), env = defaultEnvironment(home), shell = selectShell(env), platform = process.platform }) {
  if (!shell) throw new Error('No supported shell found. Install bash, zsh, or PowerShell.');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const navigationFile = path.join(directory, 'navigation.request');
  const basename = path.basename(shell).toLowerCase();
  if (basename === 'zsh') {
    const original = env.ZDOTDIR || home;
    const bridge = quoteToken(directory, 'darwin');
    const originalQuoted = quoteToken(original, 'darwin');
    const scripts = {
      '.zshenv': `# Generated by Mullion Terminal. User files are never modified.\n__mullion_user_zdotdir=${originalQuoted}\nZDOTDIR=$__mullion_user_zdotdir\n[[ -f "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"\n__mullion_user_zdotdir=\x24{ZDOTDIR:-$HOME}\nZDOTDIR=${bridge}\n`,
      '.zprofile': `ZDOTDIR=$__mullion_user_zdotdir\n[[ -f "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"\n__mullion_user_zdotdir=\x24{ZDOTDIR:-$HOME}\nZDOTDIR=${bridge}\n`,
      '.zshrc': `ZDOTDIR=$__mullion_user_zdotdir\n[[ -f "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"\n__mullion_user_zdotdir=\x24{ZDOTDIR:-$HOME}\nZDOTDIR=${bridge}\n${unixHooks(nonce, 'zsh', navigationFile)}`,
      '.zlogin': `ZDOTDIR=$__mullion_user_zdotdir\n[[ -f "$ZDOTDIR/.zlogin" ]] && source "$ZDOTDIR/.zlogin"\n${env.ZDOTDIR ? '' : '[[ "$ZDOTDIR" == "$HOME" ]] && unset ZDOTDIR\n'}${unixHooks(nonce, 'zsh', navigationFile)}`,
    };
    await Promise.all(Object.entries(scripts).map(([name, script]) => fs.writeFile(path.join(directory, name), script, { mode: 0o600 })));
    return { shell, args: ['-l', '-i'], env: { ...env, ZDOTDIR: directory }, navigationFile };
  }
  if (basename === 'bash') {
    const rc = path.join(directory, 'bashrc');
    const userRc = quoteToken(path.join(home, '.bashrc'));
    const loginFiles = ['.bash_profile', '.bash_login', '.profile'].map(file => quoteToken(path.join(home, file)));
    const startup = platform === 'darwin'
      ? `[[ -f /etc/profile ]] && source /etc/profile\nfor __mullion_profile in ${loginFiles.join(' ')}; do\n  if [[ -f "$__mullion_profile" ]]; then source "$__mullion_profile"; break; fi\ndone`
      : `[[ -f /etc/bash.bashrc ]] && source /etc/bash.bashrc\n[[ -f ${userRc} ]] && source ${userRc}`;
    const script = `# Generated by Mullion Terminal. Keep the user's native startup files.\n${startup}\n${unixHooks(nonce, 'bash', navigationFile)}`;
    await fs.writeFile(rc, script, { mode: 0o600 });
    return { shell, args: ['--rcfile', rc, '-i'], env, navigationFile };
  }
  if (['pwsh.exe', 'powershell.exe', 'pwsh', 'powershell'].includes(basename)) {
    const rc = path.join(directory, 'prompt.ps1');
    const script = `# Generated by Mullion Terminal. Profiles have already been loaded by PowerShell.
$global:__mullion_navigation_available = 0
function global:__mullion_navigate {
  $mullionRequest = ''
  $mullionOk = 0
  try {
    $mullionFields = [IO.File]::ReadAllText('${navigationFile.replaceAll("'", "''")}', [Text.Encoding]::UTF8).Split([char]0)
    $mullionRequest = $mullionFields[0]
    if ($mullionFields.Length -lt 3) { throw 'Invalid navigation request' }
    Remove-Item -LiteralPath '${navigationFile.replaceAll("'", "''")}' -Force -ErrorAction SilentlyContinue
    Microsoft.PowerShell.Management\\Set-Location -LiteralPath $mullionFields[1] -ErrorAction Stop
    $mullionOk = 1
  } catch { }
  $mullionLocation = (Get-Location).ProviderPath
  if (-not $mullionLocation) { $mullionLocation = (Get-Location).Path }
  $mullionLocation64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($mullionLocation))
  [Console]::Write("$([char]27)]777;Mullion;${nonce};navigate;$mullionRequest;$mullionOk;$mullionLocation64$([char]7)")
  [Microsoft.PowerShell.PSConsoleReadLine]::InvokePrompt()
}
# Keep replacement/navigation editing consistent with the app's PTY controls.
# These bindings affect this process only; no user profile is modified.
try {
  Import-Module PSReadLine -ErrorAction Stop
  Set-PSReadLineKeyHandler -Chord 'Ctrl+e' -Function EndOfLine -ErrorAction Stop
  Set-PSReadLineKeyHandler -Chord 'Ctrl+u' -Function BackwardDeleteInput -ErrorAction Stop
  if (-not ([Microsoft.PowerShell.PSConsoleReadLine].GetMethods().Name -contains 'InvokePrompt')) { throw 'Prompt refresh unavailable' }
  Set-PSReadLineKeyHandler -Chord 'Ctrl+x,Ctrl+g' -ScriptBlock { __mullion_navigate } -ErrorAction Stop
  $global:__mullion_navigation_available = 1
} catch {
  # PowerShell remains usable on installations without the optional module.
}
$global:__mullion_historyId = (Get-History -Count 1).Id
$global:__mullion_firstPrompt = $true
function global:prompt {
  $mullionHistory = Get-History -Count 1
  if ($global:__mullion_firstPrompt) {
    $global:__mullion_firstPrompt = $false
    $global:__mullion_historyId = $mullionHistory.Id
  } elseif ($mullionHistory -and $mullionHistory.Id -ne $global:__mullion_historyId) {
    $global:__mullion_historyId = $mullionHistory.Id
    $mullionCommand64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($mullionHistory.CommandLine))
    [Console]::Write("$([char]27)]777;Mullion;${nonce};command;$mullionCommand64$([char]7)")
  }
  $mullionCwd = (Get-Location).ProviderPath
  if (-not $mullionCwd) { $mullionCwd = (Get-Location).Path }
  $mullionCwd64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($mullionCwd))
  $mullionPath64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($env:PATH))
  [Console]::Write("$([char]27)]777;Mullion;${nonce};ready;$mullionCwd64;$mullionPath64;$global:__mullion_navigation_available$([char]7)")
  $mullionName = if ($mullionCwd -eq $HOME) { '~' } else { Split-Path -Path $mullionCwd -Leaf }
  if (-not $mullionName) { $mullionName = [IO.Path]::GetPathRoot($mullionCwd) }
  if (-not $mullionName) { $mullionName = $mullionCwd }
  "$mullionName ❯ "
}
`;
    await fs.writeFile(rc, script, { mode: 0o600 });
    // Inline commands work with Windows' normal script execution policy. Do not
    // change ExecutionPolicy or disable the user's PowerShell profiles.
    return { shell, args: ['-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], env, navigationFile };
  }
  throw new Error('Unsupported shell. Use zsh, bash, or PowerShell.');
}

module.exports = { defaultEnvironment, selectShell, prepareShell, unixHooks, findExecutable, NAVIGATION_SEQUENCE, navigationRequest };
