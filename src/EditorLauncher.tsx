import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ProjectEditors, SessionInfo } from './types';
import { editorIcon, fallbackEditorIcon } from './editor-icons';

interface Props { session: SessionInfo; onError(error: unknown): void; }

export default function EditorLauncher({ session, onError }: Props) {
  const [project, setProject] = useState<ProjectEditors | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState('');
  const errorHandler = useRef(onError);
  const previousRefresh = useRef(refresh);
  errorHandler.current = onError;

  useEffect(() => {
    let cancelled = false;
    if (!session.alive || !window.terminalAPI) { setLoading(false); return; }
    const forceRefresh = previousRefresh.current !== refresh;
    previousRefresh.current = refresh;
    setLoading(true);
    // Keep the previous icons while scanning a newly selected directory.
    window.terminalAPI.projectEditors(session.id, forceRefresh).then(value => {
      if (!cancelled) setProject(value);
    }).catch(error => { if (!cancelled) errorHandler.current(error); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [session.id, session.cwd, session.alive, refresh]);

  async function open(editorId: string) {
    if (loading || !session.alive) return;
    setOpening(editorId);
    try { await window.terminalAPI!.openEditor(session.id, editorId); }
    catch (error) { onError(error); }
    finally { setOpening(''); }
  }

  const visible = session.alive && Boolean(project?.languages.length && project.editors.length);
  return <div className="editor-launcher" aria-label="Project editors" aria-busy={loading}>
    {visible && <>
      <div className="editor-buttons">{project!.editors.map(editor =>
        <button className={`editor-button${opening === editor.id ? ' opening' : ''}`} key={editor.id} disabled={loading || Boolean(opening)} aria-busy={opening === editor.id} aria-label={`Open current folder in ${editor.name}`} title={`Open ${session.cwd} in ${editor.name}`} onClick={() => void open(editor.id)}>
          <img className="editor-app-icon" src={editorIcon(editor.icon, editor.id)} alt="" draggable={false} onError={event => {
            const fallback = fallbackEditorIcon(editor.id);
            if (event.currentTarget.src !== fallback) event.currentTarget.src = fallback;
          }} />
        </button>
      )}</div>
      <button className={`icon-button editor-refresh${loading ? ' loading' : ''}`} aria-label="Refresh installed editors" title="Refresh installed editors" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13} /></button>
    </>}
  </div>;
}
