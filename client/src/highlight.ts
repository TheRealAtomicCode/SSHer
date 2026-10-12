// A deliberately small highlighter: comments, strings, numbers and keywords.
// It exists to make comments recede, not to be a full parser.

export type Lang = 'hash' | 'c' | 'css' | 'sql' | 'xml' | 'plain';

const HASH_LANGS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'py', 'rb', 'pl', 'r', 'yml', 'yaml', 'toml', 'ini', 'conf',
  'cfg', 'env', 'properties', 'gitignore', 'dockerfile', 'makefile', 'mk', 'cmake', 'tf',
]);
const C_LANGS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'java',
  'go', 'rs', 'php', 'swift', 'kt', 'scala', 'dart', 'json', 'json5', 'jsonc', 'proto',
]);
const XML_LANGS = new Set(['html', 'htm', 'xml', 'svg', 'md', 'markdown', 'xhtml', 'plist']);
const CSS_LANGS = new Set(['css', 'scss', 'sass', 'less']);
const SQL_LANGS = new Set(['sql', 'lua', 'hs', 'elm', 'ada']);

// Files that carry their language in the name rather than an extension.
const BY_NAME: Record<string, Lang> = {
  makefile: 'hash',
  dockerfile: 'hash',
  jenkinsfile: 'c',
  vagrantfile: 'hash',
  gemfile: 'hash',
  rakefile: 'hash',
  procfile: 'hash',
  crontab: 'hash',
  fstab: 'hash',
  hosts: 'hash',
  sudoers: 'hash',
  known_hosts: 'hash',
  authorized_keys: 'hash',
  sshd_config: 'hash',
  ssh_config: 'hash',
};

const KEYWORDS: Record<Lang, string[]> = {
  hash: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac',
    'function', 'return', 'export', 'local', 'source', 'echo', 'true', 'false', 'in',
    'def', 'class', 'import', 'from', 'try', 'except', 'with', 'as', 'pass', 'not', 'and',
    'or', 'None', 'True', 'False', 'FROM', 'RUN', 'CMD', 'COPY', 'ADD', 'ENV', 'WORKDIR',
    'EXPOSE', 'ENTRYPOINT'],
  c: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'switch',
    'case', 'break', 'continue', 'new', 'class', 'extends', 'import', 'export', 'default',
    'from', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof',
    'interface', 'type', 'enum', 'public', 'private', 'protected', 'static', 'void', 'int',
    'char', 'float', 'double', 'bool', 'struct', 'func', 'package', 'fn', 'let', 'mut',
    'impl', 'pub', 'use', 'true', 'false', 'null', 'undefined', 'this', 'self'],
  css: ['important', 'media', 'import', 'keyframes', 'supports', 'font-face', 'root'],
  sql: ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete',
    'create', 'table', 'drop', 'alter', 'join', 'left', 'right', 'inner', 'outer', 'on',
    'group', 'order', 'by', 'having', 'limit', 'and', 'or', 'not', 'null', 'as', 'distinct',
    'local', 'function', 'end', 'then', 'do', 'return', 'if', 'else', 'for', 'while'],
  xml: [],
  plain: [],
};

export function languageOf(filename: string): Lang {
  const name = filename.toLowerCase();
  const byName = BY_NAME[name];
  if (byName) return byName;

  const dot = name.lastIndexOf('.');
  // Dotfiles (.bashrc) have no extension but are almost always hash-commented.
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  if (!ext) return 'hash';

  if (HASH_LANGS.has(ext)) return 'hash';
  if (C_LANGS.has(ext)) return 'c';
  if (XML_LANGS.has(ext)) return 'xml';
  if (CSS_LANGS.has(ext)) return 'css';
  if (SQL_LANGS.has(ext)) return 'sql';
  return 'plain';
}

export const LANG_LABEL: Record<Lang, string> = {
  hash: '# comments',
  c: '// comments',
  css: '/* comments */',
  sql: '-- comments',
  xml: '<!-- comments -->',
  plain: 'plain text',
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STRINGS = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
const NUMBER = String.raw`\b\d+(?:\.\d+)?\b`;

function patternFor(lang: Lang): RegExp | null {
  switch (lang) {
    case 'hash':
      return new RegExp(`(#[^\\n]*)|(${STRINGS})|(${NUMBER})`, 'g');
    case 'c':
      return new RegExp(
        `(/\\*[\\s\\S]*?\\*/|//[^\\n]*)|(${STRINGS}|\`(?:\\\\.|[^\`\\\\])*\`)|(${NUMBER})`,
        'g',
      );
    case 'css':
      return new RegExp(`(/\\*[\\s\\S]*?\\*/)|(${STRINGS})|(${NUMBER})`, 'g');
    case 'sql':
      return new RegExp(`(--[^\\n]*|/\\*[\\s\\S]*?\\*/)|(${STRINGS})|(${NUMBER})`, 'g');
    case 'xml':
      return new RegExp(`(<!--[\\s\\S]*?-->)|(${STRINGS})|(${NUMBER})`, 'g');
    default:
      return null;
  }
}

const COMMENT_CLASS = 'text-slate-600 italic';
const STRING_CLASS = 'text-amber-300';
const NUMBER_CLASS = 'text-sky-300';
const KEYWORD_CLASS = 'text-fuchsia-400';

/** Highlights keywords in a run of ordinary (non-comment, non-string) code. */
function highlightWords(text: string, lang: Lang): string {
  const words = KEYWORDS[lang];
  if (!words.length) return escapeHtml(text);

  const pattern = new RegExp(`\\b(${words.join('|')})\\b`, 'g');
  let out = '';
  let last = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    out += escapeHtml(text.slice(last, m.index));
    out += `<span class="${KEYWORD_CLASS}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

/** Returns HTML. Every branch escapes, so file contents can never inject markup. */
export function highlight(code: string, lang: Lang): string {
  const pattern = patternFor(lang);
  if (!pattern) return escapeHtml(code);

  let out = '';
  let last = 0;
  for (let m = pattern.exec(code); m; m = pattern.exec(code)) {
    out += highlightWords(code.slice(last, m.index), lang);
    const [text, comment, string] = m;
    const cls = comment ? COMMENT_CLASS : string ? STRING_CLASS : NUMBER_CLASS;
    out += `<span class="${cls}">${escapeHtml(text)}</span>`;
    last = m.index + text.length;
  }
  out += highlightWords(code.slice(last), lang);

  // A trailing newline needs a character after it or the last line collapses.
  return `${out}\n`;
}
