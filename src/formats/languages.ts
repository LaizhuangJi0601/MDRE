// 文件格式模块：代码语言的扩展名/文件名映射表与按需加载器（MDRE 0.3.0）。
// 纯模块：只依赖已安装的 @codemirror/legacy-modes；不访问 Tauri/vscode API，也不 import 项目内其他文件。
// 所有解析器都通过动态 import 按需加载，未加载的语言不进入首屏包体。
import type { StreamLanguage } from '@codemirror/language';
import { batchParser, makefileParser } from './custom-modes';

/** 与 CodeMirror `StreamLanguage.define` 参数兼容的解析器类型（@codemirror/language 未直接导出该别名）。 */
export type LegacyStreamParser = Parameters<typeof StreamLanguage.define>[0];

export interface LanguageSpec {
  /** 稳定语言 id：`codeLanguageFor` 返回它，也作为 `CodeEditor` 的 `languageId`。 */
  id: string;
  /** 语言显示名（英文；宿主可自行映射为本地化文案）。 */
  label: string;
  /** 小写扩展名，不带前导点。 */
  extensions: string[];
  /** 精确文件名（小写匹配），用于 Dockerfile、Makefile 等无扩展名或通用扩展名的文件。 */
  filenames?: string[];
  /** 按需加载解析器；加载或解析失败时由调用方回退纯文本。 */
  load: () => Promise<LegacyStreamParser>;
}

// ── @codemirror/legacy-modes 中的解析器加载器 ──────────────────────────────
// 每个模块只在用到时才 import；同一模块被多个语言共用时由打包器去重为同一个异步分块。
async function clike(name: 'c' | 'cpp' | 'java' | 'csharp' | 'scala' | 'kotlin' | 'dart' | 'objectiveC' | 'objectiveCpp'): Promise<LegacyStreamParser> {
  const module = await import('@codemirror/legacy-modes/mode/clike');
  return module[name] as LegacyStreamParser;
}

/** PHP 没有对应的 legacy mode，用 clike 的关键字配置近似（任务允许的兜底方案）。 */
async function php(): Promise<LegacyStreamParser> {
  const { clike: clikeFactory } = await import('@codemirror/legacy-modes/mode/clike');
  return clikeFactory({
    name: 'php',
    keywords: {
      if: true, else: true, elseif: true, endif: true, while: true, endwhile: true, for: true, endfor: true,
      foreach: true, endforeach: true, switch: true, endswitch: true, case: true, default: true, break: true,
      continue: true, return: true, echo: true, print: true, function: true, class: true, interface: true,
      trait: true, extends: true, implements: true, namespace: true, use: true, new: true, clone: true,
      public: true, private: true, protected: true, static: true, abstract: true, final: true, const: true,
      global: true, var: true, as: true, instanceof: true, throw: true, try: true, catch: true, finally: true,
      include: true, include_once: true, require: true, require_once: true, yield: true, match: true,
      fn: true, declare: true, goto: true, isset: true, unset: true, empty: true, list: true, array: true,
    },
    types: { int: true, float: true, string: true, bool: true, array: true, object: true, callable: true, iterable: true, mixed: true, void: true, never: true, self: true, parent: true },
    blockKeywords: { if: true, else: true, elseif: true, while: true, for: true, foreach: true, switch: true, try: true, catch: true, finally: true, function: true, class: true, interface: true, trait: true, namespace: true },
    atoms: { true: true, false: true, null: true },
    multiLineStrings: true,
  });
}

async function javascript(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/javascript')).javascript; }
async function typescript(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/javascript')).typescript; }
async function json(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/javascript')).json; }
async function yaml(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/yaml')).yaml; }
async function python(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/python')).python; }
async function cython(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/python')).cython; }
async function octave(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/octave')).octave; }
async function r(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/r')).r; }
async function julia(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/julia')).julia; }
async function lua(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/lua')).lua; }
async function perl(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/perl')).perl; }
async function ruby(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/ruby')).ruby; }
async function go(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/go')).go; }
async function rust(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/rust')).rust; }
async function swift(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/swift')).swift; }
async function groovy(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/groovy')).groovy; }
async function shell(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/shell')).shell; }
async function powershell(): Promise<LegacyStreamParser> { const module = await import('@codemirror/legacy-modes/mode/powershell'); return module.powerShell; }
async function sql(): Promise<LegacyStreamParser> { const module = await import('@codemirror/legacy-modes/mode/sql'); return module.standardSQL; }
async function html(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/xml')).html; }
async function xml(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/xml')).xml; }
async function css(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/css')).css; }
async function scss(): Promise<LegacyStreamParser> { const module = await import('@codemirror/legacy-modes/mode/css'); return module.sCSS; }
async function less(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/css')).less; }
async function sass(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/sass')).sass; }
async function toml(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/toml')).toml; }
async function properties(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/properties')).properties; }
async function cmake(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/cmake')).cmake; }
async function dockerfile(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile; }
async function stex(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/stex')).stex; }
async function gas(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/gas')).gas; }
async function vhdl(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/vhdl')).vhdl; }
async function verilog(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/verilog')).verilog; }
async function vb(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/vb')).vb; }
async function vbscript(): Promise<LegacyStreamParser> { const module = await import('@codemirror/legacy-modes/mode/vbscript'); return module.vbScript; }
async function haskell(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/haskell')).haskell; }
async function clojure(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/clojure')).clojure; }
async function erlang(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/erlang')).erlang; }
async function ocaml(): Promise<LegacyStreamParser> { const module = await import('@codemirror/legacy-modes/mode/mllike'); return module.oCaml; }
async function fsharp(): Promise<LegacyStreamParser> { const module = await import('@codemirror/legacy-modes/mode/mllike'); return module.fSharp; }
async function tcl(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/tcl')).tcl; }
async function pascal(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/pascal')).pascal; }
async function lisp(): Promise<LegacyStreamParser> { const module = await import('@codemirror/legacy-modes/mode/commonlisp'); return module.commonLisp; }
async function coffeescript(): Promise<LegacyStreamParser> { const module = await import('@codemirror/legacy-modes/mode/coffeescript'); return module.coffeeScript; }
async function stylus(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/stylus')).stylus; }
async function crystal(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/crystal')).crystal; }
async function d(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/d')).d; }
async function elm(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/elm')).elm; }
async function fortran(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/fortran')).fortran; }
async function gherkin(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/gherkin')).gherkin; }
async function jinja2(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/jinja2')).jinja2; }
async function mathematica(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/mathematica')).mathematica; }
async function modelica(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/modelica')).modelica; }
async function nginx(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/nginx')).nginx; }
async function nsis(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/nsis')).nsis; }
async function pug(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/pug')).pug; }
async function puppet(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/puppet')).puppet; }
async function rpm(): Promise<LegacyStreamParser> { const module = await import('@codemirror/legacy-modes/mode/rpm'); return module.rpmSpec; }
async function scheme(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/scheme')).scheme; }
async function smalltalk(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/smalltalk')).smalltalk; }
async function sparql(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/sparql')).sparql; }
async function turtle(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/turtle')).turtle; }
async function wast(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/wast')).wast; }
async function webidl(): Promise<LegacyStreamParser> { const module = await import('@codemirror/legacy-modes/mode/webidl'); return module.webIDL; }
async function xquery(): Promise<LegacyStreamParser> { const module = await import('@codemirror/legacy-modes/mode/xquery'); return module.xQuery; }
async function diff(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/diff')).diff; }
async function http(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/http')).http; }
async function protobuf(): Promise<LegacyStreamParser> { return (await import('@codemirror/legacy-modes/mode/protobuf')).protobuf; }

// ── 映射表 ────────────────────────────────────────────────────────────────
// 顺序只决定 supportedCodeExtensions() 排序前的录入顺序；查询按小写扩展名/文件名进行，与顺序无关。
export const languageSpecs: readonly LanguageSpec[] = [
  { id: 'javascript', label: 'JavaScript', extensions: ['js', 'mjs', 'cjs', 'jsx'], load: javascript },
  { id: 'typescript', label: 'TypeScript', extensions: ['ts', 'tsx', 'mts', 'cts'], load: typescript },
  { id: 'json', label: 'JSON', extensions: ['json', 'jsonc', 'jsonl', 'ipynb', 'geojson', 'webmanifest'], load: json },
  { id: 'yaml', label: 'YAML', extensions: ['yaml', 'yml'], load: yaml },
  { id: 'python', label: 'Python', extensions: ['py', 'pyw', 'pyi'], load: python },
  { id: 'cython', label: 'Cython', extensions: ['pyx', 'pxd'], load: cython },
  { id: 'octave', label: 'MATLAB / Octave', extensions: ['m'], load: octave },
  { id: 'r', label: 'R', extensions: ['r'], load: r },
  { id: 'julia', label: 'Julia', extensions: ['jl'], load: julia },
  { id: 'lua', label: 'Lua', extensions: ['lua'], load: lua },
  { id: 'perl', label: 'Perl', extensions: ['pl', 'pm', 't'], load: perl },
  { id: 'php', label: 'PHP', extensions: ['php', 'phtml', 'php3', 'php4', 'php5', 'phps'], load: php },
  { id: 'ruby', label: 'Ruby', extensions: ['rb', 'rake', 'gemspec', 'ru'], filenames: ['rakefile', 'gemfile', 'vagrantfile', 'podfile', 'capfile', 'guardfile', 'brewfile'], load: ruby },
  { id: 'go', label: 'Go', extensions: ['go'], load: go },
  { id: 'rust', label: 'Rust', extensions: ['rs'], load: rust },
  { id: 'c', label: 'C', extensions: ['c', 'h'], load: () => clike('c') },
  { id: 'cpp', label: 'C++', extensions: ['cpp', 'cxx', 'cc', 'hpp', 'hh', 'hxx', 'h++', 'ipp', 'tpp', 'inl', 'mm'], load: () => clike('cpp') },
  { id: 'csharp', label: 'C#', extensions: ['cs', 'csx'], load: () => clike('csharp') },
  { id: 'java', label: 'Java', extensions: ['java'], load: () => clike('java') },
  { id: 'kotlin', label: 'Kotlin', extensions: ['kt', 'kts'], load: () => clike('kotlin') },
  { id: 'swift', label: 'Swift', extensions: ['swift'], load: swift },
  { id: 'scala', label: 'Scala', extensions: ['scala', 'sc'], load: () => clike('scala') },
  { id: 'groovy', label: 'Groovy', extensions: ['groovy', 'gradle'], load: groovy },
  { id: 'shell', label: 'Shell', extensions: ['sh', 'bash', 'zsh', 'ksh', 'fish', 'dash'], filenames: ['.bashrc', '.bash_profile', '.bash_aliases', '.zshrc', '.zshenv', '.zprofile', '.profile'], load: shell },
  { id: 'powershell', label: 'PowerShell', extensions: ['ps1', 'psm1', 'psd1', 'pwsh'], load: powershell },
  { id: 'batch', label: 'Batch', extensions: ['bat', 'cmd'], load: async () => batchParser },
  { id: 'sql', label: 'SQL', extensions: ['sql', 'ddl', 'dml'], load: sql },
  { id: 'html', label: 'HTML', extensions: ['html', 'htm', 'xhtml', 'vue', 'svelte'], load: html },
  { id: 'xml', label: 'XML', extensions: ['xml', 'xsl', 'xslt', 'xsd', 'svg', 'plist', 'xaml', 'csproj', 'vcxproj', 'fsproj', 'props', 'targets', 'dtd'], load: xml },
  { id: 'css', label: 'CSS', extensions: ['css'], load: css },
  { id: 'scss', label: 'SCSS', extensions: ['scss'], load: scss },
  { id: 'less', label: 'Less', extensions: ['less'], load: less },
  { id: 'sass', label: 'Sass', extensions: ['sass'], load: sass },
  { id: 'toml', label: 'TOML', extensions: ['toml'], load: toml },
  { id: 'ini', label: 'INI / Properties', extensions: ['ini', 'conf', 'cfg', 'properties', 'env', 'editorconfig'], filenames: ['.env', '.editorconfig', '.gitconfig', '.npmrc', '.yarnrc', '.prettierrc', '.eslintrc'], load: properties },
  { id: 'cmake', label: 'CMake', extensions: ['cmake'], filenames: ['cmakelists.txt'], load: cmake },
  { id: 'make', label: 'Makefile', extensions: ['mk', 'make'], filenames: ['makefile', 'gnumakefile', 'bsdmakefile'], load: async () => makefileParser },
  { id: 'dockerfile', label: 'Dockerfile', extensions: ['dockerfile'], filenames: ['dockerfile', 'containerfile'], load: dockerfile },
  { id: 'tex', label: 'LaTeX', extensions: ['tex', 'latex', 'sty', 'cls', 'dtx', 'ins'], load: stex },
  { id: 'asm', label: 'Assembly', extensions: ['asm', 's', 'nasm'], load: gas },
  { id: 'vhdl', label: 'VHDL', extensions: ['vhd', 'vhdl'], load: vhdl },
  { id: 'verilog', label: 'Verilog', extensions: ['v', 'sv', 'svh', 'vh'], load: verilog },
  { id: 'dart', label: 'Dart', extensions: ['dart'], load: () => clike('dart') },
  { id: 'diff', label: 'Diff', extensions: ['diff', 'patch'], load: diff },
  { id: 'http', label: 'HTTP', extensions: ['http', 'rest'], load: http },
  { id: 'protobuf', label: 'Protocol Buffers', extensions: ['proto'], load: protobuf },
  { id: 'vb', label: 'Visual Basic', extensions: ['vb'], load: vb },
  { id: 'vbscript', label: 'VBScript', extensions: ['vbs'], load: vbscript },
  { id: 'haskell', label: 'Haskell', extensions: ['hs', 'lhs'], load: haskell },
  { id: 'clojure', label: 'Clojure', extensions: ['clj', 'cljs', 'cljc', 'edn'], load: clojure },
  { id: 'erlang', label: 'Erlang', extensions: ['erl', 'hrl'], load: erlang },
  { id: 'ocaml', label: 'OCaml', extensions: ['ml', 'mli'], load: ocaml },
  { id: 'fsharp', label: 'F#', extensions: ['fs', 'fsx', 'fsi'], load: fsharp },
  { id: 'tcl', label: 'Tcl', extensions: ['tcl', 'tk'], load: tcl },
  { id: 'pascal', label: 'Pascal', extensions: ['pas', 'dpr'], load: pascal },
  { id: 'lisp', label: 'Common Lisp', extensions: ['lisp', 'lsp', 'cl', 'el'], load: lisp },
  { id: 'coffeescript', label: 'CoffeeScript', extensions: ['coffee', 'litcoffee', 'cson'], load: coffeescript },
  { id: 'stylus', label: 'Stylus', extensions: ['styl'], load: stylus },
  { id: 'crystal', label: 'Crystal', extensions: ['cr'], load: crystal },
  { id: 'd', label: 'D', extensions: ['d', 'di'], load: d },
  { id: 'elm', label: 'Elm', extensions: ['elm'], load: elm },
  { id: 'fortran', label: 'Fortran', extensions: ['f', 'f77', 'f90', 'f95', 'f03', 'f08', 'for', 'ftn'], load: fortran },
  { id: 'gherkin', label: 'Gherkin', extensions: ['feature'], load: gherkin },
  { id: 'jinja', label: 'Jinja2', extensions: ['jinja', 'jinja2', 'j2'], load: jinja2 },
  { id: 'mathematica', label: 'Mathematica', extensions: ['wl', 'wls', 'nb'], load: mathematica },
  { id: 'modelica', label: 'Modelica', extensions: ['mo'], load: modelica },
  { id: 'nginx', label: 'Nginx', extensions: [], filenames: ['nginx.conf'], load: nginx },
  { id: 'nsis', label: 'NSIS', extensions: ['nsi', 'nsh'], load: nsis },
  { id: 'pug', label: 'Pug', extensions: ['pug', 'jade'], load: pug },
  { id: 'puppet', label: 'Puppet', extensions: ['pp'], load: puppet },
  { id: 'rpm', label: 'RPM Spec', extensions: ['spec'], load: rpm },
  { id: 'scheme', label: 'Scheme', extensions: ['scm', 'ss'], load: scheme },
  { id: 'smalltalk', label: 'Smalltalk', extensions: ['st'], load: smalltalk },
  { id: 'sparql', label: 'SPARQL', extensions: ['rq', 'sparql'], load: sparql },
  { id: 'turtle', label: 'Turtle', extensions: ['ttl'], load: turtle },
  { id: 'wast', label: 'WebAssembly', extensions: ['wat', 'wast'], load: wast },
  { id: 'webidl', label: 'WebIDL', extensions: ['webidl', 'idl'], load: webidl },
  { id: 'xquery', label: 'XQuery', extensions: ['xq', 'xquery'], load: xquery },
];

const byId = new Map(languageSpecs.map(spec => [spec.id, spec]));
const byExtension = new Map<string, LanguageSpec>();
const byFilename = new Map<string, LanguageSpec>();
for (const spec of languageSpecs) {
  for (const extension of spec.extensions) if (!byExtension.has(extension)) byExtension.set(extension, spec);
  for (const filename of spec.filenames ?? []) if (!byFilename.has(filename)) byFilename.set(filename, spec);
}

/** 按稳定 id 取语言描述；未知 id 返回 null。 */
export function languageSpec(id: string | null | undefined): LanguageSpec | null {
  return typeof id === 'string' ? byId.get(id) ?? null : null;
}

/** 按小写扩展名（不带点）取语言描述；未知返回 null。 */
export function languageSpecForExtension(extension: string): LanguageSpec | null {
  return byExtension.get(extension.toLowerCase()) ?? null;
}

/** 按精确文件名（不区分大小写）取语言描述；未知返回 null。 */
export function languageSpecForFilename(filename: string): LanguageSpec | null {
  return byFilename.get(filename.toLowerCase()) ?? null;
}

/** 所有可按需加载的语言 id（稳定顺序）。 */
export function languageIds(): string[] { return languageSpecs.map(spec => spec.id); }
