// Alat pendukung: riset (Wikipedia), pemrosesan dokumen, pemilihan potongan relevan.

const STOP = new Set((
  'yang dan di ke dari untuk dengan pada adalah itu ini atau juga akan oleh dalam tidak saya kamu apa ' +
  'bagaimana mengapa kenapa siapa kapan dimana apakah dapat bisa ada the a an of to in is are was were ' +
  'and or for with on at by from that this what how why who when where can does do'
).split(' '));

export function tokenize(text) {
  return String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));
}

export function chunkText(text, size = 900) {
  const paras = String(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
  for (const p of paras) {
    if (p.length > size * 1.5) {
      push();
      for (let k = 0; k < p.length; k += size) chunks.push(p.slice(k, k + size));
      continue;
    }
    if ((cur + '\n\n' + p).length > size) push();
    cur += (cur ? '\n\n' : '') + p;
  }
  push();
  return chunks;
}

// Jika dokumen kecil, kirim utuh. Jika besar, ambil potongan yang paling cocok dengan pertanyaan.
export function pickChunks(text, query, budget = 3500) {
  if (text.length <= budget) return text;
  const chunks = chunkText(text);
  const q = [...new Set(tokenize(query))];
  const scored = chunks.map((c, idx) => {
    const lc = c.toLowerCase();
    let score = 0;
    for (const t of q) {
      let n = 0, pos = 0;
      while ((pos = lc.indexOf(t, pos)) !== -1) { n++; pos += t.length; }
      if (n) score += 1 + Math.log(n);
    }
    return { c, idx, score };
  });
  const ranked = scored.some((s) => s.score > 0)
    ? [...scored].sort((a, b) => b.score - a.score || a.idx - b.idx)
    : scored; // tanpa kecocokan: ambil dari awal dokumen
  const chosen = [];
  let used = 0;
  for (const s of ranked) {
    if (used + s.c.length > budget && chosen.length) continue;
    chosen.push(s);
    used += s.c.length;
    if (used >= budget) break;
  }
  chosen.sort((a, b) => a.idx - b.idx);
  return chosen.map((s) => s.c).join('\n[…]\n');
}

async function fetchJson(url, ms = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Pencarian nyata ke Wikipedia (gratis, tanpa API key). BUKAN pencarian seluruh web.
export async function researchWikipedia(query, { langs = ['id', 'en'], perLang = 3 } = {}) {
  const q = String(query).replace(/\s+/g, ' ').trim().slice(0, 200);
  const results = await Promise.all(langs.map(async (lang) => {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*` +
      `&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=${perLang}` +
      `&prop=extracts%7Cinfo&exintro=1&explaintext=1&exchars=1200&exlimit=max&inprop=url`;
    try {
      const data = await fetchJson(url);
      const pages = Object.values(data?.query?.pages || {}).sort((a, b) => a.index - b.index);
      return pages
        .filter((p) => p.extract && p.fullurl)
        .map((p) => ({ title: p.title, url: p.fullurl, extract: p.extract.trim(), lang }));
    } catch (e) {
      return [];
    }
  }));
  const seen = new Set();
  const merged = [];
  const max = Math.max(...results.map((r) => r.length), 0);
  for (let k = 0; k < max; k++) {
    for (const r of results) {
      const p = r[k];
      if (p && !seen.has(p.url)) { seen.add(p.url); merged.push(p); }
    }
  }
  return merged.slice(0, 4);
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('Gagal memuat ' + src));
    document.head.appendChild(s);
  });
}

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';

export async function readFileText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    if (!window.pdfjsLib) await loadScript(PDFJS + 'pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
    const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = Math.min(pdf.numPages, 200);
    let text = '';
    for (let p = 1; p <= pages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      text += tc.items.map((it) => it.str).join(' ') + '\n\n';
    }
    if (text.replace(/\s/g, '').length < 20) {
      throw new Error('PDF ini tampak berupa gambar hasil pindai (tanpa teks). OCR belum didukung.');
    }
    return { text, note: pdf.numPages > pages ? `Hanya ${pages} halaman pertama dibaca.` : '' };
  }
  const text = await file.text();
  if (text.includes('\u0000')) throw new Error('Berkas ini tampaknya biner, bukan teks. Gunakan TXT, MD, CSV, JSON, kode, atau PDF.');
  return { text, note: '' };
}
