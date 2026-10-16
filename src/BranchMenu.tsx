import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Search } from 'lucide-react';
import type { GitBranches } from './types';
import { switchBranchCommand } from './git-command';

type BranchItem = { type: 'local' | 'remote'; name: string; upstream?: string; lastCommitRelative?: string };

interface Props {
  sessionId: string;
  platform?: string;
  /** Viewport coordinates of the click that opened the menu (e.g. the branch name in the prompt). */
  anchor: { x: number; y: number };
  onError(error: unknown): void;
  /** `handles.current.get(sessionId)?.run`, so switching uses the same real-shell path a tree double-click uses. */
  runInShell(command: string, options?: { record?: boolean }): boolean;
  onClose(): void;
}

/**
 * The branch-switch dropdown: a filterable list of local/remote branches (current branch
 * checked, most recently committed first) anchored at an arbitrary screen point rather than a
 * fixed chip, so it can open from a click anywhere — the clickable branch name in the terminal's
 * own prompt line (see ShellPane's link provider) as well as any future caller.
 */
export default function BranchMenu({ sessionId, platform, anchor, onError, runInShell, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<GitBranches | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(0);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    filterInputRef.current?.focus();
    window.terminalAPI?.gitBranches(sessionId, true).then(value => { setData(value); setLoading(false); })
      .catch(() => { setError('Could not load branches.'); setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    function onDown(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest('.branch-menu')) onClose();
    }
    function onKeyEsc(event: globalThis.KeyboardEvent) { if (event.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKeyEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKeyEsc); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = useCallback((item: BranchItem) => {
    const command = switchBranchCommand(item.name, { remote: item.type === 'remote', platform });
    onClose();
    if (!runInShell(command, { record: false })) onError(new Error('Wait for the current command to finish'));
  }, [platform, onClose, runInShell, onError]);

  const filterLower = filter.toLowerCase();
  const localItems: BranchItem[] = (data?.local ?? [])
    .filter(branch => branch.name.toLowerCase().includes(filterLower))
    .map(branch => ({ type: 'local', name: branch.name, upstream: branch.upstream, lastCommitRelative: branch.lastCommitRelative }));
  const remoteItems: BranchItem[] = (data?.remote ?? [])
    .filter(branch => branch.name.toLowerCase().includes(filterLower))
    .map(branch => ({ type: 'remote', name: branch.name }));
  const flattened = [...localItems, ...remoteItems];

  function onFilterKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key === 'Enter') { event.preventDefault(); const item = flattened[selected]; if (item) pick(item); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!flattened.length) return;
      setSelected(previous => (previous + (event.key === 'ArrowDown' ? 1 : -1) + flattened.length) % flattened.length);
    }
  }

  // Anchored at the click point: opens to the right and below, clamped so it never runs off
  // the window (the terminal can be clicked anywhere, unlike the old right-edge chip).
  const width = 230;
  const left = Math.min(Math.max(8, anchor.x), window.innerWidth - width - 8);
  const top = Math.min(anchor.y + 6, window.innerHeight - 40);

  function branchRow(item: BranchItem, index: number) {
    const isCurrent = item.type === 'local' && item.name === data?.current;
    return <button key={`${item.type}:${item.name}`} role="menuitemradio" aria-checked={isCurrent}
      className={`branch-menu-item ${index === selected ? 'selected' : ''}`}
      onMouseEnter={() => setSelected(index)}
      onClick={() => pick(item)}>
      <span className="branch-menu-check">{isCurrent && <Check size={12} />}</span>
      <span className="branch-menu-name">{item.name}</span>
      {item.lastCommitRelative && <span className="branch-menu-detail">{item.lastCommitRelative}</span>}
    </button>;
  }

  return <div ref={menuRef} className="branch-menu" role="menu" aria-label="Switch branch" style={{ left, top }}>
    <div className="branch-menu-filter"><Search size={12} /><input ref={filterInputRef} aria-label="Filter branches" placeholder="Find a branch…"
      value={filter} onChange={event => { setFilter(event.target.value); setSelected(0); }} onKeyDown={onFilterKeyDown} /></div>
    <div className="branch-menu-list">
      {loading && <div className="branch-menu-empty">Loading…</div>}
      {!loading && error && <div className="branch-menu-empty">{error}</div>}
      {!loading && !error && !flattened.length && <div className="branch-menu-empty">No matching branches.</div>}
      {!loading && localItems.length > 0 && <div className="branch-menu-group">Local</div>}
      {localItems.map((item, index) => branchRow(item, index))}
      {!loading && remoteItems.length > 0 && <div className="branch-menu-group">Remote</div>}
      {remoteItems.map((item, index) => branchRow(item, localItems.length + index))}
    </div>
  </div>;
}
