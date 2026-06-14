import { useMemo } from 'react';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

// Minimal HTML sanitizer: strip script/style/event-handlers/javascript: urls.
function sanitize(html) {
  let out = html.replace(/<\/?(script|style|iframe|object|embed)[^>]*>/gi, '');
  out = out.replace(/\son\w+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son\w+\s*=\s*'[^']*'/gi, '');
  out = out.replace(/javascript:/gi, '');
  return out;
}

export default function Markdown({ text }) {
  const html = useMemo(() => sanitize(marked.parse(text || '')), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
