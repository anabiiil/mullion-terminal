'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { quoteToken } = require('./completions.cjs');
const NAVIGATION_SEQUENCE = '\x18\x07'; // Ctrl+X, Ctrl+G; private chord within app-owned editors.
// Ctrl+E, Ctrl+U: move to the end of the input line, then delete all of it.
const LINE_RESET_SEQUENCE = '\x05\x15';
// PowerShell uses Ctrl+Alt+Shift+F12 / F11 instead. ConPTY turns a Ctrl+letter
// into a key event with its own keyboard layout while PSReadLine decodes it
// with the PowerShell thread's layout; once someone switches input language
// (e.g. Arabic and English) the two disagree and Ctrl+X, Ctrl+G arrives as
// "ءل". Function keys carry no character, so they match under any layout, and
// Ctrl+X stays PSReadLine's Cut instead of becoming a chord prefix.
const POWERSHELL_NAVIGATION_SEQUENCE = '\x1b[24;8~';
const POWERSHELL_LINE_RESET_SEQUENCE = '\x1b[23;8~';

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

// Variables that describe this app process rather than the user's session:
// Electron's own switches, launchd's per-app XPC service and Electron's
// Info.plist malloc override (macOS), Electron's desktop overrides and the
// AppImage runtime (Linux), and the identity/nesting of whichever terminal
// started a development build. A system terminal never passes these on.
const APP_ENVIRONMENT = new Set(['TERMINAL_DEV_URL', 'XPC_SERVICE_NAME', 'XPC_FLAGS', 'MALLOCNANOZONE', 'CHROME_DESKTOP', 'ORIGINAL_XDG_CURRENT_DESKTOP', 'APPIMAGE', 'APPDIR', 'OWD', 'ARGV0', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'ITERM_SESSION_ID', 'ITERM_PROFILE', 'LC_TERMINAL', 'LC_TERMINAL_VERSION', 'WT_SESSION', 'WT_PROFILE_ID', 'SHLVL', 'PWD', 'OLDPWD', '_']);
const APP_ENVIRONMENT_PREFIXES = ['ELECTRON_', 'VSCODE_'];
let cachedSystemLocale;

function appVersion() {
  try { return require('../package.json').version || ''; } catch { return ''; }
}

function systemLocale(platform = process.platform) {
  if (cachedSystemLocale !== undefined) return cachedSystemLocale;
  cachedSystemLocale = '';
  try {
    if (platform === 'darwin') cachedSystemLocale = require('node:child_process').execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLocale'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    else cachedSystemLocale = Intl.DateTimeFormat().resolvedOptions().locale || '';
  } catch { /* Fall back to en_US.UTF-8 below. */ }
  return cachedSystemLocale;
}

function localeExists(name, platform = process.platform) {
  // macOS ships one directory per locale; Linux falls back to C.UTF-8.
  if (platform !== 'darwin') return false;
  try { return fsSync.statSync(path.join('/usr/share/locale', name)).isDirectory(); } catch { return false; }
}

// Terminal.app sets LANG from the macOS region ("Set locale environment
// variables on startup"); apps opened from Finder get no LANG at all, which
// leaves the C locale and breaks UTF-8 in many tools. Only fill a gap.
function utf8Locale(env, { platform = process.platform, locale, exists = name => localeExists(name, platform) } = {}) {
  if (platform === 'win32' || env.LC_ALL || env.LC_CTYPE || env.LANG) return null;
  const match = /^([a-z]{2,3})(?:[-_][A-Z][a-z]{3})?[-_]([A-Z]{2})\b/.exec(String(locale ?? systemLocale(platform)));
  const candidates = match ? [`${match[1]}_${match[2]}.UTF-8`, `${match[1]}_${match[1].toUpperCase()}.UTF-8`] : [];
  if (platform === 'darwin') return candidates.find(exists) || 'en_US.UTF-8';
  return 'C.UTF-8';
}

function defaultEnvironment(home = os.homedir(), source = process.env, platform = process.platform) {
  const env = Object.fromEntries(Object.entries(source).filter(([name, value]) => {
    const upper = name.toUpperCase();
    return typeof value === 'string' && !APP_ENVIRONMENT.has(upper) && !APP_ENVIRONMENT_PREFIXES.some(prefix => upper.startsWith(prefix));
  }));
  if (platform === 'linux' && source.ORIGINAL_XDG_CURRENT_DESKTOP) env.XDG_CURRENT_DESKTOP = source.ORIGINAL_XDG_CURRENT_DESKTOP;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Mullion-Terminal';
  const version = appVersion();
  if (version) env.TERM_PROGRAM_VERSION = version;
  const lang = utf8Locale(env, { platform });
  if (lang) env.LANG = lang;
  if (platform !== 'win32') {
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

// Mouse support for nano/pico inside this terminal only: a click places the
// cursor. User aliases/functions win, and MULLION_EDITOR_MOUSE=0 opts out.
// UW pico (macOS's nano) enables xterm mouse tracking only when DISPLAY is set.
function editorWrappers(shell) {
  const defined = name => shell === 'zsh'
    ? `(( \x24{+aliases[${name}]} || \x24{+functions[${name}]} ))`
    : `{ alias ${name} >/dev/null 2>&1 || declare -F ${name} >/dev/null; }`;
  return `
__mullion_editor_mouse() {
  local __mullion_editor="$1" __mullion_path
  shift
  if [[ "\x24{MULLION_EDITOR_MOUSE:-1}" == 0 ]]; then command "$__mullion_editor" "$@"; return; fi
  __mullion_path="$(${shell === 'zsh' ? 'whence -p' : 'type -P'} -- "$__mullion_editor" 2>/dev/null)"
  if [[ "$__mullion_editor" == pico || "\x24{__mullion_path##*/}" == pico || ( -L "$__mullion_path" && "$(command readlink -- "$__mullion_path" 2>/dev/null)" == *pico ) ]]; then
    DISPLAY="\x24{DISPLAY:-:0}" command "$__mullion_editor" -m "$@"
  else
    command "$__mullion_editor" -m "$@"
  fi
}
if ! ${defined('nano')}; then function nano { __mullion_editor_mouse nano "$@"; }; fi
if ! ${defined('pico')}; then function pico { __mullion_editor_mouse pico "$@"; }; fi
`;
}

// Colors option-looking words (-la, --force, --) while typing at the zsh prompt.
// An installed syntax highlighter always wins, and MULLION_HIGHLIGHT=0 opts out.
// zsh 5.9 tags entries with memo=mullion; older versions remember what was added
// so entries from the user's own widgets are never removed.
function flagHighlighter() {
  const others = '(( \x24{+ZSH_HIGHLIGHT_VERSION} + \x24{+FAST_HIGHLIGHT} + \x24{+functions[_zsh_highlight]} + \x24{+functions[fast-highlight-process]} ))';
  const add = (start, end) => `__mullion_added+=("$(( ${start} )) $(( ${end} )) $__mullion_highlight_face\x24{__mullion_highlight_memo:+ memo=mullion}")`;
  return `
typeset -g __mullion_highlight_face __mullion_highlight_memo
typeset -ga __mullion_highlight_entries
__mullion_highlight() {
  emulate -L zsh
  if [[ -n $__mullion_highlight_memo ]]; then
    region_highlight=("\x24{(@)region_highlight:#*memo=mullion*}")
  else
    local __mullion_entry
    for __mullion_entry in "\x24{(@)__mullion_highlight_entries}"; do
      region_highlight=("\x24{(@)region_highlight:#\x24{__mullion_entry}}")
    done
  fi
  __mullion_highlight_entries=()
  [[ -n $__mullion_highlight_face && "\x24{MULLION_HIGHLIGHT:-1}" != 0 ]] || return 0
  ${others} && return 0
  local __mullion_buffer="$BUFFER" __mullion_char __mullion_quote=''
  integer __mullion_i __mullion_start=0 __mullion_boundary=1 __mullion_length=\x24{#BUFFER}
  local -a __mullion_added
  # Keypresses stay fast on huge pasted buffers.
  (( __mullion_length > 4096 )) && return 0
  for (( __mullion_i = 1; __mullion_i <= __mullion_length; __mullion_i++ )); do
    __mullion_char="\x24{__mullion_buffer[__mullion_i]}"
    if [[ -n $__mullion_quote ]]; then
      if [[ "$__mullion_char" == "$__mullion_quote" ]]; then __mullion_quote=''
      elif [[ $__mullion_quote == '"' && "$__mullion_char" == '\\' ]]; then (( __mullion_i++ ))
      fi
    elif [[ "$__mullion_char" == [[:space:]] || ';|(' == *"$__mullion_char"* ]]; then
      if (( __mullion_start )); then
        ${add('__mullion_start - 1', '__mullion_i - 1')}
        __mullion_start=0
      fi
      __mullion_boundary=1
    elif [[ "$__mullion_char" == "'" || "$__mullion_char" == '"' ]]; then
      __mullion_quote="$__mullion_char"
      __mullion_boundary=0
    elif [[ "$__mullion_char" == '\\' ]]; then
      (( __mullion_i++ ))
      __mullion_boundary=0
    elif (( __mullion_boundary )) && [[ "$__mullion_char" == - ]]; then
      (( __mullion_start = __mullion_i ))
      __mullion_boundary=0
    else
      __mullion_boundary=0
    fi
  done
  if (( __mullion_start )); then
    ${add('__mullion_start - 1', '__mullion_length')}
  fi
  (( \x24{#__mullion_added} )) || return 0
  region_highlight+=("\x24{(@)__mullion_added}")
  # Store entries as zsh reports them back, in case it normalizes the text.
  [[ -n $__mullion_highlight_memo ]] || __mullion_highlight_entries=("\x24{(@)region_highlight[-\x24{#__mullion_added},-1]}")
  return 0
}
__mullion_highlight_setup() {
  emulate -L zsh
  # add-zle-hook-widget arrived in zsh 5.3; +X fails where it does not exist.
  # This runs from both .zshrc and .zlogin, so it may already be loaded.
  (( \x24{+functions[add-zle-hook-widget]} )) || autoload -Uz +X add-zle-hook-widget 2>/dev/null || return 0
  (( \x24{+functions[add-zle-hook-widget]} )) || return 0
  add-zle-hook-widget -d line-pre-redraw __mullion_highlight 2>/dev/null
  [[ "\x24{MULLION_HIGHLIGHT:-1}" == 0 ]] && return 0
  ${others} && return 0
  local -a __mullion_version
  __mullion_version=(\x24{(s:.:)ZSH_VERSION})
  integer __mullion_major="\x24{__mullion_version[1]%%[^0-9]*}" __mullion_minor="\x24{__mullion_version[2]%%[^0-9]*}"
  # Truecolor faces need zsh 5.7; memo= tags need zsh 5.9.
  if (( __mullion_major > 5 || (__mullion_major == 5 && __mullion_minor >= 7) )); then __mullion_highlight_face='fg=#2f81f7'
  else __mullion_highlight_face='fg=33'
  fi
  if (( __mullion_major > 5 || (__mullion_major == 5 && __mullion_minor >= 9) )); then __mullion_highlight_memo=1
  else __mullion_highlight_memo=''
  fi
  add-zle-hook-widget line-pre-redraw __mullion_highlight 2>/dev/null
}
__mullion_highlight_setup 2>/dev/null
`;
}

function unixHooks(nonce, shell, navigationFile) {
  // $__mullion_status is read from $__mullion_last_status, captured by a dedicated hook
  // (see below) rather than $? directly: a prompt theme's own precmd/PROMPT_COMMAND hooks
  // can run one of our hooks' command substitutions or its own commands first and clobber $?
  // before we'd otherwise get to read it.
  const ready = `printf '\\033]777;Mullion;${nonce};ready;%s;%s;%s;%s\\007' "$(printf '%s' "$PWD" | command base64 | command tr -d '\\r\\n')" "$(printf '%s' "$PATH" | command base64 | command tr -d '\\r\\n')" "$__mullion_navigation_available" "$__mullion_status"`;
  const busy = `printf '\\033]777;Mullion;${nonce};busy\\007'`;
  const record = `printf '\\033]777;Mullion;${nonce};command;%s\\007' "$(printf '%s' "$__mullion_line" | command base64 | command tr -d '\\r\\n')"`;
  if (shell === 'zsh') return `
__mullion_last_status=0
__mullion_capture_status() { __mullion_last_status=$?; }
# A prompt theme's own precmd hook (pure, starship, powerlevel10k, …) is registered with
# add-zsh-hook too, which appends: since ours is set up after the user's .zshrc has already
# run, a plain \x24{precmd_functions[@]} ordering would leave theirs running (and potentially
# changing $?) before ours ever sees it. Keeping our capture at index 1 guarantees it runs
# before any other precmd function, theirs included, so it reads the real, unclobbered $?.
# Some themes rebuild precmd_functions on every prompt, so this is re-asserted in preexec too.
__mullion_ensure_capture() {
  if [[ "\x24{precmd_functions[1]}" != __mullion_capture_status ]]; then
    precmd_functions=(__mullion_capture_status "\x24{(@)precmd_functions:#__mullion_capture_status}")
  fi
}
__mullion_ready() {
  local __mullion_status=$__mullion_last_status
  PROMPT='%F{cyan}%1~%f %F{yellow}❯%f '
  RPROMPT=''
  ${ready}
  return $__mullion_status
}
__mullion_busy() { local __mullion_line="$1"; __mullion_ensure_capture; ${record}; ${busy}; }
autoload -Uz add-zsh-hook
add-zsh-hook -d precmd __mullion_ready 2>/dev/null
add-zsh-hook -d preexec __mullion_busy 2>/dev/null
add-zsh-hook precmd __mullion_ready
add-zsh-hook preexec __mullion_busy
__mullion_ensure_capture
${navigationFile ? unixNavigation(nonce, shell, navigationFile) : ''}${editorWrappers(shell)}${flagHighlighter()}`;
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
__mullion_last_status=0
__mullion_capture_status() { __mullion_last_status=$?; }
(( BASH_VERSINFO[0] == 3 )) && __mullion_legacy_readline=1
__mullion_ready() {
  local __mullion_status=$__mullion_last_status
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
# __mullion_capture_status must run before the user's own PROMPT_COMMAND entries (a prompt
# theme's own PROMPT_COMMAND hook can run commands that change $? before we'd otherwise see
# it), so it goes at the front rather than being appended like __mullion_ready.
if declare -p PROMPT_COMMAND 2>/dev/null | command grep -q 'declare -a'; then
  PROMPT_COMMAND=(__mullion_capture_status "\x24{PROMPT_COMMAND[@]}" __mullion_ready)
else
  PROMPT_COMMAND="__mullion_capture_status; \x24{PROMPT_COMMAND:+\x24PROMPT_COMMAND; }__mullion_ready"
fi
${navigationFile ? unixNavigation(nonce, shell, navigationFile) : ''}${editorWrappers(shell)}`;
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
    return { shell, args: ['-l', '-i'], env: { ...env, ZDOTDIR: directory }, navigationFile, navigationSequence: NAVIGATION_SEQUENCE, lineReset: LINE_RESET_SEQUENCE };
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
    return { shell, args: ['--rcfile', rc, '-i'], env, navigationFile, navigationSequence: NAVIGATION_SEQUENCE, lineReset: LINE_RESET_SEQUENCE };
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
  # InvokePrompt writes through the console code page (437/720/… on Windows
  # PowerShell), which turns the prompt's ❯ into "?". Use UTF-8 for this one
  # redraw only, leaving the encoding programs see untouched.
  $mullionEncoding = [Console]::OutputEncoding
  try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
  try {
    # PSReadLine remembers the row its prompt started on, but a terminal resize
    # rewraps earlier output and makes that row stale: the redraw would then
    # overwrite the last line of output and leave the old prompt behind. Locate
    # the prompt from the live cursor instead, and clear from there down.
    $mullionTop = $null
    try {
      $mullionLine = $null; $mullionCursor = 0
      [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$mullionLine, [ref]$mullionCursor)
      if ($global:__mullion_promptText -and -not $mullionLine.Contains([char]10)) {
        $mullionCells = $Host.UI.RawUI.LengthInBufferCells($global:__mullion_promptText + $mullionLine.Substring(0, $mullionCursor))
        $mullionTop = [Math]::Max(0, [Console]::CursorTop - [Math]::Floor($mullionCells / [Console]::BufferWidth))
      }
    } catch { $mullionTop = $null }
    if ($null -ne $mullionTop) {
      [Console]::SetCursorPosition(0, $mullionTop)
      [Console]::Write("$([char]27)[J")
      [Microsoft.PowerShell.PSConsoleReadLine]::InvokePrompt($null, [int]$mullionTop)
    } else { [Microsoft.PowerShell.PSConsoleReadLine]::InvokePrompt() }
  }
  finally { try { [Console]::OutputEncoding = $mullionEncoding } catch { } }
}
# Keep replacement/navigation editing consistent with the app's PTY controls.
# These bindings affect this process only; no user profile is modified.
# Each binding is independent: one PSReadLine version lacking a function must
# not leave the others (or folder navigation) unbound.
try { Import-Module PSReadLine -ErrorAction Stop } catch {
  # PowerShell remains usable on installations without the optional module.
}
if (Get-Module PSReadLine) {
  try { Set-PSReadLineKeyHandler -Chord 'Ctrl+e' -Function EndOfLine -ErrorAction Stop } catch { }
  # PSReadLine 2.1 added BackwardDeleteInput; Windows PowerShell 5.1 ships 2.0,
  # whose BackwardDeleteLine already deletes back to the start of the input.
  # An unbound Ctrl+U would instead insert the active keyboard layout's letter.
  try { Set-PSReadLineKeyHandler -Chord 'Ctrl+u' -Function BackwardDeleteInput -ErrorAction Stop } catch {
    try { Set-PSReadLineKeyHandler -Chord 'Ctrl+u' -Function BackwardDeleteLine -ErrorAction Stop } catch { }
  }
  # The app's own line replacement (see POWERSHELL_LINE_RESET_SEQUENCE).
  try { Set-PSReadLineKeyHandler -Chord 'Ctrl+Alt+Shift+F11' -Function RevertLine -ErrorAction Stop } catch { }
  # PSReadLine 2.2+ (PowerShell 7) draws its own gray prediction after the
  # cursor, which hides the app's suggestions: they only appear while nothing
  # follows the cursor. The app offers history suggestions itself.
  try { Set-PSReadLineOption -PredictionSource None -ErrorAction Stop } catch { }
  try {
    if (-not ([Microsoft.PowerShell.PSConsoleReadLine].GetMethods().Name -contains 'InvokePrompt')) { throw 'Prompt refresh unavailable' }
    Set-PSReadLineKeyHandler -Chord 'Ctrl+Alt+Shift+F12' -ScriptBlock { __mullion_navigate } -ErrorAction Stop
    $global:__mullion_navigation_available = 1
  } catch { }
}
# Match the zsh flag color, unless the user already chose their own Parameter
# color (PSReadLine's shipped default is DarkGray, ESC[90m).
try {
  if ((Get-PSReadLineOption).ParameterColor -eq "$([char]0x1b)[90m") {
    Set-PSReadLineOption -Colors @{ Parameter = "$([char]0x1b)[38;2;47;129;247m" } -ErrorAction Stop
  }
} catch { }
$global:__mullion_historyId = (Get-History -Count 1).Id
$global:__mullion_firstPrompt = $true
$global:__mullion_lastError = $null
function global:prompt {
  # Read before anything else in this function can change them.
  $mullionSucceeded = $?
  $mullionExitCode = $global:LASTEXITCODE
  $mullionHistory = Get-History -Count 1
  $mullionError = if ($global:Error.Count) { $global:Error[0] } else { $null }
  # Reported like a POSIX status so the app can skip learning a command that
  # never ran: 127 for "not recognized", 130 for Ctrl+C, 1 for other failures.
  $mullionStatus = 0
  if ($global:__mullion_firstPrompt) {
    $global:__mullion_firstPrompt = $false
    $global:__mullion_historyId = $mullionHistory.Id
  } elseif ($mullionHistory -and $mullionHistory.Id -ne $global:__mullion_historyId) {
    $global:__mullion_historyId = $mullionHistory.Id
    $mullionCommand64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($mullionHistory.CommandLine))
    [Console]::Write("$([char]27)]777;Mullion;${nonce};command;$mullionCommand64$([char]7)")
    if ("$($mullionHistory.ExecutionStatus)" -eq 'Stopped' -or $mullionExitCode -eq -1073741510) { $mullionStatus = 130 }
    elseif (-not $mullionSucceeded) {
      $mullionNewError = $mullionError -and -not [object]::ReferenceEquals($mullionError, $global:__mullion_lastError)
      $mullionStatus = if ($mullionNewError -and $mullionError.FullyQualifiedErrorId -eq 'CommandNotFoundException') { 127 } else { 1 }
    }
  }
  $global:__mullion_lastError = $mullionError
  $mullionCwd = (Get-Location).ProviderPath
  if (-not $mullionCwd) { $mullionCwd = (Get-Location).Path }
  $mullionCwd64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($mullionCwd))
  $mullionPath64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($env:PATH))
  [Console]::Write("$([char]27)]777;Mullion;${nonce};ready;$mullionCwd64;$mullionPath64;$global:__mullion_navigation_available;$mullionStatus$([char]7)")
  $mullionName = if ($mullionCwd -eq $HOME) { '~' } else { Split-Path -Path $mullionCwd -Leaf }
  if (-not $mullionName) { $mullionName = [IO.Path]::GetPathRoot($mullionCwd) }
  if (-not $mullionName) { $mullionName = $mullionCwd }
  # Kept for __mullion_navigate, which must not call prompt (it reports state).
  $global:__mullion_promptText = "$mullionName ❯ "
  $global:__mullion_promptText
}
`;
    await fs.writeFile(rc, script, { mode: 0o600 });
    // Inline commands work with Windows' normal script execution policy. Do not
    // change ExecutionPolicy or disable the user's PowerShell profiles.
    return { shell, args: ['-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], env, navigationFile, navigationSequence: POWERSHELL_NAVIGATION_SEQUENCE, lineReset: POWERSHELL_LINE_RESET_SEQUENCE };
  }
  throw new Error('Unsupported shell. Use zsh, bash, or PowerShell.');
}

module.exports = { defaultEnvironment, utf8Locale, selectShell, prepareShell, unixHooks, editorWrappers, flagHighlighter, findExecutable, NAVIGATION_SEQUENCE, LINE_RESET_SEQUENCE, POWERSHELL_NAVIGATION_SEQUENCE, POWERSHELL_LINE_RESET_SEQUENCE, navigationRequest };
