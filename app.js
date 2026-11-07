import { renderMarkdown } from './md.js';
import * as Engine from './engine.js';
import { researchWikipedia, pickChunks, readFileText } from './tools.js';

const APP_VERSION = '1.0.0';
const $ = (s) => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const MODES = {
  umum: { label: '💬 Umum', ph: 'Tulis pesan…', rule: 'Mode: tanya jawab umum.' },
  riset: {
    label: '🔎 Riset', ph: 'Tulis pertanyaan riset…',
    rule: 'Mode: riset. Pesan pengguna berisi daftar SUMBER bernomor dari Wikipedia. Jawab HANYA berdasarkan sumber itu dan rujuk dengan [1], [2]. Jika sumber kurang atau tidak relevan, katakan terus terang. Sebutkan bila sumber saling berbeda. Jangan menambahkan tautan sendiri.',
  },
  menulis: {
    label: '✍️ Menulis', ph: 'Apa yang ingin ditulis?',
    rule: 'Mode: asisten menulis (cerita, artikel, esai, surat, naskah, ringkasan, perbaikan tata bahasa, ubah gaya). Tulis jernih dan rapi. Jika nada, panjang, atau pembaca belum jelas dan penting, tanyakan singkat atau nyatakan asumsimu.',
  },
  koding: {
    label: '💻 Koding', ph: 'Tanya soal kode atau tempel error…',
    rule: 'Mode: asisten koding. Berikan kode lengkap (tidak terpotong) dalam blok kode berlabel bahasa. Kamu TIDAK dapat menjalankan kode, jadi jangan pernah mengklaim kode sudah diuji; sebutkan bahwa pengguna perlu mengujinya.',
  },
  dokumen: {
    label: '📄 Dokumen', ph: 'Tanya tentang dokumen yang diunggah…',
    rule: 'Mode: analisis dokumen. Jawab berdasarkan DOKUMEN yang diberikan. Pisahkan dengan jelas apa yang ada di dokumen dan apa yang berasal dari pengetahuan umum. Jika jawabannya tidak ada di bagian dokumen yang diberikan, katakan. Bagian yang diberikan mungkin hanya potongan dokumen.',
  },
};

const S = {
  chats: [], cur: null, memory: [],
  settings: { theme: 'auto', lang: 'auto', font: '16', temp: 0.5, model: 'Qwen2.5-1.5B-Instruct', worker: false },
  generating: false, gpu: null, loading: false,
};

/* ---------- Penyimpanan (IndexedDB) ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res) => {
      try {
        const r = indexedDB.open('nalar', 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('chats', { keyPath: 'id' });
          r.result.createObjectStore('memory', { keyPath: 'id' });
        };
        r.onsuccess = () => { this.db = r.result; res(true); };
        r.onerror = () => res(false);
      } catch (e) { res(false); }
    });
  },
  tx(store, mode, fn) {
    if (!this.db) return Promise.resolve(mode === 'readonly' ? [] : undefined);
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => res(r && r.result);
      t.onerror = t.onabort = () => rej(t.error);
    });
  },
  all: (s) => DB.tx(s, 'readonly', (st) => st.getAll()),
  put: (s, o) => DB.tx(s, 'readwrite', (st) => st.put(o)),
  del: (s, id) => DB.tx(s, 'readwrite', (st) => st.delete(id)),
  clear: (s) => DB.tx(s, 'readwrite', (st) => st.clear()),
};

function loadSettings() {
  try { Object.assign(S.settings, JSON.parse(localStorage.getItem('nalar.settings') || '{}')); } catch (e) { /* abaikan */ }
}
const saveSettings = () => { try { localStorage.setItem('nalar.settings', JSON.stringify(S.settings)); } catch (e) { /* abaikan */ } };

function applyTheme() {
  document.documentElement.dataset.theme = S.settings.theme;
  document.documentElement.style.setProperty('--fs', S.settings.font + 'px');
  const dark = S.settings.theme === 'dark' || (S.settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name=theme-color]').content = dark ? '#171a19' : '#faf9f6';
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), ms);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Tersalin'); return; } catch (e) { /* fallback */ }
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); toast('Tersalin'); } catch (e) { toast('Gagal menyalin'); }
  ta.remove();
}

/* ---------- Percakapan ---------- */
function newChat(mode = 'umum') {
  if (S.generating) return toast('Tunggu atau hentikan jawaban yang sedang berjalan.');
  S.cur = { id: uid(), title: 'Percakapan baru', created: Date.now(), updated: Date.now(), mode, doc: null, messages: [] };
  renderAll();
}

async function saveChat(chat) {
  chat.updated = Date.now();
  if (!S.chats.includes(chat)) S.chats.unshift(chat);
  const clean = JSON.parse(JSON.stringify(chat));
  clean.messages.forEach((m) => delete m.status);
  try { await DB.put('chats', clean); } catch (e) { toast('Gagal menyimpan percakapan'); }
  renderHistory();
}

function openChat(id) {
  if (S.generating) return toast('Tunggu atau hentikan jawaban yang sedang berjalan.');
  const c = S.chats.find((x) => x.id === id);
  if (c) { S.cur = c; renderAll(); closeSidebar(); }
}

async function deleteChat(id) {
  if (S.generating) return toast('Tunggu atau hentikan jawaban yang sedang berjalan.');
  if (!confirm('Hapus percakapan ini?')) return;
  S.chats = S.chats.filter((c) => c.id !== id);
  await DB.del('chats', id);
  if (S.cur && S.cur.id === id) newChat();
  else renderHistory();
}

/* ---------- Render ---------- */
function greeting() {
  const h = new Date().getHours();
  const s = h < 11 ? 'Selamat pagi' : h < 15 ? 'Selamat siang' : h < 18 ? 'Selamat sore' : 'Selamat malam';
  return s + '!';
}

function renderHistory() {
  const q = $('#search').value.trim().toLowerCase();
  const box = $('#history');
  box.innerHTML = '';
  const list = [...S.chats].sort((a, b) => b.updated - a.updated)
    .filter((c) => !q || c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)));
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = q ? 'Tidak ada hasil.' : 'Belum ada percakapan.';
    box.appendChild(d);
    return;
  }
  for (const c of list) {
    const row = document.createElement('div');
    row.className = 'hitem' + (S.cur && S.cur.id === c.id ? ' active' : '');
    const b = document.createElement('button');
    b.className = 'open'; b.type = 'button'; b.textContent = c.title;
    b.onclick = () => openChat(c.id);
    const d = document.createElement('button');
    d.className = 'del'; d.type = 'button'; d.textContent = '🗑'; d.setAttribute('aria-label', 'Hapus');
    d.onclick = () => deleteChat(c.id);
    row.append(b, d);
    box.appendChild(row);
  }
}

function renderModebar() {
  const bar = $('#modebar');
  bar.innerHTML = '';
  for (const [k, v] of Object.entries(MODES)) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = v.label;
    if (S.cur.mode === k) b.className = 'on';
    b.onclick = () => setMode(k);
    bar.appendChild(b);
  }
  $('#input').placeholder = MODES[S.cur.mode].ph;
}

function setMode(mode) {
  S.cur.mode = mode;
  renderModebar();
  if (S.cur.messages.length) saveChat(S.cur);
}

function renderDocPill() {
  const d = S.cur.doc;
  $('#docPill').hidden = !d;
  if (d) $('#docName').textContent = `📄 ${d.name} (${d.text.length.toLocaleString('id-ID')} karakter)`;
}

function renderAll() {
  const box = $('#messages');
  box.innerHTML = '';
  $('#chatTitle').textContent = S.cur.messages.length ? S.cur.title : 'Nalar';
  if (!S.cur.messages.length) {
    box.appendChild($('#welcomeTpl').content.cloneNode(true));
    $('#greeting').textContent = greeting();
    bindWelcome();
  } else {
    S.cur.messages.forEach((m, i) => box.appendChild(msgEl(m, i === S.cur.messages.length - 1)));
    typeset(box);
  }
  renderModebar();
  renderDocPill();
  renderHistory();
  box.scrollTop = box.scrollHeight;
}

function msgEl(m, isLast) {
  const w = document.createElement('div');
  w.className = 'msg ' + (m.role === 'user' ? 'user' : 'ai');
  w.dataset.id = m.id;
  fillMsg(w, m, isLast);
  return w;
}

function actionBtn(label, fn, on) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label; if (on) b.className = 'on';
  b.onclick = fn;
  return b;
}

function fillMsg(w, m, isLast) {
  w.innerHTML = '';
  const actions = document.createElement('div');
  actions.className = 'actions';
  if (m.role === 'user') {
    const b = document.createElement('div');
    b.className = 'bubble'; b.textContent = m.content;
    w.appendChild(b);
    actions.append(
      actionBtn('Salin', () => copyText(m.content)),
      actionBtn('Ingat', () => {
        if (confirm('Simpan teks pesan ini ke Memori? Isinya akan disertakan ke AI di semua percakapan.')) addMemory(m.content.slice(0, 300));
      }),
    );
    w.appendChild(actions);
    return;
  }
  const body = document.createElement('div');
  body.className = 'body';
  w.appendChild(body);
  paintBody(body, m);
  if (m.sources && m.sources.length) {
    const s = document.createElement('div');
    s.className = 'sources';
    const ol = m.sources.filter((x) => /^https:\/\//.test(x.url)).map((x) => `<li><a href="${x.url.replace(/["'<>]/g, encodeURIComponent)}" target="_blank" rel="noopener noreferrer">${escapeText(x.title)}</a> <span class="muted">(Wikipedia ${x.lang})</span></li>`).join('');
    s.innerHTML = `<b>Sumber yang dipakai</b><ol>${ol}</ol><div class="note">Hasil pencarian otomatis di Wikipedia; relevansi dan keakuratan tidak dijamin. Periksa sendiri sumbernya.</div>`;
    w.appendChild(s);
  }
  if (m.stopped) { const n = document.createElement('div'); n.className = 'note'; n.textContent = 'Generasi dihentikan.'; w.appendChild(n); }
  if (m.error) { const e = document.createElement('div'); e.className = 'err'; e.textContent = m.error; w.appendChild(e); }
  if (m.content) actions.appendChild(actionBtn('Salin', () => copyText(m.content)));
  if (isLast && !S.generating) actions.appendChild(actionBtn('↻ Ulangi', () => regenerate()));
  if (m.content) {
    actions.appendChild(actionBtn('👍', () => feedback(m, 'up'), m.fb === 'up'));
    actions.appendChild(actionBtn('👎', () => feedback(m, 'down'), m.fb === 'down'));
  }
  w.appendChild(actions);
}

function escapeText(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function paintBody(body, m) {
  if (m.content) body.innerHTML = renderMarkdown(m.content);
  else if (S.generating) body.innerHTML = `<div class="typing"><i></i><i></i><i></i></div>${m.status ? `<div class="status">${escapeText(m.status)}</div>` : ''}`;
  else body.innerHTML = '';
}

async function feedback(m, v) {
  m.fb = m.fb === v ? undefined : v;
  await saveChat(S.cur);
  renderAll();
  toast('Umpan balik disimpan di perangkat ini saja.');
}

/* ---------- Rumus matematika (KaTeX dimuat saat dibutuhkan) ---------- */
let katexState = null;
function addTag(tag, attrs) {
  return new Promise((res, rej) => {
    const e = document.createElement(tag);
    Object.assign(e, attrs);
    e.onload = res; e.onerror = () => rej(new Error('gagal memuat'));
    document.head.appendChild(e);
  });
}
async function typeset(el) {
  const t = el.textContent || '';
  if (!/\$\$|\\\(|\\\[|\$[^\s$][^$]*\$/.test(t)) return;
  try {
    if (!katexState) {
      const base = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/';
      katexState = (async () => {
        await addTag('link', { rel: 'stylesheet', href: base + 'katex.min.css' });
        await addTag('script', { src: base + 'katex.min.js' });
        await addTag('script', { src: base + 'contrib/auto-render.min.js' });
      })();
    }
    await katexState;
    window.renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false }, { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
      ignoredTags: ['script', 'style', 'textarea', 'pre', 'code'],
    });
  } catch (e) { katexState = null; /* tanpa internet: rumus tampil sebagai teks mentah */ }
}

/* ---------- Prompt ---------- */
function systemPrompt(chat) {
  const lang = S.settings.lang === 'id' ? 'Selalu jawab dalam Bahasa Indonesia.'
    : S.settings.lang === 'en' ? 'Always answer in English.' : 'Jawab dalam bahasa yang dipakai pengguna.';
  const mem = S.memory.length ? '\nMemori yang disimpan pengguna sendiri:\n' + S.memory.map((x) => '- ' + x.text).join('\n') : '';
  return [
    `Kamu adalah Nalar, asisten AI serbaguna yang berjalan sepenuhnya di perangkat pengguna memakai model bahasa kecil (${Engine.loadedModel() || 'tidak diketahui'}). Kamu bisa keliru.`,
    'Aturan:',
    '- Jangan mengarang fakta, angka, kutipan, sumber, atau tautan. Jika tidak tahu atau tidak yakin, katakan terus terang.',
    '- Bedakan fakta, kesimpulan dari analisis, dan dugaan. Jangan mengubah dugaan menjadi fakta.',
    '- Pengetahuanmu berasal dari data pelatihan dan bisa usang. Kamu tidak punya akses internet kecuali ada SUMBER yang dicantumkan di pesan pengguna. Jangan berpura-pura sudah mencari di internet.',
    '- Jika permintaan ambigu dalam hal penting, ajukan satu pertanyaan klarifikasi singkat.',
    '- Untuk soal rumit, uraikan langkah penalaran secara ringkas, lalu beri kesimpulan. Jangan memperpanjang jawaban tanpa alasan.',
    '- Gunakan Markdown seperlunya.',
    lang,
    MODES[chat.mode].rule,
    mem,
  ].join('\n');
}

const BUDGET = 9000; // karakter prompt (± 2.500 token) agar muat di konteks 4096 token model kecil

function buildMessages(chat, sources) {
  const sys = systemPrompt(chat);
  const hist = chat.messages.slice(0, -1).filter((m) => m.content);
  const last = hist[hist.length - 1];
  let ctx = '';
  if (chat.doc) ctx += `[DOKUMEN: ${chat.doc.name}]\n${pickChunks(chat.doc.text, last.content, 3500)}\n[AKHIR DOKUMEN]\n\n`;
  if (sources && sources.length) {
    ctx += 'SUMBER (Wikipedia):\n' + sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}\n${s.extract.slice(0, 900)}`).join('\n\n') + '\n\n';
  }
  let userText = last.content;
  const room = BUDGET - sys.length - ctx.length - 200;
  if (userText.length > room) {
    userText = userText.slice(0, Math.max(room, 500)) + '\n[…dipotong karena melebihi batas konteks model]';
    toast('Pesan terlalu panjang, sebagian dipotong agar muat di konteks model.', 4000);
  }
  const finalUser = ctx ? `${ctx}Permintaan pengguna:\n${userText}` : userText;
  let remaining = BUDGET - sys.length - finalUser.length;
  const older = [];
  for (let k = hist.length - 2; k >= 0; k--) {
    const c = hist[k].content;
    if (c.length > remaining) break;
    older.unshift({ role: hist[k].role, content: c });
    remaining -= c.length;
  }
  return [{ role: 'system', content: sys }, ...older, { role: 'user', content: finalUser }];
}

/* ---------- Kirim & jawab ---------- */
async function send(text) {
  if (S.generating) return;
  text = text.trim();
  if (!text) return;
  const chat = S.cur;
  if (chat.mode === 'dokumen' && !chat.doc) {
    toast('Unggah dokumen dulu dengan tombol 📎.');
    return;
  }
  if (!chat.messages.length) chat.title = text.replace(/\s+/g, ' ').slice(0, 48);
  chat.messages.push({ id: uid(), role: 'user', content: text, ts: Date.now() });
  $('#input').value = '';
  autoGrow();
  await saveChat(chat);
  await respond(chat);
}

async function regenerate() {
  if (S.generating) return;
  const chat = S.cur;
  while (chat.messages.length && chat.messages[chat.messages.length - 1].role === 'assistant') chat.messages.pop();
  if (!chat.messages.length) return;
  await respond(chat);
}

function setGenerating(v) {
  S.generating = v;
  $('#btnSend').hidden = v;
  $('#btnStop').hidden = !v;
}

async function respond(chat) {
  const ai = { id: uid(), role: 'assistant', content: '', ts: Date.now(), status: 'Menyiapkan jawaban…' };
  chat.messages.push(ai);
  setGenerating(true);
  renderAll();
  const box = $('#messages');
  const wrap = box.querySelector(`[data-id="${ai.id}"]`);
  const body = wrap.querySelector('.body');
  const userMsg = chat.messages[chat.messages.length - 2];
  let raf = 0;
  const repaint = () => {
    raf = 0;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    paintBody(body, ai);
    if (near) box.scrollTop = box.scrollHeight;
  };
  try {
    let sources = null;
    if (chat.mode === 'riset') {
      ai.status = 'Mencari di Wikipedia…';
      repaint();
      sources = await researchWikipedia(userMsg.content);
      if (!sources.length) {
        ai.content = 'Saya tidak menemukan artikel Wikipedia yang cocok untuk pertanyaan ini (atau pencarian gagal karena koneksi). Karena itu saya tidak menyusun jawaban riset. Coba ubah kata kunci, atau gunakan mode Umum, dengan catatan jawabannya hanya dari pengetahuan model yang bisa keliru atau usang.';
        return;
      }
      ai.sources = sources;
    }
    if (!Engine.ready()) {
      if (sources) {
        ai.content = 'Sumber berhasil ditemukan (lihat daftar di bawah), tetapi model AI belum dimuat sehingga saya belum bisa merangkumnya. Muat model lewat tombol di kanan atas, lalu tekan Ulangi.';
      } else {
        chat.messages.pop();
        setGenerating(false);
        renderAll();
        toast('Muat model AI dulu.');
        openModelDialog();
        return;
      }
      return;
    }
    ai.status = 'Model sedang berpikir…';
    repaint();
    const msgs = buildMessages(chat, sources);
    for await (const d of Engine.generate(msgs, { temperature: +S.settings.temp, max_tokens: 1024 })) {
      ai.content += d;
      if (!raf) raf = requestAnimationFrame(repaint);
    }
    if (!ai.content.trim()) ai.content = '(Model tidak menghasilkan jawaban. Coba lagi atau ubah pertanyaan.)';
  } catch (e) {
    const msg = String(e && e.message || e);
    ai.error = /context|token|exceed/i.test(msg)
      ? 'Percakapan melebihi batas konteks model. Mulai percakapan baru atau kirim pesan lebih pendek.'
      : 'Terjadi kesalahan: ' + msg;
  } finally {
    if (raf) cancelAnimationFrame(raf);
    setGenerating(false);
    delete ai.status;
    if (S.stopRequested) { ai.stopped = true; S.stopRequested = false; }
    if (!ai.content && !ai.error && !ai.sources) chat.messages.pop();
    await saveChat(chat);
    if (S.cur === chat) { renderAll(); }
  }
}

function stopGeneration() {
  S.stopRequested = true;
  Engine.stop();
}

/* ---------- Dokumen ---------- */
async function attach(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) return toast('Berkas terlalu besar (maks 25 MB).');
  toast('Membaca ' + file.name + '…', 6000);
  try {
    const { text, note } = await readFileText(file);
    S.cur.doc = { name: file.name, text: text.slice(0, 1500000) };
    S.cur.mode = 'dokumen';
    if (S.cur.messages.length) await saveChat(S.cur);
    renderModebar();
    renderDocPill();
    toast(note || 'Dokumen siap. Silakan bertanya.');
    $('#input').focus();
  } catch (e) {
    toast(e.message || 'Gagal membaca berkas', 5000);
  }
}

/* ---------- Memori ---------- */
async function addMemory(text) {
  text = text.trim();
  if (!text) return;
  const item = { id: uid(), text, ts: Date.now() };
  S.memory.push(item);
  await DB.put('memory', item);
  renderMemory();
  toast('Disimpan ke memori');
}
function renderMemory() {
  const box = $('#memList');
  box.innerHTML = '';
  if (!S.memory.length) { box.innerHTML = '<div class="empty">Belum ada memori.</div>'; return; }
  for (const m of S.memory) {
    const row = document.createElement('div');
    row.className = 'mem';
    const sp = document.createElement('span'); sp.textContent = m.text;
    const ed = document.createElement('button'); ed.type = 'button'; ed.textContent = 'Ubah';
    ed.onclick = async () => {
      const v = prompt('Ubah memori:', m.text);
      if (v !== null && v.trim()) { m.text = v.trim().slice(0, 300); await DB.put('memory', m); renderMemory(); }
    };
    const dl = document.createElement('button'); dl.type = 'button'; dl.textContent = 'Hapus';
    dl.onclick = async () => { S.memory = S.memory.filter((x) => x.id !== m.id); await DB.del('memory', m.id); renderMemory(); };
    row.append(sp, ed, dl);
    box.appendChild(row);
  }
}

/* ---------- Model ---------- */
function updateChip() {
  const c = $('#modelChip');
  const base = Engine.loadedModel();
  if (base) {
    c.textContent = 'Model: ' + (Engine.MODELS.find((m) => m.base === base)?.label || base);
    c.classList.add('ok');
  } else {
    c.classList.remove('ok');
    c.textContent = S.gpu && !S.gpu.ok ? 'Tanpa WebGPU' : 'Model: belum dimuat';
  }
}

async function openModelDialog() {
  const list = $('#modelList');
  list.innerHTML = '';
  for (const m of Engine.MODELS) {
    const l = document.createElement('label');
    l.className = 'radio';
    l.innerHTML = `<input type="radio" name="mdl" value="${m.base}"${S.settings.model === m.base ? ' checked' : ''}><span>${m.label}<small>${m.note}</small></span>`;
    list.appendChild(l);
  }
  const st = $('#gpuStatus');
  st.style.color = '';
  if (!S.gpu) S.gpu = await Engine.detect();
  st.textContent = S.gpu.ok
    ? 'WebGPU didukung perangkat ini. Pilih model lalu unduh.'
    : S.gpu.reason + ' Tanpa WebGPU, chat AI tidak bisa dijalankan; mode Riset tetap menampilkan sumber Wikipedia.';
  $('#btnLoad').disabled = !S.gpu.ok || S.loading;
  updateChip();
  $('#dlgModel').showModal();
}

async function loadSelectedModel() {
  const sel = document.querySelector('input[name=mdl]:checked');
  if (!sel || S.loading) return;
  S.settings.model = sel.value;
  saveSettings();
  S.loading = true;
  $('#btnLoad').disabled = true;
  $('#progressWrap').hidden = false;
  $('#bar').style.width = '0%';
  const st = $('#gpuStatus');
  st.style.color = '';
  try {
    await Engine.loadModel(sel.value, {
      useWorker: !!S.settings.worker,
      onProgress: (p, text) => {
        $('#bar').style.width = Math.round(p * 100) + '%';
        $('#progressText').textContent = text;
      },
    });
    $('#dlgModel').close();
    toast('Model siap dipakai');
  } catch (e) {
    st.style.color = 'var(--danger)';
    st.textContent = 'Gagal memuat model: ' + (e.message || e);
  } finally {
    S.loading = false;
    $('#btnLoad').disabled = !(S.gpu && S.gpu.ok);
    updateChip();
  }
}

/* ---------- UI umum ---------- */
function openSidebar() { $('#sidebar').classList.add('open'); $('#scrim').classList.add('show'); }
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show'); }

function autoGrow() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 140) + 'px';
}

function bindWelcome() {
  document.querySelectorAll('#welcome .shortcuts button').forEach((b) => {
    b.onclick = () => {
      setMode(b.dataset.mode);
      if (b.dataset.prompt) $('#input').value = b.dataset.prompt;
      if (b.dataset.attach) $('#file').click();
      else $('#input').focus();
      autoGrow();
    };
  });
}

async function exportData() {
  const data = { app: 'Nalar', version: APP_VERSION, exported: new Date().toISOString(), chats: S.chats, memory: S.memory };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'nalar-data.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function clearChats() {
  if (!confirm('Hapus SEMUA riwayat percakapan di perangkat ini?')) return;
  await DB.clear('chats');
  S.chats = [];
  S.generating = false;
  newChat();
  toast('Riwayat dihapus');
}

async function clearAll() {
  if (!confirm('Hapus SEMUA data (riwayat, memori, pengaturan, dan model yang diunduh)? Model harus diunduh ulang.')) return;
  await DB.clear('chats'); await DB.clear('memory');
  S.chats = []; S.memory = [];
  try { localStorage.removeItem('nalar.settings'); } catch (e) { /* abaikan */ }
  try { for (const k of await caches.keys()) if (/webllm|nalar/i.test(k)) await caches.delete(k); } catch (e) { /* abaikan */ }
  toast('Semua data dihapus. Muat ulang halaman untuk mengosongkan model dari memori.', 5000);
  newChat();
  renderMemory();
}

function bindUI() {
  $('#btnMenu').onclick = openSidebar;
  $('#scrim').onclick = closeSidebar;
  $('#btnNew').onclick = () => { newChat(); closeSidebar(); };
  $('#search').oninput = renderHistory;
  document.querySelectorAll('.modes button').forEach((b) => {
    b.onclick = () => {
      if (S.generating) return toast('Tunggu atau hentikan jawaban yang sedang berjalan.');
      if (S.cur.messages.length) newChat(b.dataset.mode); else setMode(b.dataset.mode);
      if (b.dataset.mode === 'dokumen' && !S.cur.doc) $('#file').click();
      closeSidebar();
    };
  });
  $('#btnSend').onclick = () => send($('#input').value);
  $('#btnStop').onclick = stopGeneration;
  $('#input').addEventListener('input', autoGrow);
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); send($('#input').value); }
  });
  $('#btnAttach').onclick = () => $('#file').click();
  $('#file').onchange = (e) => { attach(e.target.files[0]); e.target.value = ''; };
  $('#docRemove').onclick = () => { S.cur.doc = null; renderDocPill(); if (S.cur.messages.length) saveChat(S.cur); };
  $('#modelChip').onclick = openModelDialog;
  $('#btnLoad').onclick = loadSelectedModel;

  $('#btnSettings').onclick = () => {
    $('#setTheme').value = S.settings.theme; $('#setLang').value = S.settings.lang; $('#setFont').value = S.settings.font;
    $('#setTemp').value = S.settings.temp; $('#tempVal').textContent = S.settings.temp; $('#setWorker').checked = !!S.settings.worker;
    $('#dlgSettings').showModal();
  };
  const bindSet = (id, key, cast = (v) => v) => { $(id).onchange = $(id).oninput = (e) => { S.settings[key] = cast(e.target.type === 'checkbox' ? e.target.checked : e.target.value); saveSettings(); applyTheme(); }; };
  bindSet('#setTheme', 'theme'); bindSet('#setLang', 'lang'); bindSet('#setFont', 'font'); bindSet('#setWorker', 'worker');
  bindSet('#setTemp', 'temp', Number);
  $('#setTemp').addEventListener('input', (e) => { $('#tempVal').textContent = e.target.value; });
  $('#btnExport').onclick = exportData;
  $('#btnClearChats').onclick = clearChats;
  $('#btnClearAll').onclick = clearAll;

  $('#btnMemory').onclick = () => { renderMemory(); $('#dlgMemory').showModal(); };
  $('#memAdd').onclick = () => { addMemory($('#memInput').value); $('#memInput').value = ''; };
  $('#memInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#memAdd').click(); } });
  $('#memClear').onclick = async () => {
    if (!S.memory.length || !confirm('Hapus semua memori?')) return;
    await DB.clear('memory'); S.memory = []; renderMemory();
  };
  $('#btnAbout').onclick = () => { $('#ver').textContent = APP_VERSION; $('#dlgAbout').showModal(); };

  $('#messages').addEventListener('click', (e) => {
    const b = e.target.closest('.copy-code');
    if (b) copyText(b.closest('.codeblock').querySelector('code').textContent);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
}

async function init() {
  loadSettings();
  applyTheme();
  const ok = await DB.open();
  if (!ok) setTimeout(() => toast('Penyimpanan lokal tidak tersedia; riwayat tidak akan tersimpan.', 5000), 500);
  S.chats = (await DB.all('chats')) || [];
  S.chats.forEach((c) => { c.messages = c.messages.filter((m) => m.role === 'user' || m.content || m.sources); });
  S.memory = (await DB.all('memory')) || [];
  bindUI();
  newChat();
  S.gpu = await Engine.detect();
  updateChip();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* PWA opsional */ });
  }
  window.__nalar = { S, MODES }; // untuk debugging
}

init();
