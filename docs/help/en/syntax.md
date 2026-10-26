# Syntax reference

This page covers supported Markdown, extensions and HTML. In examples, ↵ means a line break and ↵ ↵ a blank line. See the [user guide](usage.md) for operations.

## Basic syntax

Based on CommonMark. Escape a numbered sentence as `1\. text`; `1. text` starts a list. Additional empty paragraphs in complex lists may be stored as standard HTML `<p></p>`.

| Syntax | Meaning and notes |
| --- | --- |
| `# Heading 1` … `###### Heading 6` | Six heading levels; add a space after the hashes. |
| `Heading` ↵ `===`; `Heading` ↵ `---` | Setext level-one or level-two headings. |
| `Paragraph 1` ↵ ↵ `Paragraph 2` | Separate paragraphs with a blank line. |
| `Line 1  ` ↵ `Line 2` | Two trailing spaces create a line break. |
| `Line 1\` ↵ `Line 2` | A trailing backslash creates a line break. |
| `**bold**`; `__bold__` | Bold. |
| `*italic*`; `_italic_` | Italic. |
| `***bold italic***` | Bold and italic together. |
| `> quote`; `>> nested quote` | Block quotes; repeat markers for nesting. |
| `- item`; `* item`; `+ item` | Bullet lists; leave a space after the marker. |
| `1. item`; `2. item` | Numbered lists; digits followed by a period and space. |
| `- parent` ↵ `    - child` | Nested list; this child is indented four spaces. |
| `---`; `***`; `___` | Horizontal rules on separate lines; surrounding blank lines are recommended. |
| `` `code` `` | Inline code; internal Markdown is not parsed. |
| ``` ``code containing ` `` ``` | Double backticks wrap inline code containing a backtick. |
| ```` ```python ```` ↵ `print("hello")` ↵ ```` ``` ```` | Fenced code block. Fences occupy their own lines; language is optional. |
| `~~~python` ↵ `print("hello")` ↵ `~~~` | Tilde fence; opening and closing fences use the same character. |
| `    print("hello")` | Indented code; four spaces or one tab at each line start. |
| `[text](https://example.com)` | Link. |
| `[text](https://example.com "hint")` | Link with a tooltip. |
| `[text][id]` ↵ ↵ `[id]: https://example.com "hint"` | Reference link with a separate address and optional title. |
| `![description](assets/image.png)` | Image with alt text and a path or URL. |
| `![description](assets/image.png "hint")` | Image with a tooltip. |
| `<https://example.com>`; `<name@example.com>` | Automatic URL and email links. |
| `[jump](#section-id)` | Link to an internal ID. |
| `\*`; `\#`; `\[`; `\\` | Escape punctuation with a backslash. |
| `&amp;`; `&lt;`; `&gt;`; `&#169;` | HTML entities: ampersand, less-than, greater-than and copyright. |
| `<br>` | HTML line break, including inside table cells. |
| `<span>text</span>`; `<div>content</div>`; `<!-- comment -->` | Raw HTML and comments are standard Markdown. MDRE preserves source and renders supported HTML. Simple paired inline text is editable; scripts and event handlers do not execute. |

## Common extensions

These forms occur in GFM, Pandoc and other readers; support varies by application.

| Syntax | Meaning and notes |
| --- | --- |
| `~~deleted~~` | Strikethrough. |
| `- [ ] incomplete`; `- [x] complete` | Task lists. |
| `\| Name \| Value \|` ↵ `\| --- \| --- \|` ↵ `\| Example \| 123 \|` | Pipe table; a delimiter row is required. |
| `\| :--- \| :---: \| ---: \|` | Delimiter colons set left, center and right column alignment. |
| `A \\| B` | Escape pipes in cells, including inside inline code. |
| `==highlight==` | Highlight using the default color. |
| `x^2^`; `H~2~O` | Superscript and subscript; contents must be nonempty and contain no whitespace. |
| `$x^2 + y^2 = z^2$` | Inline LaTeX rendered with KaTeX. |
| `$$` ↵ `\frac{a}{b}` ↵ `$$` | Display math; each `$$` delimiter must occupy its own line. |
| `$$` ↵ `E = mc^2 \tag{1}` ↵ `$$` | Equation numbering. `\tag{1}` includes parentheses; `\tag*{1}` omits them. |
| ```` ```mermaid ```` ↵ `graph TD` ↵ `A --> B` ↵ ```` ``` ```` | Mermaid diagram; edit its source or double-click the rendered diagram. |
| `Text[^note]` ↵ ↵ `[^note]: Footnote text` | Footnotes numbered by first-reference order. |
| `[toc]` | Generated table of contents; must occupy a separate paragraph. |
| `## Heading {#section-id}` | Explicit heading ID, referenced by `[jump](#section-id)`. |
| `---` ↵ `title: Document title` ↵ `author: Author` ↵ `---` | YAML front matter at the document start. It is omitted from export; `title` may supply the default filename. |
| `![description](image.png){width="4in"}` | Pandoc image dimensions: positive width/height in px, in, cm, mm or pt. Width determines display size; height remains in source and aspect ratio is preserved. |

## MDRE extensions

| Syntax | Meaning and notes |
| --- | --- |
| `{color:#e5484d}text{/color}` | Text color: #RGB, #RRGGBB, or red/blue/green/yellow/orange/purple/black/white/gray/grey. |
| `{bg:#fff3b0}text{/bg}` | Highlight color using the same color rules. |
| `{size:1.25em}text{/size}`; `{size:18px}text{/size}` | A finite positive size with an em or px unit. |
| `![description](image.png){w:400}` | Image width as a positive integer in pixels. |
| `<!-- mdre:table-widths: 25%,40%,35% -->` | Column widths after the table; blank lines may intervene. Invalid or mismatched widths fall back to automatic layout. |
| `<table><tr><td colspan="2">text</td></tr></table>` | Merged cells use HTML rowspan/colspan; vertical and horizontal alignment use cell styles. |

Color, background and size tags may nest and must close in reverse order. They cannot span lines. Invalid or unclosed markers remain literal text. Keep Markdown needed for other readers separate from MDRE-specific presentation.

## HTML support

### Tags and structures

| Category | Tags | Scope |
| --- | --- | --- |
| Text | `a abbr b bdi bdo br cite code del dfn em i ins kbd mark q ruby rp rt s samp small span strong sub sup time u var wbr` | Inline text and supported formatting. |
| Blocks | `address article aside blockquote div dl dt dd figcaption figure footer h1 h2 h3 h4 h5 h6 header hr main nav p pre section` | Common structural markup. |
| Lists | `ul ol li` | Lists and nested structures. |
| Tables | `table caption colgroup col thead tbody tfoot tr th td` | Widths, spans and alignment. |
| Images and media | `img picture source audio video track` | Supported browser display; local media playback is not guaranteed. |
| Controls | `button input label select option textarea progress meter details summary` | Appearance only; not interactive document controls. |
| SVG basics | `svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath` | Supported shapes and text. |
| SVG effects | `clipPath mask pattern linearGradient radialGradient stop marker image foreignObject desc title` | Gradients, clipping and markers; attribute case is preserved. |
| SVG filters | `filter feGaussianBlur feOffset feBlend feColorMatrix feComposite feFlood feMerge feMergeNode` | Supported filters. |
| MathML basics | `math semantics annotation mrow mi mo mn mtext mspace` | Mathematical structure. |
| MathML structure | `msup msub msubsup msqrt mroot mfrac mover munder munderover` | Scripts, roots, fractions and annotations. |
| MathML extensions | `mtable mtr mtd mlabeledtr mmultiscripts mprescripts none menclose mfenced mstyle mpadded mphantom maction` | Layout depends on browser support. |
| Entities and comments | `&amp; &lt; &gt; &#169; <!-- comment -->` | Entities decode for display; comments remain in source. |

### Attributes and styles

| Syntax | Purpose | Notes |
| --- | --- | --- |
| `<u>text</u>` | Underline | Written by the U toolbar action; combines with other formatting. |
| `<mark style="background-color:#FFF2CC" title="comment">text</mark>` | Highlight and tooltip | Existing style, title and data-comments are retained. |
| `<span style="color:#3e63dd;font-size:18px">text</span>` | Color and size | Existing HTML remains; toolbar actions use MDRE style tags. |
| `<span style="display:block;text-align:right">text</span>` | Cell-content alignment | Directly editable; Markdown tables use delimiter alignment, HTML tables use cell styles. |
| `id class style title lang dir` | General attributes | Allowed attributes and styles are preserved. |
| `data-* aria-*` | Data and accessibility | Preserved without executing additional logic. |

### Rendering boundaries

- Only supported tags, attributes and styles remain. Scripts, event handlers, iframe and object do not execute; external page stylesheets do not load.
- Form controls display appearance only. Local audio/video does not use image resolution and playback is not guaranteed.
- SVG and MathML preserve supported structure, required attributes and case; layout depends on browser capabilities.
- Click internal links directly. In editing mode, Ctrl+click opens external links. Other readers may handle HTML and inline styles differently.
