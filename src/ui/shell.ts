import appIcon from '../../src-tauri/icons/icon.png?url';
import { icon, iconButton } from './icons';
import { colorPicker } from './color-picker';
import { codeLanguages as languages } from './code-language';
const item = (id: string, label: string, shortcut = '') => `<button id="${id}" role="menuitem"><span>${label}</span><kbd>${shortcut}</kbd></button>`;
const command = (id: string, label: string, shortcut = '', editable = false) => `<button data-command="${id}" ${editable ? 'data-editable' : ''} role="menuitem"><span>${label}</span><kbd>${shortcut}</kbd></button>`;
const menu = (name: string, label: string, body: string) => `<div class="menu"><button id="${name}-menu" class="menu-trigger" aria-haspopup="menu" aria-expanded="false">${label}</button><div class="menu-popup" role="menu" aria-label="${label}" hidden>${body}</div></div>`;

const headingItems = ['<button data-heading="0" role="menuitem">正文</button>', ...Array.from({ length: 6 }, (_, index) => `<button data-heading="${index + 1}" role="menuitem">标题 ${index + 1}</button>`)].join('');
const convertItems = [['paragraph', '正文'], ['heading', '标题'], ['quote', '引用'], ['bullet', '无序列表'], ['ordered', '有序列表'], ['task', '任务清单'], ['code', '代码块'], ['hr', '分隔线']]
  .map(([kind, label]) => `<button data-convert="${kind}" role="menuitem">${label}</button>`).join('');
const codeLanguages = languages.map(([value, label]) => `<option value="${value}" label="${label}"></option>`).join('');
// C-16：字号白名单与模型校验一致，只提供 em / px 的正有限数值。
const fontSizeOptions = ['0.75em', '0.85em', '1em', '1.25em', '1.5em', '2em', '12px', '14px', '16px'];
const sizeItems = fontSizeOptions.map(size => `<button data-size="${size}" role="menuitem">${size}</button>`).join('');

export const shell = `
<header id="titlebar">
  <img class="app-icon" src="${appIcon}" alt="MDRE" draggable="false">
  <nav id="menubar" aria-label="应用菜单">
    ${menu('file', '文件', item('new', '新建文档', 'Ctrl+N') + item('open', '打开…', 'Ctrl+O') + '<hr>' + item('recent-menu', '最近打开文件') + '<div class="menu-popup menu-submenu" id="recent-list" role="menu" aria-label="最近打开文件" hidden></div>' + item('recent-folder-menu', '最近打开文件夹') + '<div class="menu-popup menu-submenu" id="recent-folder-list" role="menu" aria-label="最近打开文件夹" hidden></div><hr>' + item('save', '保存', 'Ctrl+S') + item('save-as', '另存为…', 'Ctrl+Shift+S') + '<hr>' + item('close-tab', '关闭当前标签', 'Ctrl+W'))}
    ${menu('edit', '编辑', command('undo', '撤销', 'Ctrl+Z', true) + command('redo', '重做', 'Ctrl+Y', true) + command('underline', '下划线', 'Ctrl+U', true) + '<hr>' + command('find-open', '查找…', 'Ctrl+F') + '<button id="replace-open" data-editable role="menuitem"><span>替换…</span><kbd>Ctrl+H</kbd></button>' + command('goto-line', '跳转到行…', 'Ctrl+G') + '<hr>' + command('copy', '复制完整源码'))}
    ${menu('view', '查看', command('mode-toggle', '切换编辑 / 阅读模式', 'Ctrl+Shift+V') + command('paper-toggle', 'A4 纸张') + command('outline-toggle', '侧栏', 'Ctrl+Shift+O') + command('focus-toggle', '专注', 'F11') + command('raw', '查看源码片段…') + command('refresh', '刷新渲染') + '<hr><div class="menu-field"><label for="theme">颜色主题</label><select id="theme" aria-label="主题"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></div><div class="menu-field"><label for="default-mode">默认启动模式</label><select id="default-mode" aria-label="默认启动模式"><option value="edit">编辑模式</option><option value="read">阅读模式</option></select></div>')}
    ${menu('settings', '设置', item('settings-open', '打开设置页面') + '<hr><div class="menu-field"><label for="font-body">正文字体</label><select id="font-body" aria-label="正文字体"></select></div><div class="menu-field"><label for="font-mono">等宽字体</label><select id="font-mono" aria-label="等宽字体"></select></div><div class="menu-field"><label for="font-size-input">正文字号</label><input type="number" id="font-size-input" min="10" max="32" step="1" aria-label="字号"></div><div class="menu-field"><label for="line-height">行距</label><input type="number" id="line-height" min="1" max="3" step="0.05" aria-label="行距"></div><hr><div class="menu-field"><label for="backup-count">保存前保留备份</label><input type="number" id="backup-count" min="0" max="20" step="1" aria-label="备份份数"></div><button id="shortcut-open" role="menuitem"><span>快捷键设置…</span><kbd>配置文件</kbd></button><button id="associate-md" role="menuitem"><span>注册 .md 文件关联</span><kbd>双击打开</kbd></button><button id="open-settings-dir" role="menuitem"><span>打开配置目录</span><kbd></kbd></button>')}
    ${menu('export', '导出', item('html', '导出 HTML…') + item('pdf-open', '导出 PDF…'))}
    <button id="help-menu" class="menu-trigger" type="button" aria-haspopup="dialog" aria-controls="help-dialog">帮助</button>
  </nav>
  <div class="title-drag" data-tauri-drag-region><span id="window-title" data-tauri-drag-region>MDRE</span></div>
  <div class="window-controls" aria-label="窗口控制">${iconButton('window-minimize', 'minimize', '最小化')}${iconButton('window-maximize', 'maximize', '最大化')}${iconButton('window-close', 'close', '关闭窗口')}</div>
</header>
<div class="toolbar" id="edit-bar" aria-label="编辑工具">
  <div class="toolbar" id="format-toolbar" aria-label="排版工具">
    ${iconButton('undo', 'undo', '撤销', 'Ctrl+Z')}${iconButton('redo', 'redo', '重做', 'Ctrl+Y')}<i class="tool-separator"></i>
    ${iconButton('bold', 'bold', '粗体', 'Ctrl+B')}${iconButton('italic', 'italic', '斜体', 'Ctrl+I')}${iconButton('underline', 'underline', '下划线', 'Ctrl+U')}${iconButton('strike', 'strike', '删除线')}${iconButton('inline-code', 'inlineCode', '行内代码')}
    <div class="dropdown" id="heading"><button id="heading-menu" class="icon-button has-caret" aria-haspopup="menu" aria-expanded="false" aria-label="标题级别" data-tooltip="标题级别 (Ctrl+1~6)">${icon('heading')}<span class="caret"></span></button><div class="dropdown-popup" role="menu" aria-label="标题级别" hidden>${headingItems}</div></div>
    ${iconButton('quote', 'quote', '引用块')}${iconButton('bullet', 'listBullet', '无序列表')}${iconButton('ordered', 'listOrdered', '有序列表')}${iconButton('task', 'task', '任务清单')}
    ${iconButton('link', 'link', '链接', 'Ctrl+K')}${iconButton('table', 'table', '插入表格')}${iconButton('image', 'image', '插入图片', 'Ctrl+V / 拖入')}
    ${colorPicker('color')}${colorPicker('bg')}
    <div class="dropdown" id="font-size-dropdown"><button id="font-size-menu" class="icon-button has-caret" aria-haspopup="menu" aria-expanded="false" aria-label="字号" data-tooltip="字号">${icon('fontSize')}<span class="caret"></span></button><div class="dropdown-popup" role="menu" aria-label="字号" hidden>${sizeItems}</div></div>
    ${iconButton('superscript', 'superscript', '上标')}${iconButton('subscript', 'subscript', '下标')}
    ${iconButton('code-block', 'codeBlock', '代码块')}${iconButton('rule', 'rule', '分隔线')}<i class="tool-separator"></i>
    ${iconButton('split', 'split', '在光标处分段')}${iconButton('join', 'join', '合并上一个段落')}${iconButton('up', 'up', '列表项上移')}${iconButton('down', 'down', '列表项下移')}
  </div>
  <div class="toolbar view-tools" aria-label="查看工具">${iconButton('paper-toggle', 'paper', 'A4 纸张')}<button id="source-toggle" class="icon-button" aria-label="隐藏源码" data-tooltip="隐藏源码" aria-controls="source-pane" aria-pressed="true" data-editable>${icon('columns')}</button>${iconButton('outline-toggle', 'sidebar', '侧栏', 'Ctrl+Shift+O')}${iconButton('focus-toggle', 'fullscreen', '专注', 'F11')}${iconButton('find-open', 'search', '查找', 'Ctrl+F')}${iconButton('raw', 'code', '源码片段')}${iconButton('refresh', 'refresh', '刷新渲染')}</div>
</div>
<div class="tabs-bar"><div id="sidebar-title">侧栏导航</div><nav id="tabs" aria-label="文档标签"><button id="new-welcome" aria-label="新建欢迎页" data-tooltip="新建欢迎页">${icon('plus')}</button></nav></div>
<input type="file" id="file" accept=".md,.markdown,.txt" hidden><input type="file" id="image-input" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml" multiple hidden><button id="copy" hidden>复制源码</button><button id="mode-toggle" hidden>切换编辑 / 阅读模式</button>
<div class="toolbar" id="search-bar" hidden>
  <input id="find" placeholder="查找渲染文字" aria-label="查找"><span id="find-result" role="status"></span>${iconButton('search', 'arrowDown', '下一个匹配', 'Enter')}
  <label class="find-option"><input type="checkbox" id="find-regex" aria-label="正则表达式">正则</label>
  <label class="find-option"><input type="checkbox" id="find-case" aria-label="区分大小写">区分大小写</label>
  <label class="find-option"><input type="checkbox" id="find-word" aria-label="全字匹配">全字匹配</label>
  <span id="replace-controls"><input id="replace" placeholder="替换为" aria-label="替换为">${iconButton('replace-one', 'replace', '替换一次')}${iconButton('replace-all', 'replaceAll', '全部替换')}</span>${iconButton('find-close', 'close', '关闭查找', 'Esc')}
</div>
<section id="welcome" hidden><div><h1>MDRE</h1><p>打开 Markdown 文件，或开始一篇新文档</p><button id="welcome-new" class="primary-button">新建文档 <kbd>Ctrl+N</kbd></button><button id="welcome-open">打开文件… <kbd>Ctrl+O</kbd></button></div></section>
<main id="panes" class="has-outline">
  <aside id="outline-panel" aria-label="侧栏">
    <div class="sidebar-actions">
      ${iconButton('sidebar-new', 'newFile', '新建文件')}${iconButton('sidebar-open', 'open', '打开文件')}${iconButton('folder-open', 'openFolder', '打开文件夹')}
    </div>
    <div class="sidebar-tabs" role="tablist" aria-label="侧栏内容"><button id="sidebar-files" role="tab" aria-controls="files-view">文件列表</button><button id="sidebar-outline" role="tab" aria-controls="outline-view">大纲导航</button></div>
    <div id="files-view" role="tabpanel" aria-labelledby="sidebar-files" hidden><div id="folder-files"><div class="folder-head"><span id="folder-path" title="尚未打开文件夹">尚未打开文件夹</span>${iconButton('folder-refresh', 'refresh', '刷新文件列表')}</div><div id="file-list"></div></div><div id="file-list-divider" role="separator" tabindex="0" aria-label="调整文件列表与已打开文档高度" aria-orientation="horizontal"></div><div id="opened-files"><div class="opened-head">已打开的文档</div><div id="open-documents"></div></div></div>
    <div id="outline-view" role="tabpanel" aria-labelledby="sidebar-outline">    <div class="outline-head">${icon('heading')}<span>大纲导航</span><span id="outline-count"></span><button id="outline-collapse" class="icon-button" aria-label="折叠大纲" data-tooltip="折叠大纲" aria-expanded="true">${icon('chevronUp')}</button></div>
    <div id="outline-list"></div>
    <p id="outline-empty" class="dialog-hint" hidden>当前文档没有标题</p>
    </div>
    <div id="sidebar-resizer" role="separator" tabindex="0" aria-label="调整侧栏宽度" aria-orientation="vertical"></div>
  </aside>
  <section class="pane" id="source-pane"><div class="pane-title">${icon('markdown')}<span>Markdown 源码</span></div><div id="source"></div></section>
  <div id="divider" role="separator" aria-label="调整两栏宽度，双击重置" aria-orientation="vertical" aria-valuemin="20" aria-valuemax="80" tabindex="0"></div>
  <section class="pane" id="render-pane"><div class="pane-title">${icon('columns')}<span id="render-title">渲染页面</span><span id="preview-state"></span></div><div id="render"></div><span id="paper-zoom" hidden aria-label="纸张缩放比例"></span></section>
  <div id="block-handle" hidden>
    ${iconButton('handle-up', 'chevronUp', '上移同级块')}${iconButton('handle-down', 'chevronDown', '下移同级块')}${iconButton('handle-delete', 'trash', '删除块')}
    <div class="dropdown" id="convert"><button id="handle-convert" class="icon-button has-caret" aria-haspopup="menu" aria-expanded="false" aria-label="转为" data-tooltip="转为">${icon('swap')}<span class="caret"></span></button><div class="dropdown-popup" role="menu" aria-label="转为" hidden>${convertItems}</div></div>
  </div>
  <div id="image-handle" hidden aria-label="拖动调整图片宽度"></div>
  <div id="cell-menu" class="dropdown-popup" role="menu" aria-label="表格行列" hidden>
    <button data-cell="row-above" role="menuitem">上方插入行</button><button data-cell="row-below" role="menuitem">下方插入行</button><button data-cell="row-remove" role="menuitem">删除行</button><hr>
    <button data-cell="column-before" role="menuitem">左侧插入列</button><button data-cell="column-after" role="menuitem">右侧插入列</button><button data-cell="column-remove" role="menuitem">删除列</button>
  </div>
</main>
<div id="error" role="alert"></div><footer id="status"><span id="status-path"></span><span id="status-counts"></span><span id="status-encoding"></span><span id="status-position"></span><span id="status-text" role="status"></span><span id="render-timing" role="status" hidden></span><span id="sync-hint" role="status" hidden></span><span id="recovery-status"></span>${iconButton('backup', 'backup', '立即备份（默认每 60 秒）')}<div class="dropdown" id="mode-picker"><button id="mode" class="mode-button" data-tooltip="选择编辑 / 阅读模式 (Ctrl+Shift+V)" aria-label="选择编辑 / 阅读模式" aria-haspopup="menu" aria-expanded="false">${icon('columns')}<span id="mode-label">编辑模式</span><span class="caret"></span></button><div class="dropdown-popup" role="menu" aria-label="文档模式" hidden><button data-mode="edit" role="menuitemradio">编辑模式</button><button data-mode="read" role="menuitemradio">阅读模式</button></div></div></footer>
<div id="scrim" hidden></div>
<dialog id="math-dialog" data-cancel="math-cancel" aria-labelledby="math-title"><h3 id="math-title">编辑公式</h3><p>点击下方键盘与符号构造公式。确定后更新文档；取消或 Esc 放弃本次修改。</p><div id="math-editor-host"></div><div id="math-keyboard"></div><div id="math-error" role="alert"></div><div class="dialog-actions"><button id="math-cancel">取消</button><button id="math-confirm" class="primary-button">确定</button></div></dialog>
<dialog id="dialog" data-cancel="cancel"><h3 id="dialog-title">源码片段</h3><p>保留原始语法；确认时校验打开版本。<span id="dialog-language" class="dialog-hint"></span></p><div id="draft-editor" class="code-editor"><pre class="highlight-layer" aria-hidden="true"><code id="draft-highlight"></code></pre><textarea id="draft" aria-label="源码草稿" spellcheck="false"></textarea></div><div id="dialog-error"></div><div class="dialog-actions"><button id="cancel">取消</button><button id="confirm" class="primary-button">确认修改</button></div></dialog>
<dialog id="link-dialog" data-cancel="link-cancel"><h3>插入链接</h3><label for="link-url">链接地址</label><input id="link-url" aria-label="链接地址" placeholder="https://example.com"><p>对当前两栏选中的文字套用链接。</p><div id="link-error"></div><div class="dialog-actions"><button id="link-cancel">取消</button><button id="link-confirm" class="primary-button">确定</button></div></dialog>
<dialog id="code-dialog" data-cancel="code-cancel"><h3>代码块</h3><label for="code-language">语言</label><input id="code-language" list="code-languages" aria-label="代码语言" placeholder="留空为纯文本"><datalist id="code-languages">${codeLanguages}</datalist><p>把当前段落转成围栏代码块，内容按源码原样保留。</p><div id="code-error"></div><div class="dialog-actions"><button id="code-cancel">取消</button><button id="code-confirm" class="primary-button">确定</button></div></dialog>
<dialog id="table-dialog" data-cancel="table-cancel"><h3>插入表格</h3><div class="dialog-field"><label for="table-rows">数据行数</label><input id="table-rows" type="number" min="0" max="50" value="2" aria-label="数据行数"></div><div class="dialog-field"><label for="table-columns">列数</label><input id="table-columns" type="number" min="1" max="12" value="3" aria-label="列数"></div><p>单元格可直接输入；Enter 换行，Tab 切换单元格，右键增删行列。</p><div id="table-error"></div><div class="dialog-actions"><button id="table-cancel">取消</button><button id="table-confirm" class="primary-button">插入</button></div></dialog>
<dialog id="pdf-dialog" data-cancel="pdf-cancel"><h3>导出 PDF</h3><label for="pdf-path">保存位置</label><input id="pdf-path" aria-label="PDF 输出路径" placeholder="绝对 .pdf 路径"><p>导出当前文档的静态快照。</p><div class="dialog-actions"><button id="pdf-cancel">取消</button><button id="pdf" class="primary-button">导出</button></div></dialog>
<dialog id="close-dialog"><h3 id="close-title">未保存的修改</h3><p class="dialog-message"></p><div class="dialog-actions"><button id="close-cancel">取消</button><button id="close-discard">放弃修改</button><button id="close-save" class="primary-button">保存</button></div></dialog>
<dialog id="conflict-dialog"><h3>保存冲突</h3><p class="dialog-message"></p><p>磁盘文件已被其他程序改动。可以另存为新文件保留当前内容，或重新加载磁盘版本放弃本地修改。</p><div class="dialog-actions"><button id="conflict-cancel">取消</button><button id="conflict-reload">重新加载磁盘</button><button id="conflict-save-as" class="primary-button">另存为…</button></div></dialog>
<dialog id="missing-dialog"><h3>图片资源缺失</h3><p class="dialog-message"></p><div class="dialog-actions"><button id="missing-cancel">取消保存</button><button id="missing-proceed" class="primary-button">继续保存</button></div></dialog>
<dialog id="encoding-dialog"><h3>非 UTF-8 文件</h3><p class="dialog-message"></p><p>保存默认沿用原编码；转换为 UTF-8 会改变磁盘文件编码。</p><div class="dialog-actions"><button id="encoding-convert">转为 UTF-8</button><button id="encoding-keep" class="primary-button">按原编码打开</button></div></dialog>
<dialog id="shortcut-dialog" data-cancel="shortcut-cancel"><h3>快捷键设置</h3><p>点入输入框后直接按下组合键即可重绑，按 Escape 清空表示恢复默认。修改保存到配置文件。</p><div id="shortcut-list" class="shortcut-list"></div><div class="dialog-actions"><button id="shortcut-cancel">取消</button><button id="shortcut-save" class="primary-button">保存</button></div></dialog>
<dialog id="goto-dialog" data-cancel="goto-cancel"><h3>跳转到行</h3><div class="dialog-field"><label for="goto-line-input">行号</label><input type="number" id="goto-line-input" min="1" aria-label="行号"></div><p id="goto-hint" class="dialog-hint"></p><div class="dialog-actions"><button id="goto-cancel">取消</button><button id="goto-confirm" class="primary-button">跳转</button></div></dialog>
<div id="image-preview" hidden aria-hidden="true"><img id="image-preview-img" alt=""></div>
<dialog id="image-dialog" data-cancel="image-close" aria-labelledby="image-title"><h3 id="image-title">图片查看</h3><div id="image-view-stage"><img id="image-large" alt=""></div><div class="dialog-actions"><button id="image-rotate-left" aria-label="向左旋转图片">左转 90°</button><button id="image-rotate-right" aria-label="向右旋转图片">右转 90°</button><button id="image-close" class="primary-button">关闭</button></div></dialog>
<div id="tooltip" role="tooltip" hidden></div>`;




