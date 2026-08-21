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
  // 行扫描器：标题/列表/引用按行即时成块，避免「标题+列表」混合块落入 <p> 退路（hf 事故：### 与 - 原样显示）
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;
  let quote: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const tag = list.type;
      out.push(`<${tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${tag}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const rawLine of text.split('\n')) {
    const t = rawLine.trim();
    if (/^@@fn\d+@@$/.test(t)) {
      flushAll();
      out.push(t);
      continue;
    }
    if (!t) {
      flushAll();
      continue;
    }
    const h = t.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      flushAll();
      const lv = Math.min(h[1]!.length + 3, 6); // # → h4，气泡内层级压低
      out.push(`<h${lv}>${inline(h[2]!)}</h${lv}>`);
      continue;
    }
    const ul = t.match(/^[-*]\s+(.+)$/);
    if (ul) {
      flushPara();
      flushQuote();
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(ul[1]!);
      continue;
    }
    const ol = t.match(/^\d+\.\s+(.+)$/);
    if (ol) {
      flushPara();
      flushQuote();
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(ol[1]!);
      continue;
    }
    const q = t.match(/^&gt;\s?(.*)$/);
    if (q) {
      flushPara();
      flushList();
      quote.push(q[1]!);
      continue;
    }
    flushList();
    flushQuote();
    para.push(t);
  }
  flushAll();
  return out.join('').replace(/@@fn(\d+)@@/g, (_m, i: string) => fences[Number(i)] ?? '');
}

export function Markdown({ text }: { text: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: mdToHtml(text) }} />;
}
