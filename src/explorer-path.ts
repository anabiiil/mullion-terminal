interface PathPart { value: string; end: number; }
interface ParsedPath { source: string; root: string; volume: string; parts: PathPart[]; }

function isWindows(first: string, second: string, platform?: string) {
  if (platform !== undefined) return platform === 'win32';
  return /^[a-z]:([\\/]|$)/i.test(first) || /^[a-z]:([\\/]|$)/i.test(second) || first.includes('\\') || second.includes('\\');
}

function parse(path: string, windows: boolean): ParsedPath {
  let root = '', volume = '', offset = 0;
  if (windows) {
    const share = path.match(/^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)([\\/]|$)/);
    const drive = path.match(/^[a-z]:([\\/]|$)/i);
    if (share) {
      offset = share[0].length;
      root = share[0] + (share[3] ? '' : (path.includes('\\') ? '\\' : '/'));
      volume = `//${share[1]}/${share[2]}`.toLowerCase();
    } else if (drive) {
      offset = drive[0].length;
      root = drive[0] + (drive[1] ? '' : '\\');
      volume = path.slice(0, 2).toLowerCase();
    } else if (/^[\\/]/.test(path)) {
      root = path[0]; volume = '/'; offset = 1;
    }
  } else if (path.startsWith('/')) {
    root = '/'; volume = '/'; offset = 1;
  }
  const parts = Array.from(path.matchAll(windows ? /[^\\/]+/g : /[^/]+/g))
    .filter(match => match.index >= offset)
    .map(match => ({ value: windows ? match[0].toLowerCase() : match[0], end: match.index + match[0].length }));
  return { source: path, root, volume, parts };
}

function matchesRoot(first: ParsedPath, second: ParsedPath) {
  return first.volume === second.volume && Boolean(first.root) === Boolean(second.root);
}

function prefix(path: ParsedPath, count: number) {
  return count ? path.source.slice(0, path.parts[count - 1].end) : path.root;
}

/** Directory containment compares complete path components, never just a string prefix. */
export function containsPath(root: string, cwd: string, platform?: string): boolean {
  const windows = isWindows(root, cwd, platform);
  const first = parse(root, windows), second = parse(cwd, windows);
  return matchesRoot(first, second) && first.parts.length <= second.parts.length &&
    first.parts.every((part, index) => part.value === second.parts[index].value);
}

export function samePath(first: string, second: string, platform?: string): boolean {
  return containsPath(first, second, platform) && containsPath(second, first, platform);
}

/** Keep the tree rooted above both folders, retaining the original path spelling. */
export function commonAncestor(root: string, cwd: string, platform?: string): string {
  const windows = isWindows(root, cwd, platform);
  const first = parse(root, windows), second = parse(cwd, windows);
  if (!matchesRoot(first, second)) return cwd;
  let shared = 0;
  while (shared < first.parts.length && shared < second.parts.length && first.parts[shared].value === second.parts[shared].value) shared++;
  if (shared === first.parts.length) return root;
  return prefix(first, shared) || cwd;
}

export function parentPath(path: string, platform?: string): string {
  const parsed = parse(path, isWindows(path, '', platform));
  return parsed.parts.length ? prefix(parsed, parsed.parts.length - 1) || path : path;
}
