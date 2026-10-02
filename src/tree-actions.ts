// Pure helpers for turning a directory-tree double-click into a terminal command.
import { containsPath } from './explorer-path';

/**
 * Path of `path` relative to `cwd`, using POSIX separators, when `path` is
 * inside `cwd`; otherwise the original absolute path. Containment is checked
 * by whole path component (via explorer-path's containsPath forced to POSIX
 * rules) so a sibling with a shared prefix, like "/work/app" vs "/work/apple",
 * is never mistaken for a descendant.
 */
export function relativeToCwd(path: string, cwd: string): string {
  if (!containsPath(cwd, path, 'linux')) return path;
  const trimmedCwd = cwd.replace(/\/+$/, '');
  if (!trimmedCwd) return path.replace(/^\/+/, '');
  return path.slice(trimmedCwd.length).replace(/^\/+/, '') || '.';
}

/** Single-quote a path for a POSIX shell, safely escaping embedded single quotes. */
export function quotePosixPath(path: string): string {
  return `'${path.split("'").join("'\\''")}'`;
}

/** The `nano` command used to open a tree file for editing in the active shell. */
export function nanoEditCommand(path: string, cwd: string): string {
  return `nano ${quotePosixPath(relativeToCwd(path, cwd))}`;
}
