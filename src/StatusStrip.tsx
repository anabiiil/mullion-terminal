import { useCallback, useEffect, useRef, useState } from 'react';
import { FileDiff } from 'lucide-react';
import type { GitStatus, SessionInfo } from './types';

interface Props {
  session: SessionInfo;
}

// The branch itself is no longer shown here — it lives right in the prompt (`git:(main)`,
// see electron/shell.cjs and ShellPane's link provider) with a click there opening the
// branch-switch dropdown (BranchMenu). This strip now holds only the changed-files count, and
// disappears entirely outside a git repository or when the working tree is clean.
export default function StatusStrip({ session }: Props) {
  const [statusById, setStatusById] = useState<Record<string, GitStatus | null>>({});
  const revisions = useRef<Record<string, number>>({});
  const current = Object.prototype.hasOwnProperty.call(statusById, session.id) ? statusById[session.id] : undefined;

  const fetchStatus = useCallback((id: string) => {
    if (!window.terminalAPI) return;
    const revision = (revisions.current[id] = (revisions.current[id] ?? 0) + 1);
    window.terminalAPI.gitStatus(id).then(value => {
      if (revisions.current[id] !== revision) return; // A newer request for this session already started.
      setStatusById(previous => ({ ...previous, [id]: value }));
    }).catch(() => { /* Best-effort: keep the last known status rather than show an error toast. */ });
  }, []);

  // Refresh on a cwd change or once the shell becomes ready again (a command finished) — never
  // while one is still running, so the chip holds its last value instead of flickering blank.
  useEffect(() => {
    if (!session.alive || !session.ready) return;
    const timer = setTimeout(() => fetchStatus(session.id), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.ready, session.cwd, fetchStatus]);
  useEffect(() => {
    function onFocus() { if (session.ready && session.alive) fetchStatus(session.id); }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [session.id, session.ready, session.alive, fetchStatus]);

  const hasChanges = Boolean(current && current.changedFiles > 0);
  if (!hasChanges || !current) return null;

  return <div className="status-strip">
    <span className="status-chip changes" title={`${current.changedFiles} changed file${current.changedFiles === 1 ? '' : 's'}`}>
      <FileDiff size={11} /><span>{current.changedFiles} • <b className="diff-add">+{current.insertions}</b> <b className="diff-remove">-{current.deletions}</b></span>
    </span>
  </div>;
}
