// Renderer Markdown kecil dan aman: semua teks di-escape lebih dulu, tidak ada HTML mentah yang lolos.
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(raw, store) {
  let s = raw;
  const codes = [];
  // 1) kode inline dilindungi dulu
  s = s.replace(/`([^`\n]+)`/g, (m, c) => {
    codes.push(c);
    return `\u0000C${codes.length - 1}\u0000`;
  });
  // 2) rumus matematika dilindungi agar tidak dirusak oleh * atau _
  const keep = (m) => {
    store.push(m);
    return `\u0000M${store.length - 1}\u0000`;
  };
  s = s.replace(/\$\$[\s\S]+?\$\$/g, keep);
  s = s.replace(/\\\[[\s\S]+?\\\]/g, keep);
  s = s.replace(/\\\([\s\S]+?\\\)/g, keep);
  s = s.replace(/(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])/g, keep);

  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (m, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<![\w_])__(.+?)__(?![\w_])/g, '<strong>$1</strong>');
  s = s.replace(/(?<![*\w])\*(?!\s|\*)(.+?)(?<!\s)\*(?![*\w])/g, '<em>$1</em>');
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  s = s.replace(/\n/g, '<br>');

  s = s.replace(/\u0000C(\d+)\u0000/g, (m, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  s = s.replace(/\u0000M(\d+)\u0000/g, (m, i) => escapeHtml(store[+i]));
  return s;
}

const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function renderMarkdown(src) {
  const store = [];
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // blok kode berpagar (boleh belum ditutup saat streaming)
    const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      const lang = fence[1] || 'teks';
      out.push(
        `<div class="codeblock"><div class="codehead"><span>${escapeHtml(lang)}</span>` +
        `<button class="copy-code" type="button">Salin</button></div>` +
        `<pre><code>${escapeHtml(buf.join('\n'))}</code></pre></div>`
      );
      continue;
    }

    if (!line.trim()) { i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const n = Math.min(h[1].length + 1, 6);
      out.push(`<h${n}>${inline(h[2], store)}</h${n}>`);
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // tabel
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      let t = '<div class="tablewrap"><table><thead><tr>' +
        head.map((c) => `<th>${inline(c, store)}</th>`).join('') + '</tr></thead><tbody>';
      for (const r of rows) t += '<tr>' + head.map((_, k) => `<td>${inline(r[k] ?? '', store)}</td>`).join('') + '</tr>';
      out.push(t + '</tbody></table></div>');
      continue;
    }

    // daftar
    const ul = /^\s*[-*+]\s+/;
    const ol = /^\s*\d+[.)]\s+/;
    if (ul.test(line) || ol.test(line)) {
      const ordered = ol.test(line);
      const re = ordered ? ol : ul;
      const items = [];
      while (i < lines.length && (re.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (re.test(lines[i])) items.push(lines[i].replace(re, ''));
        else items[items.length - 1] += '\n' + lines[i].trim();
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map((t) => `<li>${inline(t, store)}</li>`).join('') + `</${tag}>`);
      continue;
    }

    // paragraf
    const buf = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^\s*```/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) && !ul.test(lines[i]) && !ol.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) buf.push(lines[i++]);
    if (!buf.length) { buf.push(lines[i++]); }
    out.push(`<p>${inline(buf.join('\n'), store)}</p>`);
  }
  return out.join('');
}
