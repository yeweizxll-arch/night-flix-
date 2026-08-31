import { Fragment, type ReactNode } from 'react';

export type MarkdownBlock =
  | { level: 1 | 2 | 3; text: string; type: 'heading' }
  | { items: string[]; ordered: boolean; type: 'list' }
  | { text: string; type: 'code' | 'paragraph' | 'quote' };

export function parseSafeMarkdown(markdown: string): MarkdownBlock[] {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let code: string[] | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().startsWith('```')) {
      if (code) {
        blocks.push({ text: code.join('\n'), type: 'code' });
        code = undefined;
      } else {
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) continue;
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ level: heading[1]!.length as 1 | 2 | 3, text: heading[2]!, type: 'heading' });
      continue;
    }
    if (line.startsWith('> ')) {
      blocks.push({ text: line.slice(2), type: 'quote' });
      continue;
    }
    const list = /^(\s*)([-*+] |\d+[.)] )(.+)$/.exec(line);
    if (list) {
      const ordered = /^\d/.test(list[2]!);
      const items = [list[3]!];
      while (index + 1 < lines.length) {
        const next = /^(\s*)([-*+] |\d+[.)] )(.+)$/.exec(lines[index + 1] ?? '');
        if (!next || /^\d/.test(next[2]!) !== ordered) break;
        items.push(next[3]!);
        index += 1;
      }
      blocks.push({ items, ordered, type: 'list' });
      continue;
    }
    blocks.push({ text: line, type: 'paragraph' });
  }
  if (code) blocks.push({ text: code.join('\n'), type: 'code' });
  return blocks;
}

export function SafeMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className="safe-markdown">
      {parseSafeMarkdown(markdown).map((block, index) => {
        const key = `${block.type}:${index}`;
        if (block.type === 'heading') {
          if (block.level === 1) return <h2 key={key}>{inline(block.text)}</h2>;
          if (block.level === 2) return <h3 key={key}>{inline(block.text)}</h3>;
          return <h4 key={key}>{inline(block.text)}</h4>;
        }
        if (block.type === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return <List key={key}>{block.items.map((item, itemIndex) => <li key={`${key}:${itemIndex}`}>{inline(item)}</li>)}</List>;
        }
        if (block.type === 'quote') return <blockquote key={key}>{inline(block.text)}</blockquote>;
        if (block.type === 'code') return <pre key={key}><code>{block.text}</code></pre>;
        return <p key={key}>{inline(block.text)}</p>;
      })}
    </div>
  );
}

function inline(text: string): ReactNode {
  const result: ReactNode[] = [];
  const pattern = /\[([^\]]{1,200})\]\(([^)\s]{1,2000})\)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > offset) result.push(text.slice(offset, start));
    const label = match[1] ?? '';
    const href = safeLink(match[2] ?? '');
    result.push(href
      ? <a href={href} key={`${start}:${href}`} rel="noreferrer noopener" target="_blank">{label}</a>
      : <Fragment key={`${start}:text`}>{label}</Fragment>);
    offset = start + match[0].length;
  }
  if (offset < text.length) result.push(text.slice(offset));
  return result.length ? result : text;
}

function safeLink(value: string): string | undefined {
  if (value.length > 2_000) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
