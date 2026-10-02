import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, ArrowUp, RefreshCw, FolderPlus } from 'lucide-react';
import { containsPath, parentPath, samePath } from './explorer-path';
import type { DirectoryEntry } from './types';

interface Props { root: string; cwd: string; home: string; platform?: string; showHidden: boolean; navigate(path: string): void; openFile(path: string): void; choose(): void; onRootChange?(path: string): void; onError(error: unknown): void; }
function name(path: string) { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path; }
interface ChildrenProps {
  path: string; depth: number; props: Props; refresh: number;
  expanded: Set<string>; setExpanded: Dispatch<SetStateAction<Set<string>>>;
  selected: string | null; setSelected: Dispatch<SetStateAction<string | null>>;
  scrollContainer: RefObject<HTMLDivElement | null>;
}

function Children({ path, depth, props, refresh, expanded, setExpanded, selected, setSelected, scrollContainer }: ChildrenProps) {
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [status, setStatus] = useState('Loading…');
  const currentRow = useRef<HTMLDivElement>(null);
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
    const row = currentRow.current, container = scrollContainer.current;
    if (!row || !container) return;
    const rowBounds = row.getBoundingClientRect(), bounds = container.getBoundingClientRect();
    if (rowBounds.top < bounds.top) container.scrollTop += rowBounds.top - bounds.top;
    else if (rowBounds.bottom > bounds.bottom) container.scrollTop += rowBounds.bottom - bounds.bottom;
  }, [entries, props.cwd, status, expanded, scrollContainer]);

  if (status) return <div className="tree-message" style={{ paddingLeft: 18 + depth * 13 }}>{status}</div>;
  return <>{entries.map(entry => {
    const open = expanded.has(entry.path);
    const isCurrent = entry.isDirectory && samePath(entry.path, props.cwd, props.platform);
    const isSelected = !isCurrent && selected !== null && samePath(entry.path, selected, props.platform);
    function toggle() {
      setExpanded(previous => {
        const next = new Set(previous);
        if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path);
        return next;
      });
    }
    // A double-click (or Enter) always ends with the folder expanded and the
    // shell navigated, regardless of how the two leading click events left it.
    function activate() {
      if (entry.isDirectory) {
        setExpanded(previous => previous.has(entry.path) ? previous : new Set(previous).add(entry.path));
        props.navigate(entry.path);
      } else {
        props.openFile(entry.path);
      }
    }
    return <div key={entry.path}>
      <div ref={isCurrent ? currentRow : undefined} className={`tree-row ${isCurrent ? 'current' : ''} ${isSelected ? 'selected' : ''}`} data-path={entry.path} style={{ paddingLeft: 8 + depth * 13 }}>
        {entry.isDirectory ? <button className="tree-chevron" aria-label={`${open ? 'Collapse' : 'Expand'} ${entry.name}`} onClick={toggle}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button> : <span className="tree-chevron" />}
        <button className="tree-name" title={entry.path} aria-current={isCurrent ? 'location' : undefined} aria-selected={isSelected || undefined} onClick={() => { if (entry.isDirectory) toggle(); else setSelected(entry.path); }} onDoubleClick={activate} onKeyDown={event => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          activate();
        }}>
          {entry.isDirectory ? (open ? <FolderOpen size={14} /> : <Folder size={14} />) : <File size={13} />}<span>{entry.name}</span>{entry.isSymbolicLink && <span className="symlink">↗</span>}
        </button>
      </div>
      {entry.isDirectory && open && <Children path={entry.path} depth={depth + 1} props={props} refresh={refresh} expanded={expanded} setExpanded={setExpanded} selected={selected} setSelected={setSelected} scrollContainer={scrollContainer} />}
    </div>;
  })}</>;
}
export default function DirectoryTree(props: Props) {
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [selected, setSelected] = useState<string | null>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);
  const isCurrentRoot = samePath(props.root, props.cwd, props.platform);
  const isSelectedRoot = !isCurrentRoot && selected !== null && samePath(props.root, selected, props.platform);
  const parent = parentPath(props.root, props.platform);
  return <>
    <div className="sidebar-heading"><span>EXPLORER</span><div><button className="icon-button" title="Open a folder" aria-label="Open a folder" onClick={props.choose}><FolderPlus size={15} /></button><button className="icon-button" title="Refresh files" aria-label="Refresh files" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} /></button></div></div>
    <div className={`explorer-root ${isCurrentRoot ? 'current' : ''} ${isSelectedRoot ? 'selected' : ''}`}><button className="icon-button" title="Browse parent folder" aria-label="Browse parent folder" disabled={!props.onRootChange || samePath(parent, props.root, props.platform)} onClick={() => props.onRootChange?.(parent)}><ArrowUp size={14} /></button><button className="tree-name" title={props.root} aria-current={isCurrentRoot ? 'location' : undefined} aria-selected={isSelectedRoot || undefined} onClick={() => setSelected(props.root)} onDoubleClick={() => props.navigate(props.root)} onKeyDown={event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      props.navigate(props.root);
    }}><FolderOpen size={15} /><span title={props.root}>{samePath(props.root, props.home, props.platform) ? 'Home' : name(props.root)}</span></button></div>
    <div className="tree-scroll" ref={scrollContainer}><Children path={props.root} depth={0} props={props} refresh={refresh} expanded={expanded} setExpanded={setExpanded} selected={selected} setSelected={setSelected} scrollContainer={scrollContainer} /></div>
    <div className="sidebar-note">Click to expand · Double-click a folder to <code>cd</code><br />Double-click a file to edit · <code>.md</code> to preview</div>
  </>;
}
