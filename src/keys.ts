// Pure keyboard decisions for the terminal, kept free of xterm/DOM so they can be tested.

export type KeyAction = 'copy' | 'paste' | 'clear' | 'save' | 'swallow';
export interface KeyInput { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; }
export interface KeyContext {
  hasSelection: boolean;
  // True while a full-screen program (nano, vim, less, ...) owns the alternate screen.
  alternateScreen: boolean;
  // 'nano' or 'vim' while that editor is the foreground program, else null.
  editor: 'nano' | 'vim' | null;
}

/**
 * Clipboard and app shortcuts. Cmd and Ctrl behave alike on every platform so
 * that Ctrl+C/Ctrl+V work on macOS too, but plain Ctrl chords stay with the
 * shell whenever the terminal has its own meaning for them:
 * - Cmd/Ctrl+C copies only with a selection; otherwise Ctrl+C remains SIGINT.
 * - Cmd+V always pastes. Ctrl+V pastes at the shell, but full-screen programs
 *   receive it unchanged (nano: next page, vim: visual block).
 * - Ctrl+Shift+C / Ctrl+Shift+V always copy / paste.
 * - Cmd/Ctrl+S saves only while nano/pico or vim runs (Ctrl+S is XOFF elsewhere).
 * Returns null when xterm should handle the key normally.
 */
export function shortcutAction(event: KeyInput, context: KeyContext): KeyAction | null {
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  const command = event.metaKey && !event.ctrlKey;
  const control = event.ctrlKey && !event.metaKey;
  if (!command && !control) return null;
  if (key === 'c') {
    if (context.hasSelection && (command || control)) return 'copy';
    // Ctrl+Shift+C without a selection must not reach the shell as Ctrl+C.
    return control && event.shiftKey ? 'swallow' : null;
  }
  if (key === 'v') {
    if (command || event.shiftKey) return 'paste';
    return context.alternateScreen ? null : 'paste';
  }
  if (key === 'k' && (command || event.shiftKey)) return 'clear';
  if (key === 's' && !event.shiftKey && context.editor) return 'save';
  return null;
}

/**
 * New Window: Cmd+N on macOS, Ctrl+Shift+N elsewhere (like the other app
 * shortcuts), plus plain Ctrl+N on every platform. Plain Ctrl+N is "next
 * line" in nano/vim, so it passes through while a full-screen program owns
 * the alternate screen; at the shell prompt it is taken over (readline/ZLE's
 * "next history" is still on the Down arrow).
 */
export function isNewWindowShortcut(event: KeyInput, context: { platform?: string; alternateScreen: boolean }): boolean {
  if (event.altKey || event.key.toLowerCase() !== 'n') return false;
  if (context.platform === 'darwin' && event.metaKey && !event.ctrlKey && !event.shiftKey) return true;
  if (context.platform !== 'darwin' && event.ctrlKey && event.shiftKey && !event.metaKey) return true;
  return event.ctrlKey && !event.metaKey && !event.shiftKey && !context.alternateScreen;
}
