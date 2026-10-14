// 每组按钮始终单行排列，分类文字位于下方。
export function groupToolbar() {
  const bar = document.getElementById('edit-bar')!;
  bar.addEventListener('wheel', event => {
    // 竖向滚轮转成横向移动，触控板横向滚动保持原方向。
    if (event.ctrlKey || bar.scrollWidth <= bar.clientWidth) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const distance = delta * (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? bar.clientWidth : 1);
    if (!distance) return;
    event.preventDefault(); bar.scrollLeft += distance;
  }, { passive: false });
  const toolbar = document.getElementById('format-toolbar')!;
  const groups: [string, string[]][] = [
    ['历史', ['undo', 'redo']],
    ['字体', ['bold', 'italic', 'underline', 'strike', 'inline-code', 'font-size-dropdown', 'superscript', 'subscript']],
    ['色彩', ['color-picker', 'highlight-picker']],
    ['段落', ['heading', 'quote', 'bullet', 'ordered', 'task']],
    ['插入', ['link', 'table', 'image', 'code-block', 'rule']],
    ['结构', ['split', 'join', 'up', 'down']],
  ];
  toolbar.querySelectorAll('.tool-separator').forEach(separator => separator.remove());
  for (const [title, ids] of groups) {
    const group = document.createElement('div'); group.className = 'tool-group'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', title);
    const controls = document.createElement('div'); controls.className = 'tool-group-controls';
    for (const id of ids) { const control = document.getElementById(id); if (control) controls.append(control); }
    const label = document.createElement('span'); label.className = 'tool-group-label'; label.textContent = title;
    group.append(controls, label); toolbar.append(group);
  }
  const view = document.querySelector<HTMLElement>('.view-tools')!;
  const controls = document.createElement('div'); controls.className = 'tool-group-controls'; controls.append(...view.childNodes);
  const label = document.createElement('span'); label.className = 'tool-group-label'; label.textContent = '视图';
  view.classList.add('tool-group'); view.append(controls, label);
}
