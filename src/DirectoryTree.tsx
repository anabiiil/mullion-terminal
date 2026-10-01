import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, ArrowUp, RefreshCw, FolderPlus } from 'lucide-react';
import { containsPath, parentPath, samePath } from './explorer-path';
import type { DirectoryEntry } from './types';

interface Props { root: string; cwd: string; home: string; platform?: string; showHidden: boolean; disabled: boolean; navigate(path: string): void; choose(): void; onRootChange?(path: string): void; onError(error: unknown): void; }
function name(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path; }
interface ChildrenProps {
  path: string; depth: number; props: Props; refresh: number;
  expanded: Set<string>; setExpanded: Dispatch<SetStateAction<Set<string>>>;
  scrollContainer: RefObject<HTMLDivElement | null>;
}

function Children({ path, depth, props, refresh, expanded, setExpanded, scrollContainer }: ChildrenProps) {
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [status, setStatus] = useState('Loading…');
  const selectedRow = useRef<HTMLDivElement>(null);
  const navigationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(navigationTimer.current), []);
  useEffect(() => {
    let cancelled = false;
    setStatus('Loading…');
    window.terminalAPI!.listDirectory(path, props.showHidden).then(value => {
      if (!cancelled) { setEntries(value); setStatus(value.length ? '' : 'Empty folder'); }
    }).catch(error => { if (!cancelled) setStatus(String(error.message ?? error)); });
    return () => { cancelled = true; };
  }, [path, props.showHidden, refresh]);

  // Opening the ancestors reveals the current directory without changing the tree's root.
  useEffect(() => {
    const ancestors = entries.filter(entry => entry.isDirectory && containsPath(entry.path, props.cwd, props.platform) && !samePath(entry.path, props.cwd, props.platform));
    if (!ancestors.length) return;
    setExpanded(previous => {
      if (ancestors.every(entry => previous.has(entry.path))) return previous;
      const next = new Set(previous);
      ancestors.forEach(entry => next.add(entry.path));
      return next;
    });
  }, [entries, props.cwd, props.platform, setExpanded]);

  useLayoutEffect(() => {
    const row = selectedRow.current, container = scrollContainer.current;
    if (!row || !container) return;
    const rowBounds = row.getBoundingClientRect(), bounds = container.getBoundingClientRect();
    if (rowBounds.top < bounds.top) container.scrollTop += rowBounds.top - bounds.top;
    else if (rowBounds.bottom > bounds.bottom) container.scrollTop += rowBounds.bottom - bounds.bottom;
  }, [entries, props.cwd, status, expanded, scrollContainer]);

  if (status) return <div className="tree-message" style={{ paddingLeft: 18 + depth * 13 }}>{status}</div>;
  return <>{entries.map(entry => {
    const open = expanded.has(entry.path);
    const selected = entry.isDirectory && samePath(entry.path, props.cwd, props.platform);
    return <div key={entry.path}>
      <div ref={selected ? selectedRow : undefined} className={`tree-row ${selected ? 'current' : ''}`} data-path={entry.path} style={{ paddingLeft: 8 + depth * 13 }}>
        {entry.isDirectory ? <button className="tree-chevron" aria-label={`${open ? 'Collapse' : 'Expand'} ${entry.name}`} onClick={() => setExpanded(previous => { const next = new Set(previous); if (open) next.delete(entry.path); else next.add(entry.path); return next; })}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button> : <span className="tree-chevron" />}
        <button className="tree-name" title={entry.path} aria-current={selected ? 'location' : undefined} disabled={props.disabled} onClick={() => {
          clearTimeout(navigationTimer.current);
          if (entry.isDirectory) props.navigate(entry.path);
          else navigationTimer.current = setTimeout(() => props.navigate(path), 250);
        }} onDoubleClick={() => {
          clearTimeout(navigationTimer.current);
          if (!entry.isDirectory) window.terminalAPI!.openFile(entry.path).catch(props.onError);
        }}>
          {entry.isDirectory ? (open ? <FolderOpen size={14} /> : <Folder size={14} />) : <File size={13} />}<span>{entry.name}</span>{entry.isSymbolicLink && <span className="symlink">↗</span>}
        </button>
      </div>
      {entry.isDirectory && open && <Children path={entry.path} depth={depth + 1} props={props} refresh={refresh} expanded={expanded} setExpanded={setExpanded} scrollContainer={scrollContainer} />}
    </div>;
  })}</>;
}
export default function DirectoryTree(props: Props) {
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState(new Set<string>());
  const scrollContainer = useRef<HTMLDivElement>(null);
  const selected = samePath(props.root, props.cwd, props.platform);
  const parent = parentPath(props.root, props.platform);
  return <>
    <div className="sidebar-heading"><span>EXPLORER</span><div><button className="icon-button" title="Open a folder" aria-label="Open a folder" onClick={props.choose}><FolderPlus size={15} /></button><button className="icon-button" title="Refresh files" aria-label="Refresh files" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} /></button></div></div>
    <div className={`explorer-root ${selected ? 'current' : ''}`}><button className="icon-button" title="Browse parent folder" aria-label="Browse parent folder" disabled={!props.onRootChange || samePath(parent, props.root, props.platform)} onClick={() => props.onRootChange?.(parent)}><ArrowUp size={14} /></button><button className="tree-name" title={props.root} aria-current={selected ? 'location' : undefined} disabled={props.disabled} onClick={() => props.navigate(props.root)}><FolderOpen size={15} /><span title={props.root}>{samePath(props.root, props.home, props.platform) ? 'Home' : name(props.root)}</span></button></div>
    <div className="tree-scroll" ref={scrollContainer}><Children path={props.root} depth={0} props={props} refresh={refresh} expanded={expanded} setExpanded={setExpanded} scrollContainer={scrollContainer} /></div>
    <div className="sidebar-note">Click a folder to <code>cd</code><br />Double-click a file to open it</div>
  </>;
}
