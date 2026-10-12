import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

export type SearchOptions = { query: string; regex: boolean; caseSensitive: boolean; wholeWord: boolean };
export type Hit = { from: number; to: number; text: string; block?: true };
type SearchState = { options: SearchOptions; active: number; decorations: DecorationSet; hits: Hit[]; error: string };
const empty: SearchOptions = { query: '', regex: false, caseSensitive: false, wholeWord: false };
const key = new PluginKey<SearchState>('find');
const flags = (options: SearchOptions) => options.caseSensitive ? 'g' : 'gi';
const isWord = (char: string) => !!char && /[\p{L}\p{N}_]/u.test(char);
const boundary = (text: string, from: number, to: number) => !isWord(text[from - 1] ?? '') && !isWord(text[to] ?? '');

// B-6：同一套匹配规则用于高亮、计数与替换，支持正则、区分大小写与全字匹配。
export function occurrences(text: string, options: SearchOptions): [number, number][] {
  const found: [number, number][] = [];
  if (!text || !options.query) return found;
  if (options.regex) {
    const pattern = new RegExp(options.query, flags(options));
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (!match[0].length) { pattern.lastIndex++; continue; }
      found.push([match.index, match.index + match[0].length]);
    }
    return found;
  }
  const haystack = options.caseSensitive ? text : text.toLowerCase(), needle = options.caseSensitive ? options.query : options.query.toLowerCase();
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
    if (!options.wholeWord || boundary(text, at, at + needle.length)) found.push([at, at + needle.length]);
  }
  return found;
}
function compile(options: SearchOptions) {
  if (options.regex && options.query) new RegExp(options.query, flags(options));
}
function matches(doc: import('prosemirror-model').Node, options: SearchOptions): Hit[] {
  const hits: Hit[] = [];
  if (!options.query) return hits;
  doc.descendants((node, pos) => {
    if (node.type.name === 'opaque') {
      const text = node.attrs.kind === 'code' || node.attrs.kind === 'mermaid' ? node.attrs.content : node.attrs.raw;
      if (occurrences(text, options).length) hits.push({ from: pos, to: pos + node.nodeSize, text, block: true });
      return false;
    }
    if (!node.isTextblock) return;
    let text = '', offsets: number[] = [];
    node.descendants((child, inner) => {
      if (child.isText) { const value = child.text!; text += value; offsets.push(...Array.from({ length: value.length }, (_, i) => pos + 1 + inner + i)); }
      else if (child.isLeaf) { text += '\ufffc'; offsets.push(pos + 1 + inner); }
    });
    for (const [from, to] of occurrences(text, options)) hits.push({ from: offsets[from], to: offsets[to - 1] + 1, text: text.slice(from, to) });
    return false;
  });
  return hits;
}
export const searchPlugin = new Plugin<SearchState>({
  key,
  state: {
    init: () => ({ options: { ...empty }, active: -1, decorations: DecorationSet.empty, hits: [], error: '' }),
    apply(tr, old) {
      const meta = tr.getMeta(key) as { options?: SearchOptions; active?: number } | undefined;
      if (!meta && !tr.docChanged) return old;
      const options = meta?.options ?? old.options, active = meta?.active ?? -1;
      let hits: Hit[] = [], error = '';
      try { hits = matches(tr.doc, options); } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
      return { options, active, hits, error, decorations: DecorationSet.create(tr.doc, hits.map((hit, index) => {
        const attrs = { class: index === active ? 'search-hit current' : 'search-hit' };
        return hit.block ? Decoration.node(hit.from, hit.to, attrs) : Decoration.inline(hit.from, hit.to, attrs);
      })) };
    },
  },
  props: { decorations: state => key.getState(state)!.decorations },
});
export function searchState(view: EditorView) { return key.getState(view.state)!; }
export function find(view: EditorView, options: SearchOptions, next = false) {
  const old = searchState(view);
  try { compile(options); } catch { view.dispatch(view.state.tr.setMeta(key, { options, active: -1 })); return '正则表达式无效'; }
  const active = next && old.options.query === options.query ? (old.active + 1) % Math.max(1, old.hits.length) : 0;
  view.dispatch(view.state.tr.setMeta(key, { options, active }));
  const result = searchState(view);
  if (options.query && result.hits[active]) {
    const rect = view.coordsAtPos(result.hits[active].from), pane = view.dom.parentElement!, bounds = pane.getBoundingClientRect();
    if (rect.top < bounds.top || rect.bottom > bounds.bottom) pane.scrollTop += rect.top - bounds.top - bounds.height / 3;
  }
  if (!options.query) return '';
  if (!result.hits.length) return '无匹配';
  return `${active + 1} / ${result.hits.length}`;
}
const replacementFor = (hit: Hit, replacement: string, options: SearchOptions) =>
  options.regex ? hit.text.replace(new RegExp(options.query, options.caseSensitive ? '' : 'i'), replacement) : replacement;
// 替换一次：走渲染栏事务，沿用既有的源码反向映射与撤销历史。
export function replaceCurrent(view: EditorView, replacement: string) {
  const state = searchState(view), hit = state.hits[state.active];
  if (!hit || hit.block) return false;
  view.dispatch(view.state.tr.insertText(replacementFor(hit, replacement, state.options), hit.from, hit.to));
  return true;
}
// 替换全部：从后往前逐条替换，每次都是一处连续改动，走与手工输入相同的反向映射与校验。
export function replaceAll(view: EditorView, replacement: string) {
  const state = searchState(view), targets = state.hits.filter(hit => !hit.block);
  if (!targets.length) return 0;
  let count = 0;
  for (const hit of [...targets].reverse()) {
    view.dispatch(view.state.tr.insertText(replacementFor(hit, replacement, state.options), hit.from, hit.to));
    count++;
  }
  return count;
}
