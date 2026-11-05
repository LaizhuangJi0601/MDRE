// 文件格式模块：@codemirror/legacy-modes 未提供、但常见文件类型需要的两个轻量流式解析器。
// 只做单行词法着色（与 legacy modes 的 StreamLanguage 契约一致），不引入任何依赖。
import type { StreamLanguage } from '@codemirror/language';

/** 与 CodeMirror `StreamLanguage.define` 参数兼容的解析器类型。 */
type LegacyStreamParser = Parameters<typeof StreamLanguage.define>[0];

// ── Windows 批处理（.bat / .cmd）─────────────────────────────────────────
const batchKeywords = new Set([
  'if', 'else', 'exist', 'not', 'errorlevel', 'defined', 'goto', 'call', 'set', 'setlocal', 'endlocal',
  'echo', 'echo.', 'exit', 'for', 'in', 'do', 'rem', 'shift', 'cd', 'chdir', 'pushd', 'popd', 'dir',
  'copy', 'xcopy', 'robocopy', 'move', 'ren', 'rename', 'del', 'erase', 'mkdir', 'md', 'rmdir', 'rd',
  'start', 'title', 'cls', 'pause', 'type', 'find', 'findstr', 'more', 'timeout', 'choice', 'attrib',
  'equ', 'neq', 'lss', 'leq', 'gtr', 'geq', 'ver', 'vol', 'path', 'prompt', 'color', 'mode', 'assoc',
  'ftype', 'reg', 'sc', 'net', 'taskkill', 'tasklist', 'wmic', 'where', 'whoami', 'powershell',
]);

export const batchParser: LegacyStreamParser = {
  name: 'batch',
  startState: () => ({}),
  token(stream) {
    if (stream.sol()) {
      // REM 与 :: 两种注释；REM 不区分大小写，且允许 @echo off 这类前缀写法。
      if (stream.match(/^\s*@?rem(?:\s|$)/i)) { stream.skipToEnd(); return 'comment'; }
      if (stream.match(/^\s*::/)) { stream.skipToEnd(); return 'comment'; }
      const label = /^\s*:[A-Za-z0-9_.$-]+/.exec(stream.string.slice(stream.pos));
      if (label) { stream.pos += label[0].length; return 'labelName'; }
    }
    if (stream.eatSpace()) return null;
    const ch = stream.next() ?? '';
    if (!ch) return null;
    if (ch === '"') {
      while (!stream.eol()) if (stream.next() === '"') break;
      return 'string';
    }
    if (ch === '%' || ch === '!') {
      // %VAR% / %1 / %~dp0 / !VAR!（延迟展开）
      stream.eatWhile(ch === '%' ? /[^%\s]/ : /[^!\s]/);
      stream.eat(ch);
      return 'variableName';
    }
    if (ch === '^') return 'operator';
    if (ch === '@') return 'meta';
    if ('<>=&|+*/~'.includes(ch)) { stream.eatWhile(/[<>=&|+*/~]/); return 'operator'; }
    if (/\d/.test(ch)) { stream.eatWhile(/[\d.]/); return 'number'; }
    if (/[A-Za-z_]/.test(ch)) {
      stream.eatWhile(/[\w.-]/);
      return batchKeywords.has(stream.current().toLowerCase()) ? 'keyword' : null;
    }
    return null;
  },
};

// ── Makefile（Makefile / *.mk / *.make）──────────────────────────────────
const makeDirectives = new Set([
  'include', '-include', 'sinclude', 'define', 'endef', 'ifeq', 'ifneq', 'ifdef', 'ifndef',
  'else', 'endif', 'export', 'unexport', 'override', 'vpath', 'private', 'undefine',
]);

export const makefileParser: LegacyStreamParser = {
  name: 'makefile',
  startState: () => ({}),
  token(stream) {
    if (stream.sol()) {
      if (stream.match(/^\s*#/)) { stream.skipToEnd(); return 'comment'; }
      // 规则/变量定义行首：目标或变量名（配方行以制表符开头，保持默认样式）。
      if (!stream.match(/^\t/)) {
        const definition = /^[^\s:#=][^:=]*?(?=\s*(?::=|::=|:|\+=|\?=|!=|=))/.exec(stream.string.slice(stream.pos));
        if (definition && definition[0].trim()) { stream.pos += definition[0].length; return 'variableName.definition'; }
      }
    }
    if (stream.eatSpace()) return null;
    const ch = stream.next() ?? '';
    if (!ch) return null;
    if (ch === '#') { stream.skipToEnd(); return 'comment'; }
    if (ch === '$') {
      if (stream.peek() === '(' || stream.peek() === '{') {
        const open = stream.next()!;
        const close = open === '(' ? ')' : '}';
        let depth = 1;
        while (!stream.eol() && depth > 0) {
          const next = stream.next();
          if (next === open) depth++;
          else if (next === close) depth--;
        }
        return 'variableName';
      }
      stream.eatWhile(/[\w@%<?^*+]/);
      return 'variableName';
    }
    if (ch === '=' || ch === ':') {
      stream.eat('=');
      return 'operator';
    }
    if (ch === '?' || ch === '+' || ch === '!') { if (stream.eat('=')) return 'operator'; return null; }
    if (ch === '\\' && stream.eol()) { stream.skipToEnd(); return 'meta'; }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      while (!stream.eol()) if (stream.next() === quote) break;
      return 'string';
    }
    if (/\d/.test(ch)) { stream.eatWhile(/[\d.]/); return 'number'; }
    if (/[A-Za-z_.]/.test(ch)) {
      stream.eatWhile(/[\w.\-/]/);
      return makeDirectives.has(stream.current().toLowerCase()) ? 'keyword' : null;
    }
    return null;
  },
};
