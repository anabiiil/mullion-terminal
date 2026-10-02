import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { ExternalLink, FileText, Pencil, X } from 'lucide-react';
import { classifyLink, headingSlug, parentDirectory, renderMarkdownToSafeHtml } from './markdown';

interface Props {
  path: string;
  close(): void;
  edit(path: string): void;
  openExternally(path: string): void;
  openMarkdown(path: string, fragment?: string): void;
  fragment?: string;
  onError(error: unknown): void;
}
type Loaded = { path: string; html: string } | { path: string; error: string } | null;

function name(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path; }
function message(error: unknown) { return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error); }

function placeholder(image: HTMLImageElement, text: string, url?: string) {
  const label = image.getAttribute('alt') || 'Image';
  const element = document.createElement(url ? 'a' : 'span');
  element.className = 'markdown-image-placeholder';
  element.textContent = label;
  element.title = text;
  if (url) element.setAttribute('href', url);
  image.replaceWith(element);
}

function scrollToFragment(container: HTMLElement, fragment: string) {
  const wanted = headingSlug(fragment);
  const heading = [...container.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')].find(element => headingSlug(element.textContent ?? '') === wanted);
  heading?.scrollIntoView({ block: 'start' });
}

/** Read-only rendered view of a Markdown file, overlaying the terminal. */
export default function MarkdownPreview({ path, close, edit, openExternally, openMarkdown, fragment, onError }: Props) {
  const [loaded, setLoaded] = useState<Loaded>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const baseDirectory = useMemo(() => parentDirectory(path), [path]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    window.terminalAPI!.readTextFile(path).then(source => {
      if (!cancelled) setLoaded({ path, html: renderMarkdownToSafeHtml(source, { baseDirectory: parentDirectory(path) }) });
    }).catch(error => { if (!cancelled) setLoaded({ path, error: message(error) }); });
    return () => { cancelled = true; };
  }, [path]);

  // Take focus so arrow keys scroll and Escape closes; App restores the terminal's focus on close.
  useEffect(() => { scroller.current?.focus({ preventScroll: true }); }, []);

  const html = loaded && 'html' in loaded ? loaded.html : null;
  useEffect(() => {
    const container = content.current, scroll = scroller.current;
    if (html === null || !container) return;
    if (scroll) scroll.scrollTop = 0;
    if (fragment) scrollToFragment(container, fragment);
    let cancelled = false;
    // Local images arrive as size-limited data: URLs from the main process.
    for (const image of container.querySelectorAll<HTMLImageElement>('img[data-md-image]')) {
      const kind = image.dataset.mdImage;
      if (kind === 'local' && image.dataset.mdSrc) {
        window.terminalAPI!.readImage(image.dataset.mdSrc).then(url => {
          if (!cancelled) image.src = url;
        }).catch(error => { if (!cancelled) placeholder(image, `Image unavailable: ${message(error)}`); });
      } else if (kind === 'remote') placeholder(image, `Remote image (click to open in your browser): ${image.dataset.mdRemote}`, image.dataset.mdRemote);
      else if (kind === 'blocked') placeholder(image, 'This image source is not supported in the preview.');
    }
    return () => { cancelled = true; };
  }, [html, fragment]);

  // Never let the window follow a link itself: every click is routed here.
  function onLinkClick(event: ReactMouseEvent<HTMLDivElement>) {
    const anchor = (event.target as Element).closest?.('a');
    if (!anchor || !content.current?.contains(anchor)) return;
    event.preventDefault();
    if (event.type !== 'click') return;
    const target = classifyLink(anchor.getAttribute('href'), baseDirectory);
    if (target.kind === 'external') window.terminalAPI!.openExternalLink(target.url).catch(onError);
    else if (target.kind === 'anchor') scrollToFragment(content.current, target.fragment);
    else if (target.kind === 'markdown') openMarkdown(target.path, target.fragment);
    else if (target.kind === 'file') onError(new Error('Only links to Markdown files or web pages open from the preview.'));
    else onError(new Error('This link type is not supported in the preview.'));
  }

  const title = name(path);
  return <section className="markdown-preview" role="region" aria-label={`Markdown preview of ${title}`} onKeyDown={event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }}>
    <header className="markdown-preview-bar">
      <FileText size={14} aria-hidden="true" />
      <span className="markdown-preview-title" title={path}>{title}</span>
      <span className="markdown-preview-badge">Preview</span>
      <div className="markdown-preview-actions">
        <button onClick={() => edit(path)} title="Edit this file" aria-label="Edit"><Pencil size={13} /><span>Edit</span></button>
        <button onClick={() => openExternally(path)} title="Open with the default application" aria-label="Open externally"><ExternalLink size={13} /><span>Open externally</span></button>
        <button className="markdown-preview-close" onClick={close} title="Close preview · Esc" aria-label="Close preview"><X size={15} /></button>
      </div>
    </header>
    <div className="markdown-preview-scroll" ref={scroller} tabIndex={0} aria-label={`${title} contents`}>
      {loaded === null ? <div className="markdown-preview-status">Loading…</div>
        : 'error' in loaded ? <div className="markdown-preview-status error" role="alert">{loaded.error}</div>
        : <div ref={content} className="markdown-body" onClick={onLinkClick} onAuxClick={onLinkClick} dangerouslySetInnerHTML={{ __html: loaded.html }} />}
    </div>
  </section>;
}
