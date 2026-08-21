import { describe, expect, it } from 'vitest';
import { mdToHtml } from './Markdown.js';

describe('mdToHtml', () => {
  it('转义 HTML 防注入', () => {
    const html = mdToHtml('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('围栏代码块', () => {
    const html = mdToHtml('```ts\nconst a = 1;\n```');
    expect(html).toContain('<pre class="md-pre"><code>const a = 1;</code></pre>');
  });

  it('行内代码/粗体/斜体', () => {
    const html = mdToHtml('用 `ah push` 做 **接力** 与 *合并*');
    expect(html).toContain('<code>ah push</code>');
    expect(html).toContain('<strong>接力</strong>');
    expect(html).toContain('<em>合并</em>');
  });

  it('链接白名单仅 http(s)，javascript: 回落 #', () => {
    expect(mdToHtml('[x](javascript:alert(1))')).toContain('href="#"');
    expect(mdToHtml('[x](https://a.b/c)')).toContain('href="https://a.b/c"');
  });

  it('列表与标题', () => {
    expect(mdToHtml('- a\n- b')).toContain('<ul><li>a</li><li>b</li></ul>');
    expect(mdToHtml('## 标题')).toContain('<h5>标题</h5>');
  });

  it('混合块：标题+列表+段落各自成块（### 与 - 不再原样落入 <p>）', () => {
    const html = mdToHtml('### 2. 键盘快捷键支持\n- 功能描述： 支持键盘输入\n- 价值： 提高效率\n普通段落');
    expect(html).toContain('<h6>2. 键盘快捷键支持</h6>');
    expect(html).toContain('<ul><li>功能描述： 支持键盘输入</li><li>价值： 提高效率</li></ul>');
    expect(html).toContain('<p>普通段落</p>');
    expect(html).not.toContain('###');
  });
});
