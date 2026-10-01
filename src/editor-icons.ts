/** Small branded fallbacks used only when an installed app's native icon fails. */
const marks: Record<string, string> = {
  vscode: '<path fill="#23a9f2" d="m22 3 7 4v18l-7 4-15-12-4 3-3-2 7-6 15 12V8L7 20l-7-2 3-2 4 3Z"/>',
  cursor: '<path fill="#f3f4f6" d="m16 2 13 8v14l-13 8-13-8V10Z"/><path fill="#8b929b" d="m3 10 13 8 13-8-13 22-13-8Z"/><path fill="#252b34" d="m16 2 13 8-13 8Z"/>',
  antigravity: '<path fill="#7e72ed" d="M2 25 12 7l4 7-6 11Z"/><path fill="#68aaf0" d="m12 7 4-6 14 24h-8Z"/><path fill="#ec836e" d="m10 25 6-11 6 11Z"/>',
  vscodium: '<path fill="#3094d4" d="M2 8h28v18H2Z"/><path fill="none" stroke="#fff" stroke-width="2.3" d="m9 13-4 4 4 4m14-8 4 4-4 4m-7-10-3 12"/>',
  zed: '<rect x="2" y="2" width="28" height="28" rx="6" fill="#e8edf0"/><path fill="none" stroke="#27313a" stroke-width="3" d="M8 9h16L8 23h16M7 16h18"/>',
  sublime: '<rect x="2" y="2" width="28" height="28" rx="6" fill="#363636"/><path fill="#ff9800" d="m8 9 17-5v7l-17 5Zm0 7 17 5v7l-17-5Zm0 7 17-5v7l-17 5Z"/>',
  xcode: '<rect x="2" y="2" width="28" height="28" rx="6" fill="#339de5"/><path fill="none" stroke="#bde9ff" stroke-width="1" d="M6 9h20M6 15h20M6 21h20M10 5v22M18 5v22M25 5v22"/><path fill="#e1e8ef" d="m12 4 9 5-3 5-3-2-9 16-4-2 9-16-3-2Z"/>',
  'android-studio': '<circle cx="16" cy="16" r="14" fill="#3bc284"/><path fill="#e7eff1" d="m16 5 9 21h-5l-4-11-4 11H7Z"/><path fill="#153d3d" d="M11 21h10v3H11Z"/>',
  'visual-studio': '<path fill="#ab73e0" d="m24 2 7 3v24l-7 3-14-10-6 4-4-2V10l4-2 6 4Zm0 8-14 7 14 7ZM4 12v10l5-5Z"/>',
};

const jetbrains: Record<string, { color: string; mark: string }> = {
  pycharm: { color: '#62d793', mark: 'PY' }, webstorm: { color: '#00c8ef', mark: 'WS' },
  phpstorm: { color: '#ba62ef', mark: 'PS' }, intellij: { color: '#f36c7c', mark: 'IJ' },
  rider: { color: '#ef6598', mark: 'RD' }, clion: { color: '#37d8bf', mark: 'CL' },
  goland: { color: '#35d0d3', mark: 'GO' }, rustrover: { color: '#f29747', mark: 'RR' },
};
// Product monograms are part of JetBrains' app icon identity, drawn as vectors.
const letters: Record<string, string> = {
  P: 'M0 10V0h5v5H0', Y: 'M0 0v4l3 2 3-2V0M3 6v4', W: 'M0 0v10l3-4 3 4V0',
  S: 'M6 0H0v5h6v5H0', I: 'M0 0h6M3 0v10M0 10h6', J: 'M0 0h6v10H0V7',
  R: 'M0 10V0h6v5H0m3 0 3 5', D: 'M0 0h3l3 2v6l-3 2H0Z', C: 'M6 0H0v10h6',
  L: 'M0 0v10h6', G: 'M6 0H0v10h6V5H3', O: 'M0 0h6v10H0Z',
};
const cache = new Map<string, string>();

export function fallbackEditorIcon(id: string): string {
  const cached = cache.get(id);
  if (cached) return cached;
  const product = jetbrains[id];
  const mark = product
    ? `<rect x="1" y="1" width="30" height="30" rx="6" fill="${product.color}"/><path fill="#1e2028" d="M6 6h22v22H6Z"/><g stroke="#fff" fill="none" stroke-width="1.5" stroke-linejoin="miter">${[...product.mark].map((letter, index) => `<path transform="translate(${9 + index * 9} 9)" d="${letters[letter]}"/>`).join('')}<path d="M9 24h8"/></g>`
    : marks[id] ?? '<rect x="2" y="2" width="28" height="28" rx="6" fill="#444b58"/><path fill="none" stroke="#fff" stroke-width="2" d="m11 10-6 6 6 6m10-12 6 6-6 6m-3-14-4 16"/>';
  const icon = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${mark}</svg>`)}`;
  cache.set(id, icon);
  return icon;
}

export function editorIcon(icon: string | undefined, id: string): string {
  return icon?.startsWith('data:image/') ? icon : fallbackEditorIcon(id);
}
