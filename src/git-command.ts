// Pure helper for turning a branch-menu pick into a shell command: run in the active shell (via
// ShellHandle.run), the same way a tree double-click opens nano, so the user sees git's own
// output and errors (e.g. "error: Your local changes... would be overwritten").

/** Single-quotes a value for the target shell (POSIX `sh`/`bash`/`zsh`, or PowerShell on win32). */
function quote(value: string, platform?: string): string {
  return platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * `git switch -- <name>` for a local branch, or `git switch --track <name>` for a remote-only
 * one, where `name` is already the full remote-qualified ref (e.g. `origin/feature-x`) so git
 * derives the new local branch's name on its own.
 */
export function switchBranchCommand(name: string, options: { remote?: boolean; platform?: string } = {}): string {
  const quoted = quote(name, options.platform);
  return options.remote ? `git switch --track ${quoted}` : `git switch -- ${quoted}`;
}
