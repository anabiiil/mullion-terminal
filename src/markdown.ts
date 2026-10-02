// Pure helpers for the Markdown preview: parsing, sanitizing, and classifying
// the links and images a document contains. Nothing here touches the DOM
// except through the sanitizer that is passed in (DOMPurify in the renderer).
import { Marked } from 'marked';
import DOMPurify from 'dompurify';

const MARKDOWN_EXTENSION = /\.(md|markdown|mdx)$/i;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
// Inline images are already in the document, so only raster/vector image
// payloads are kept; anything else (data:text/html, …) is dropped.
const INLINE_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i;

/** True for files the tree should open in the Markdown preview. */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSION.test(path.split(/[\\/]/).at(-1) ?? '');
}

function separatorFor(path: string): '/' | '\\' {
  return /^[a-z]:\\|^\\\\/i.test(path) || (path.includes('\\') && !path.includes('/')) ? '\\' : '/';
}

/** Folder that contains `path`, keeping the path's own separator style. */
export function parentDirectory(path: string): string {
  const separator = separatorFor(path);
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (index < 0) return '.';
  if (index === 0) return separator;
  const parent = trimmed.slice(0, index);
  return /^[a-z]:$/i.test(parent) ? parent + separator : parent;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[a-z]:[\\/]/i.test(path);
}

function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Split a reference into its path part and its #fragment (without query). */
function splitReference(reference: string): { path: string; fragment: string } {
  const hash = reference.indexOf('#');
  const withoutHash = hash < 0 ? reference : reference.slice(0, hash);
  const fragment = hash < 0 ? '' : decode(reference.slice(hash + 1));
  const query = withoutHash.indexOf('?');
  return { path: decode(query < 0 ? withoutHash : withoutHash.slice(0, query)), fragment };
}

/**
 * Resolve a document-relative path (as written in Markdown, with forward
 * slashes) against `baseDirectory`. Absolute paths are normalized as-is.
 * `..` never climbs above the filesystem root.
 */
export function resolveDocumentPath(baseDirectory: string, reference: string): string {
  const separator = separatorFor(baseDirectory);
  const absolute = isAbsolutePath(reference);
  const start = absolute ? reference : `${baseDirectory}${separator}${reference}`;
  // Keep a drive letter, or the extra leading backslash of a UNC share.
  const drive = /^([a-z]:)[\\/]/i.exec(start)?.[1] ?? (start.startsWith('\\\\') ? '\\' : '');
  const rest = start.slice(drive.length);
  const parts: string[] = [];
  for (const part of rest.split(/[\\/]+/)) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${drive}${separator}${parts.join(separator)}`;
}

export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'anchor'; fragment: string }
  | { kind: 'markdown'; path: string; fragment: string }
  | { kind: 'file'; path: string }
  | { kind: 'blocked' };

/**
 * Decide what clicking a link in the preview should do. Only http(s) and
 * mailto leave the app (through the main process); relative links stay
 * local; every other scheme (file:, javascript:, data:, …) is blocked.
 */
export function classifyLink(href: string | null | undefined, baseDirectory: string): LinkTarget {
  const value = (href ?? '').trim();
  if (!value) return { kind: 'blocked' };
  if (value.startsWith('#')) return { kind: 'anchor', fragment: decode(value.slice(1)) };
  if (value.startsWith('//')) return { kind: 'blocked' };
  const scheme = SCHEME.exec(value)?.[1];
  // A single letter before ':' is a Windows drive, not a URL scheme.
  if (scheme && scheme.length > 1) {
    try {
      const url = new URL(value);
      return EXTERNAL_PROTOCOLS.has(url.protocol) ? { kind: 'external', url: url.href } : { kind: 'blocked' };
    } catch { return { kind: 'blocked' }; }
  }
  const { path, fragment } = splitReference(value);
  if (!path) return fragment ? { kind: 'anchor', fragment } : { kind: 'blocked' };
  const resolved = resolveDocumentPath(baseDirectory, path);
  return isMarkdownPath(resolved) ? { kind: 'markdown', path: resolved, fragment } : { kind: 'file', path: resolved };
}

export type ImageSource = { kind: 'inline' } | { kind: 'local'; path: string } | { kind: 'remote'; url: string } | { kind: 'blocked' };

/** Decide how an `<img src>` may be displayed. Local files are never loaded by URL. */
export function classifyImageSource(src: string | null | undefined, baseDirectory: string): ImageSource {
  const value = (src ?? '').trim();
  if (!value) return { kind: 'blocked' };
  if (INLINE_IMAGE.test(value)) return { kind: 'inline' };
  if (value.startsWith('//')) return { kind: 'blocked' };
  const scheme = SCHEME.exec(value)?.[1];
  if (scheme && scheme.length > 1) {
    return /^https?$/i.test(scheme) ? { kind: 'remote', url: value } : { kind: 'blocked' };
  }
  const { path } = splitReference(value);
  return path ? { kind: 'local', path: resolveDocumentPath(baseDirectory, path) } : { kind: 'blocked' };
}

/** GitHub-style heading slug, used to follow `#section` links. */
export function headingSlug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

const parser = new Marked({ gfm: true, breaks: false, async: false });

/** Markdown to (unsanitized) HTML. Never inject this directly. */
export function parseMarkdown(source: string): string {
  return parser.parse(source, { async: false }) as string;
}

// Markup that could load local files, cover the app chrome, submit data or
// reference app classes/ids is removed before the document reaches the DOM.
export const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'link', 'meta', 'base', 'form', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'object', 'embed', 'video', 'audio', 'source', 'track', 'picture', 'dialog', 'template'],
  FORBID_ATTR: ['style', 'class', 'id', 'name', 'srcset', 'target', 'ping', 'action', 'formaction', 'background', 'poster', 'autofocus', 'tabindex'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: true,
};

export interface Sanitizer {
  isSupported: boolean;
  sanitize(dirty: string, config: typeof SANITIZE_CONFIG & { RETURN_TRUSTED_TYPE: false }): string;
  addHook(entryPoint: 'afterSanitizeAttributes', hook: (node: Element) => void): void;
  removeHook(entryPoint: 'afterSanitizeAttributes'): unknown;
}

export interface RenderOptions { baseDirectory: string; purify?: Sanitizer; }

/**
 * Parse and sanitize a Markdown document. Images lose their `src`: inline
 * data images keep it, local files get `data-md-src` (loaded later through a
 * size-limited IPC call), remote images get `data-md-remote`. Throws instead
 * of returning unsanitized HTML when no DOM sanitizer is available.
 */
export function renderMarkdownToSafeHtml(source: string, { baseDirectory, purify = DOMPurify as unknown as Sanitizer }: RenderOptions): string {
  if (!purify?.isSupported) throw new Error('Markdown preview needs a DOM sanitizer.');
  const html = parseMarkdown(source);
  purify.addHook('afterSanitizeAttributes', node => {
    const tag = node.tagName;
    if (tag === 'IMG') {
      const image = classifyImageSource(node.getAttribute('src'), baseDirectory);
      if (image.kind !== 'inline') node.removeAttribute('src');
      node.setAttribute('data-md-image', image.kind);
      if (image.kind === 'local') node.setAttribute('data-md-src', image.path);
      if (image.kind === 'remote') node.setAttribute('data-md-remote', image.url);
      node.setAttribute('loading', 'lazy');
    } else if (tag === 'A') {
      node.setAttribute('rel', 'noreferrer noopener');
    } else if (tag === 'INPUT') {
      // GFM task list items are the only inputs Markdown produces.
      node.setAttribute('type', 'checkbox');
      node.setAttribute('disabled', '');
    }
  });
  try {
    return purify.sanitize(html, { ...SANITIZE_CONFIG, RETURN_TRUSTED_TYPE: false });
  } finally {
    purify.removeHook('afterSanitizeAttributes');
  }
}
