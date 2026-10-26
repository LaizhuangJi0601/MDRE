# 语法参考

本页汇总当前版本支持的 Markdown、扩展标记和 HTML。示例中 ↵ 表示换行，↵ ↵ 表示空行；操作入口见[使用指南](MDRE使用.md)。

## 基础语法

以 CommonMark 为基础。普通段落中的数字句点写作 `1\. 说明`；`1. 说明` 表示有序列表。复杂列表中的额外空段可保存为标准 HTML `<p></p>`。

| 写法 | 功能与备注 |
| --- | --- |
| `# 一级标题` … `###### 六级标题` | 一至六级标题，井号后加空格。 |
| `标题` ↵ `===`；`标题` ↵ `---` | Setext 式一级或二级标题：标题下一行分别使用等号或连字符标记。 |
| `第一段` ↵  ↵ `第二段` | 段落间留一空行（↵ ↵）。 |
| `第一行  ` ↵ `第二行` | 行末两个空格后换行。 |
| `第一行\` ↵ `第二行` | 行末反斜杠后换行。 |
| `**粗体**`；`__粗体__` | 加粗文字。 |
| `*斜体*`；`_斜体_` | 斜体文字。 |
| `***粗斜体***` | 同时加粗与斜体。 |
| `> 引用`；`>> 嵌套引用` | 引用块；重复引用标记表示嵌套。 |
| `- 项目`；`* 项目`；`+ 项目` | 无序列表；标记后留一个空格。 |
| `1. 项目`；`2. 项目` | 有序列表；数字后加句点和空格。 |
| `- 父项` ↵ `    - 子项` | 缩进子项，形成嵌套列表；此示例子项缩进四个空格。 |
| `---`；`***`；`___` | 分隔线；独占一行，建议与前后正文用空行隔开。 |
| `` `代码` `` | 行内代码；内部 Markdown 标记不解析。 |
| ``` ``含有 ` 的代码`` ``` | 使用双反引号包裹包含单反引号的行内代码。 |
| ```` ```python ```` ↵ `print("hello")` ↵ ```` ``` ```` | 围栏代码块（CommonMark）；围栏独占一行，语言名可省略。 |
| `~~~python` ↵ `print("hello")` ↵ `~~~` | 波浪号围栏代码块（CommonMark）；开闭围栏使用同一种字符。 |
| `    print("hello")` | 缩进代码块；每行开头缩进四个空格或一个制表符。 |
| `[文字](https://example.com)` | 链接。 |
| `[文字](https://example.com "提示")` | 带悬停提示的链接。 |
| `[文字][标识]` ↵  ↵ `[标识]: https://example.com "提示"` | 引用式链接；正文引用标识，另行定义地址与可选提示。 |
| `![说明](assets/image.png)` | 图片；方括号为替代文字，圆括号为图片路径或地址。 |
| `![说明](assets/image.png "提示")` | 带悬停提示的图片。 |
| `<https://example.com>`；`<name@example.com>` | 自动链接；地址或邮箱使用尖括号包裹。 |
| `[跳转](#section-id)` | 页内链接；跳转到指定 ID。 |
| `\*`；`\#`；`\[`；`\\` | 反斜杠转义；将有语法意义的标点作为普通字符显示。 |
| `&amp;`；`&lt;`；`&gt;`；`&#169;` | HTML 实体；分别表示与号、小于号、大于号、版权符号。 |
| `<br>` | HTML 换行；MDRE 可用于表格单元格内换行。 |
| `<span>文字</span>`；`<div>内容</div>`；`<!-- 注释 -->` | 原始 HTML 与注释属于 Markdown 标准；MDRE 保留源码并渲染受支持的 HTML，成对行内标签中的文字可直接编辑；脚本和事件属性不会执行。 |

## 通用扩展

以下写法常见于 GFM、Pandoc 等工具，具体支持范围随阅读器而异。

| 写法 | 功能与备注 |
| --- | --- |
| `~~删除线~~` | 删除线；GFM 等常用扩展。 |
| `- [ ] 未完成`；`- [x] 已完成` | 任务清单；GFM 等常用扩展。 |
| `\| 名称 \| 数值 \|` ↵ `\| --- \| --- \|` ↵ `\| 示例 \| 123 \|` | 管道表格；表头与数据之间必须有分隔行。 |
| `\| :--- \| :---: \| ---: \|` | 表格分隔行中的冒号分别表示左对齐、居中、右对齐。 |
| `A \\| B` | 表格单元格内的竖线需使用反斜杠转义；位于行内代码中的竖线也应转义。 |
| `==重点==` | 默认颜色高亮，部分编辑器支持。 |
| `x^2^`；`H~2~O` | 上标与下标；Pandoc 等常用扩展，MDRE 要求标记内非空且不含空白。 |
| `$x^2 + y^2 = z^2$` | 行内 LaTeX 数学公式；MDRE 使用 KaTeX 渲染。 |
| `$$` ↵ `\frac{a}{b}` ↵ `$$` | 块级 LaTeX 数学公式；MDRE 要求开闭 `$$` 各独占一行。 |
| `$$` ↵ `E = mc^2 \tag{1}` ↵ `$$` | 块级公式编号；`\tag{1}` 显示带括号编号，`\tag*{1}` 显示不带括号编号。 |
| ```` ```mermaid ```` ↵ `graph TD` ↵ `A --> B` ↵ ```` ``` ```` | Mermaid 图表代码块；渲染为图表，可在源码栏修改，或双击图表打开源码编辑器。 |
| `文字[^注1]` ↵  ↵ `[^注1]: 脚注内容` | 脚注引用与定义；MDRE 按首次引用顺序编号。 |
| `[toc]` | 文档内目录；必须独占一段，按标题生成，其他编辑器的目录标记可能不同。 |
| `## 标题 {#section-id}` | 显式标题 ID；Pandoc 等常用扩展，可用 `[跳转](#section-id)` 引用。 |
| `---` ↵ `title: 文档标题` ↵ `author: 作者` ↵ `---` | YAML front matter；位于文首，存放元数据。MDRE 导出时不输出，可使用 `title` 作为默认文件名。 |
| `![说明](image.png){width="4in"}` | Pandoc 风格图片尺寸属性；接受带 `px`、`in`、`cm`、`mm`、`pt` 单位的正数 `width` 或 `height`。`width` 换算为像素用于显示；`height` 保留在源码中，显示时仍保持图片宽高比。 |

## MDRE 扩展

| 写法 | 功能与备注 |
| --- | --- |
| `{color:#e5484d}文字{/color}` | 文字颜色：#RGB、#RRGGBB 或 red/blue/green/yellow/orange/purple/black/white/gray/grey。 |
| `{bg:#fff3b0}文字{/bg}` | MDRE 指定高亮背景色；取值规则同文字颜色。 |
| `{size:1.25em}文字{/size}`；`{size:18px}文字{/size}` | 字号：使用大于 0 的有限数值，并附加 `em` 或 `px` 单位。 |
| `![说明](image.png){w:400}` | 图片宽度：正整数，单位 px。 |
| `<!-- mdre:table-widths: 25%,40%,35% -->` | 表格列宽注释：位于表格之后（中间可隔空行），按列顺序以百分比指定列宽；数量与表格列数不一致时忽略该注释并回退自动布局。 |
| `{color:red}{bg:yellow}文字{/bg}{/color}` | 样式可嵌套，按相反顺序闭合；不符合语法要求的标签按原文显示。 |

颜色、背景色和字号标签不能跨行，可嵌套且须按相反顺序闭合。颜色接受 #RGB、#RRGGBB 或表中列出的名称；字号必须为正的有限数值。无效参数或未闭合标记按原文显示，代码中的标记不解析。

MDRE 扩展在其他阅读器中可能显示为源码；列宽注释通常作为普通 HTML 注释忽略。

## 图片与表格

### 图片路径与尺寸

本地图片可使用 `![说明](<file:///D:/资料/图片.png>)`，空格、`#`、`%` 按 URI 规则编码；相对路径按 Markdown 所在目录解析。截图写入持久图片库，资源目录仅作兜底。

`{w:400}` 指定像素宽度。Pandoc 尺寸属性接受 px、in、cm、mm、pt 单位的正数；`width` 换算为像素，`height` 保留在源码，显示时保持宽高比。

### 列宽与对齐

分隔行中的冒号设置整列对齐，手动列宽写在表格后的首个 `mdre:table-widths` 注释中，中间可隔空行：

```markdown
| 左对齐 | 居中 | 右对齐 |
| :--- | :---: | ---: |
| 示例 | 123 | 456 |

<!-- mdre:table-widths: 25%,40%,35% -->
```

列宽按顺序对应各列，单列最小 4%、总宽不超过 100%；插删列同步调整。数量与列数不匹配时忽略注释并恢复自动布局。

### 合并单元格

合并或上下居中采用 HTML 表格。`rowspan`／`colspan` 指定跨度，`colgroup` 保存列宽，`text-align` 与 `vertical-align` 保存对齐：

```html
<table>
  <colgroup><col style="width:40%"><col style="width:60%"></colgroup>
  <tr><td rowspan="2" style="vertical-align:middle">合并内容</td><td>第一行</td></tr>
  <tr><td style="text-align:right">第二行</td></tr>
</table>
```

仅无合并、无上下居中的 HTML 表格可转为 Markdown 表格；列宽保留为注释，对齐取每列首行，列内混合对齐按左对齐处理。行内 `<span style="display:block;text-align:…">` 包装可继续识别，对齐命令采用表格本身的列或单元格属性。

HTML／PDF 导出保留列宽、合并与对齐。其他编辑器可能显示 HTML 源码或丢弃样式，保存前应确认兼容范围。

## HTML 内容

HTML 按原始标签与属性保存，不自动改写为 Markdown。简单行内文字可直接编辑；复杂块和组件通过源码栏或源码片段编辑。HTML 表格支持表格菜单操作。

### 支持的标签

| 类别 | 支持标签或示例 | 备注 |
| --- | --- | --- |
| 基本文本 | `p br hr span div` | 段落、换行、分隔线与容器 |
| 文字强调 | `strong b em i u s del ins mark small` | 加粗、斜体、下划线、删除线等 |
| 文字语义 | `abbr cite kbd samp var code q dfn time data` | 可使用 title、datetime 等属性 |
| 上下标与方向 | `sup sub bdi bdo wbr` | 方向属性 dir、lang 可保留 |
| 注音 | `ruby rb rt rp rtc` | 显示文字与读音 |
| 标题与引用 | `h1 h2 h3 h4 h5 h6 blockquote pre` | HTML 标题按原始块显示 |
| 列表 | `ul ol li dl dt dd menu` | 支持 start、reversed 等属性 |
| 页面结构 | `main section article aside header footer nav address hgroup search center` | 作为文档结构展示 |
| 图文容器 | `figure figcaption picture source` | 本地图片沿用文档路径解析 |
| 链接 | `<a href="#section-id">跳转</a>` | 页内链接可直接点击；编辑时外链用 Ctrl＋单击 |
| 图片 | `<img src="image.png" alt="说明" width="400">` | 支持相对路径、file URI、HTTPS、图片 data URI |
| 图像映射 | `map area` | 保留区域与链接属性 |
| 表格 | `table caption colgroup col thead tbody tfoot tr th td` | 可保留 colspan、rowspan、align、scope、headers 与单元格 style；合并单元格的表格可在 MDRE 中继续编辑。 |
| 折叠内容 | `<details><summary>标题</summary>内容</details>` | 保留 open 属性 |
| 表单外观 | `form fieldset legend label input button select optgroup option textarea datalist output progress meter` | 输入、按钮、选择、文本域禁用，仅展示 |
| 音视频 | `audio video source track` | 使用 HTTPS 来源；支持 controls、loop、muted 等属性 |
| SVG 基础 | `svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath` | 保留 viewBox、路径、坐标、描边与填色 |
| SVG 图形效果 | `clipPath mask pattern linearGradient radialGradient stop marker image foreignObject desc title` | 支持渐变、裁剪与标记，属性大小写保留 |
| SVG 滤镜 | `filter feGaussianBlur feOffset feBlend feColorMatrix feComposite feFlood feMerge feMergeNode` | 展示受支持的滤镜 |
| MathML 基础 | `math semantics annotation mrow mi mo mn mtext mspace` | 直接显示数学结构 |
| MathML 结构 | `msup msub msubsup msqrt mroot mfrac mover munder munderover` | 上下标、根式、分式与上下附注 |
| MathML 扩展 | `mtable mtr mtd mlabeledtr mmultiscripts mprescripts none menclose mfenced mstyle mpadded mphantom maction` | 布局及样式以浏览器支持为准 |
| 实体与注释 | `&amp; &lt; &gt; &#169; <!-- 注释 -->` | 实体解码显示；注释保留在源码 |

### 属性与常用样式

| 写法 | 用途 | 备注 |
| --- | --- | --- |
| `<u>文字</u>` | 下划线 | 工具栏 U 使用此写法，可与其他格式组合 |
| `<mark style="background-color:#FFF2CC" title="批注">正文</mark>` | 高亮及悬停批注 | 原有 style、title、data-comments 保留 |
| `<span style="color:#3e63dd;font-size:18px">文字</span>` | 颜色和字号 | 已有 HTML 保留；工具栏仍写入 MDRE 格式标签 |
| `<span style="display:block;text-align:right">文字</span>` | 单格内容水平对齐 | 可识别并直接编辑；对齐命令在 GFM 表格写分隔行、HTML 表格写单元格 `text-align` 样式 |
| `id class style title lang dir` | 通用属性 | 只保留允许的属性及样式 |
| `data-* aria-*` | 自定义数据与无障碍属性 | 保留属性，不执行附加逻辑 |

### 呈现边界

- 仅保留受支持的标签、属性与样式；脚本、事件属性、iframe 和 object 不执行，外部网页样式表不加载。
- 表单控件仅展示外观，不作为编辑器输入控件。本地音视频不走图片资源解析，播放不作保证。
- SVG 与 MathML 保留支持的结构、必要属性及大小写；具体排版取决于浏览器能力。
- 页内链接可直接点击；编辑模式中的外部链接使用 Ctrl+单击。不同平台对 HTML 与内联样式的支持可能不同。
