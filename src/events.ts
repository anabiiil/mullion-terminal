import type { TerminalEvent } from './types';

// Subscribe before creating a PTY: its first prompt can arrive before React mounts.
const listeners = new Set<(event: TerminalEvent) => void>();
const pending = new Map<string, string[]>();
const sinks = new Map<string, (data: string) => void>();
const states = new Map<string, Extract<TerminalEvent, { type: 'state' }>['session']>();
let connected = false;
export function subscribe(callback: (event: TerminalEvent) => void) {
  if (!connected && window.terminalAPI) {
    connected = true;
    window.terminalAPI.onEvent(event => {
      if (event.type === 'state') states.set(event.session.id, event.session);
      if (event.type === 'data') {
        const sink = sinks.get(event.id);
        if (sink) sink(event.data);
        else {
          const chunks = pending.get(event.id) ?? [];
          chunks.push(event.data);
          // Bound the backlog during tab creation / teardown.
          if (chunks.length > 300) chunks.shift();
          pending.set(event.id, chunks);
        }
      }
      for (const listener of listeners) listener(event);
    });
  }
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}
export function latestSessionState(id: string) { return states.get(id); }
export function attachOutput(id: string, sink: (data: string) => void) {
  sinks.set(id, sink);
  for (const data of pending.get(id) ?? []) sink(data);
  pending.delete(id);
  return () => { sinks.delete(id); pending.delete(id); };
}
