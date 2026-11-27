import { esc } from "./common.mjs";

/** 链接只展示清理后的文件名或链接标题，正文无可执行 URL。 */
function linkText(label, target) {
  const path = target.trim().replace(/^<|>$/g, "").replaceAll("\\", "/");
  if (/^(?:file:|\/|[a-z]:\/|\.\.?\/)/i.test(path) || /^[\w.-]+\/[^/]+/.test(path)) {
    const filename = path.split(/[?#]/, 1)[0].split("/").filter(Boolean).at(-1)?.replace(/:\d+(?::\d+)?$/, "");
    if (filename) {
      try {
        return decodeURIComponent(filename);
      } catch {
        return filename;
      }
    }
  }
  return label;
}

/** 识别行内代码、链接、粗体和强调，未识别内容按纯文本输出。 */
export function inlineMarkdown(value) {
  const text = String(value ?? "");
  const tokens = /(!?)\[([^\]\n]+)\]\(((?:[^()\n]|\([^()\n]*\))*)\)|`+([^`\n]+)`+|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let output = "";
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    const [, , label, target, code, bold, italic] = match;
    output += esc(text.slice(offset, match.index));
    if (label != null) output += `<code class="text-chip">${esc(linkText(label, target))}</code>`;
    else if (code != null) output += `<code class="text-chip">${esc(code)}</code>`;
    else if (bold != null) output += `<strong>${inlineMarkdown(bold)}</strong>`;
    else output += `<em>${inlineMarkdown(italic)}</em>`;
    offset = match.index + match[0].length;
  }
  return output + esc(text.slice(offset));
}

/** 将汇报渲染成段落、列表、引用和代码块，始终转义原始 HTML。 */
export function markdown(value) {
  const sections = String(value ?? "").replace(/\r\n?/g, "\n").split(/^```[^\n]*\n|\n```(?=\n|$)/m);
  return sections.map((section, index) => {
    if (index % 2 === 1) return `<pre class="message-code">${esc(section)}</pre>`;
    return section.split(/\n\s*\n/).filter((block) => block.trim()).map((block) => {
      const lines = block.trim().split("\n");
      if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
        return `<ul>${lines.map((line) => `<li>${inlineMarkdown(line.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
      }
      if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
        return `<ol>${lines.map((line) => `<li>${inlineMarkdown(line.replace(/^\s*\d+\.\s+/, ""))}</li>`).join("")}</ol>`;
      }
      return lines.map((line) => {
        const heading = /^#{1,6}\s+(.+)$/.exec(line);
        if (heading) return `<p><strong>${inlineMarkdown(heading[1])}</strong></p>`;
        if (/^>\s?/.test(line)) return `<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ""))}</blockquote>`;
        return `<p>${inlineMarkdown(line)}</p>`;
      }).join("");
    }).join("");
  }).join("");
}
