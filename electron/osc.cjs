'use strict';

// Shell integration uses a per-session nonce. Ordinary terminal OSC sequences
// pass through unchanged, including OSC 8 hyperlinks and terminal titles.
class PromptParser {
  constructor(nonce, onPrompt, onCommand = () => {}, onNavigation = () => {}) {
    this.prefix = `\x1b]777;Mullion;${nonce};`;
    this.onPrompt = onPrompt;
    this.onCommand = onCommand;
    this.onNavigation = onNavigation;
    this.pending = '';
  }

  feed(chunk) {
    let input = this.pending + chunk;
    this.pending = '';
    let output = '';
    while (input) {
      const start = input.indexOf(this.prefix);
      if (start < 0) {
        let suffix = Math.min(input.length, this.prefix.length - 1);
        while (suffix && !this.prefix.startsWith(input.slice(-suffix))) suffix--;
        output += suffix ? input.slice(0, -suffix) : input;
        this.pending = suffix ? input.slice(-suffix) : '';
        break;
      }
      output += input.slice(0, start);
      input = input.slice(start);
      const bell = input.indexOf('\x07', this.prefix.length);
      const st = input.indexOf('\x1b\\', this.prefix.length);
      const end = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st);
      if (end < 0) {
        if (input.length <= 65536) this.pending = input;
        else output += input; // Malformed output must not grow the buffer forever.
        break;
      }
      const payload = input.slice(this.prefix.length, end).split(';');
      if (payload[0] === 'busy') this.onPrompt({ ready: false });
      if (payload[0] === 'command') {
        const command = decodeBase64(payload[1]);
        if (command !== null && command.trim() && command.length <= 8192 && !/[\0\r\n\x1b]/.test(command)) this.onCommand(command);
      }
      if (payload[0] === 'ready') {
        const cwd = decodeBase64(payload[1]);
        const path = decodeBase64(payload[2]);
        if (cwd !== null && !cwd.includes('\0')) this.onPrompt({ ready: true, cwd, path, ...(payload[3] === '1' || payload[3] === '0' ? { navigation: payload[3] === '1' } : {}) });
      }
      if (payload[0] === 'navigate' && /^[a-f0-9-]{36}$/.test(payload[1] || '') && ['0', '1'].includes(payload[2])) {
        const cwd = decodeBase64(payload[3]);
        if (cwd !== null && !cwd.includes('\0')) this.onNavigation({ requestId: payload[1], success: payload[2] === '1', cwd });
      }
      input = input.slice(end + (end === st ? 2 : 1));
    }
    return output;
  }

  flush() {
    const remaining = this.pending;
    this.pending = '';
    return remaining;
  }
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const buffer = Buffer.from(value, 'base64');
  const text = buffer.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buffer) ? text : null;
}

module.exports = { PromptParser, decodeBase64 };
