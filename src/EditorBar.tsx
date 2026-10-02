import { LogOut, Save, X } from 'lucide-react';

interface Props {
  kind: 'nano' | 'vim';
  platform: string; bottom: number;
  onSave(): void; onSaveAndExit(): void; onExit(): void;
}

// Floating actions while nano/pico or vim runs. Buttons never take focus so
// the keyboard stays with the editor.
export default function EditorBar({ kind, platform, bottom, onSave, onSaveAndExit, onExit }: Props) {
  const save = platform === 'darwin' ? '⌘S' : 'Ctrl+S';
  const keep = (action: () => void) => ({
    onMouseDown: (event: { preventDefault(): void }) => event.preventDefault(),
    onClick: action,
  });
  if (kind === 'vim') {
    return <div className="editor-bar" style={{ bottom }} role="toolbar" aria-label="Editor actions">
      <button className="primary" title={`Save and close (:wq) — ${save} saves without closing`} {...keep(onSaveAndExit)}><LogOut size={12} />Save &amp; Close</button>
      <button title="Close without saving (:qa!)" {...keep(onExit)}><X size={12} />Close</button>
    </div>;
  }
  return <div className="editor-bar" style={{ bottom }} role="toolbar" aria-label="Editor actions">
    <button className="primary" title={`Save (${save})`} {...keep(onSave)}><Save size={12} />Save</button>
    <button title="Save and exit" {...keep(onSaveAndExit)}><LogOut size={12} />Save &amp; Exit</button>
    <button title="Exit (asks to save if there are changes)" {...keep(onExit)}><X size={12} />Exit</button>
  </div>;
}
