// Pure tokenizer for rendering command text with distinct colors for the command name, flags
// and quoted strings. Not used for parsing/execution — just a left-to-right scan good enough
// for realistic CLI invocations (git-style, npm/docker/etc). Segments always reconstruct the
// original string exactly via `segments.map(s => s.text).join('')`.
export type CommandSegmentKind = 'command' | 'flag' | 'arg' | 'string';
export interface CommandSegment { text: string; kind: CommandSegmentKind; }

export function tokenizeCommand(value: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  const n = value.length;
  let i = 0;
  let sawCommand = false;
  while (i < n) {
    const ch = value[i];
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < n && /\s/.test(value[j])) j++;
      segments.push({ text: value.slice(i, j), kind: 'arg' });
      i = j;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && value[j] !== ch) j++;
      j = j < n ? j + 1 : j;
      segments.push({ text: value.slice(i, j), kind: 'string' });
      sawCommand = true;
      i = j;
    } else {
      let j = i + 1;
      while (j < n && !/\s/.test(value[j])) j++;
      const text = value.slice(i, j);
      if (!sawCommand) { segments.push({ text, kind: 'command' }); sawCommand = true; }
      else segments.push({ text, kind: text.startsWith('-') ? 'flag' : 'arg' });
      i = j;
    }
  }
  return segments;
}
