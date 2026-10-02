import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyImageSource, classifyLink, headingSlug, isMarkdownPath, parentDirectory, parseMarkdown, renderMarkdownToSafeHtml, resolveDocumentPath, SANITIZE_CONFIG } from '../src/markdown';

test('isMarkdownPath matches .md, .markdown and .mdx case-insensitively', () => {
  for (const path of ['/work/README.md', '/work/notes.MARKDOWN', '/work/page.mdx', 'C:\\docs\\Guide.Md']) assert.equal(isMarkdownPath(path), true, path);
  for (const path of ['/work/notes.txt', '/work/md', '/work/README.md.bak', '/work/.md/file', '/work/markdown']) assert.equal(isMarkdownPath(path), false, path);
});

test('parentDirectory keeps POSIX and Windows separators', () => {
  assert.equal(parentDirectory('/work/app/README.md'), '/work/app');
  assert.equal(parentDirectory('/README.md'), '/');
  assert.equal(parentDirectory('C:\\docs\\README.md'), 'C:\\docs');
  assert.equal(parentDirectory('C:\\README.md'), 'C:\\');
});

test('resolveDocumentPath resolves relative references and never climbs above the root', () => {
  assert.equal(resolveDocumentPath('/work/app/docs', 'guide.md'), '/work/app/docs/guide.md');
  assert.equal(resolveDocumentPath('/work/app/docs', './img/../logo.png'), '/work/app/docs/logo.png');
  assert.equal(resolveDocumentPath('/work/app/docs', '../../README.md'), '/work/README.md');
  assert.equal(resolveDocumentPath('/work', '../../../../etc/hosts'), '/etc/hosts');
  assert.equal(resolveDocumentPath('/work', '/abs/file.md'), '/abs/file.md');
  assert.equal(resolveDocumentPath('C:\\docs', 'img/a.png'), 'C:\\docs\\img\\a.png');
  assert.equal(resolveDocumentPath('C:\\docs', '..\\..\\x.md'), 'C:\\x.md');
  assert.equal(resolveDocumentPath('\\\\server\\share', 'a.md'), '\\\\server\\share\\a.md');
});

test('classifyLink sends only http(s) and mailto outside the app', () => {
  assert.deepEqual(classifyLink('https://example.com/a?b=1', '/w'), { kind: 'external', url: 'https://example.com/a?b=1' });
  assert.deepEqual(classifyLink('http://example.com', '/w'), { kind: 'external', url: 'http://example.com/' });
  assert.deepEqual(classifyLink('mailto:someone@example.com', '/w'), { kind: 'external', url: 'mailto:someone@example.com' });
  for (const href of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'vbscript:x', '//evil.example/x', 'ftp://example.com', '', null, undefined]) {
    assert.deepEqual(classifyLink(href, '/w'), { kind: 'blocked' }, String(href));
  }
});

test('classifyLink resolves relative Markdown links against the document folder', () => {
  assert.deepEqual(classifyLink('#install', '/w/docs'), { kind: 'anchor', fragment: 'install' });
  assert.deepEqual(classifyLink('guide.md', '/w/docs'), { kind: 'markdown', path: '/w/docs/guide.md', fragment: '' });
  assert.deepEqual(classifyLink('../README.md#usage', '/w/docs'), { kind: 'markdown', path: '/w/README.md', fragment: 'usage' });
  assert.deepEqual(classifyLink('My%20Notes.markdown', '/w'), { kind: 'markdown', path: '/w/My Notes.markdown', fragment: '' });
  assert.deepEqual(classifyLink('scripts/run.sh', '/w'), { kind: 'file', path: '/w/scripts/run.sh' });
  assert.deepEqual(classifyLink('C:\\docs\\a.md', 'D:\\x'), { kind: 'markdown', path: 'C:\\docs\\a.md', fragment: '' });
});

test('classifyImageSource never hands a local path to the DOM', () => {
  assert.deepEqual(classifyImageSource('img/logo.png', '/w/docs'), { kind: 'local', path: '/w/docs/img/logo.png' });
  assert.deepEqual(classifyImageSource('../shot.png?raw=1', '/w/docs'), { kind: 'local', path: '/w/shot.png' });
  assert.deepEqual(classifyImageSource('https://example.com/a.png', '/w'), { kind: 'remote', url: 'https://example.com/a.png' });
  assert.deepEqual(classifyImageSource('data:image/png;base64,AAAA', '/w'), { kind: 'inline' });
  for (const src of ['file:///etc/passwd', 'data:text/html,<script>', 'javascript:alert(1)', '//cdn.example/x.png', '']) {
    assert.deepEqual(classifyImageSource(src, '/w'), { kind: 'blocked' }, src);
  }
});

test('headingSlug follows GitHub-style anchors', () => {
  assert.equal(headingSlug('Getting Started'), 'getting-started');
  assert.equal(headingSlug('Suggestions & auto-complete'), 'suggestions--auto-complete');
  assert.equal(headingSlug('  Where data is stored? '), 'where-data-is-stored');
});

test('parseMarkdown renders GFM headings, lists, tables, code and quotes', () => {
  const html = parseMarkdown('# Title\n\nSome `code` here.\n\n- one\n  - nested\n1. first\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n> quoted\n\n- [x] done\n');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul>\s*<li>one\s*<ul>\s*<li>nested<\/li>/);
  assert.match(html, /<ol>\s*<li>first<\/li>/);
  assert.match(html, /<table>[\s\S]*<th>a<\/th>[\s\S]*<td>2<\/td>/);
  assert.match(html, /<pre><code class="language-js">const x = 1;/);
  assert.match(html, /<blockquote>\s*<p>quoted<\/p>/);
  assert.match(html, /<input checked="" disabled="" type="checkbox">/);
});

test('renderMarkdownToSafeHtml refuses to return unsanitized HTML without a DOM sanitizer', () => {
  // Node has no DOM, so DOMPurify reports itself unsupported here; the helper must fail closed.
  assert.throws(() => renderMarkdownToSafeHtml('<script>alert(1)</script>', { baseDirectory: '/w' }), /sanitizer/);
});

test('renderMarkdownToSafeHtml sanitizes the parsed HTML with the strict config', () => {
  const calls: { html: string; config: unknown }[] = [];
  const hooks: string[] = [];
  const purify = {
    isSupported: true,
    sanitize(html: string, config: unknown) { calls.push({ html, config }); return '<h1>safe</h1>'; },
    addHook(entryPoint: string) { hooks.push(`add:${entryPoint}`); },
    removeHook(entryPoint: string) { hooks.push(`remove:${entryPoint}`); },
  };
  const output = renderMarkdownToSafeHtml('# Hi\n\n<script>alert(1)</script>', { baseDirectory: '/w', purify });
  assert.equal(output, '<h1>safe</h1>');
  assert.equal(calls.length, 1);
  assert.match(calls[0].html, /<script>alert\(1\)<\/script>/, 'raw HTML must reach the sanitizer, not bypass it');
  assert.deepEqual(calls[0].config, { ...SANITIZE_CONFIG, RETURN_TRUSTED_TYPE: false });
  assert.deepEqual(hooks, ['add:afterSanitizeAttributes', 'remove:afterSanitizeAttributes']);
  for (const tag of ['style', 'iframe', 'form', 'object', 'embed']) assert.ok(SANITIZE_CONFIG.FORBID_TAGS.includes(tag), tag);
  for (const attribute of ['style', 'class', 'id', 'srcset', 'target']) assert.ok(SANITIZE_CONFIG.FORBID_ATTR.includes(attribute), attribute);
});
