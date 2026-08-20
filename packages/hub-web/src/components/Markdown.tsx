/**
 * 基础 Markdown 渲染（聊天气泡用）：围栏代码块、行内代码、粗/斜体、链接、标题、列表、引用。
 * 纯函数 mdToHtml 可单测；先整体转义再替换自有标签防注入；链接白名单仅 http(s)。
 */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const safeUrl = (u: string): string => (/^https?:\/\//i.test(u) ? u : '#');

/** 行内：先抽行内代码占位，避免粗斜体/链接规则作用到代码内容 */
function inline(s: string): string {
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `@@ic${codes.length - 1}@@`;
  });
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) => {
      const href = safeUrl(u);
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    });
  return s.replace(/@@ic(\d+)@@/g, (_m, i: string) => codes[Number(i)] ?? '');
}

export function mdToHtml(src: string): string {
  const fences: string[] = [];
  const text = esc(src).replace(/```[^\n]*\n([\s\S]*?)(?:```|$)/g, (_m, code: string) => {
    fences.push(`<pre class="md-pre"><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `@@fn${fences.length - 1}@@`;
  });

  const out: string[] = [];
  for (const raw of text.split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;
    if (/^@@fn\d+@@$/.test(block)) {
      out.push(block);
      continue;
    }
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*] /.test(l))) {
      out.push(`<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`);
    } else if (lines.every((l) => /^\s*\d+\. /.test(l))) {
      out.push(`<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+\. /, ''))}</li>`).join('')}</ol>`);
    } else if (lines.every((l) => /^&gt; /.test(l))) {
      out.push(`<blockquote>${inline(lines.map((l) => l.replace(/^&gt; /, '')).join('<br>'))}</blockquote>`);
    } else {
      const h = block.match(/^(#{1,4})\s+(.+)$/);
      if (h && lines.length === 1) {
        const lv = Math.min(h[1]!.length + 3, 6); // # → h4，气泡内层级压低
        out.push(`<h${lv}>${inline(h[2]!)}</h${lv}>`);
      } else {
        out.push(`<p>${inline(lines.join('<br>'))}</p>`);
      }
    }
  }
  return out.join('').replace(/@@fn(\d+)@@/g, (_m, i: string) => fences[Number(i)] ?? '');
}

export function Markdown({ text }: { text: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: mdToHtml(text) }} />;
}
