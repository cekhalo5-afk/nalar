// Mesin model AI: WebLLM (MLC) menjalankan model open-source langsung di GPU browser HP (WebGPU).
// Tidak ada server, tidak ada API key. Bobot model diunduh sekali dari Hugging Face lalu disimpan di cache browser.
const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.79';

export const MODELS = [
  { base: 'Qwen2.5-0.5B-Instruct', label: 'Qwen2.5 0.5B', note: 'Sangat ringan · unduhan ± 0,4 GB · kualitas terbatas' },
  { base: 'Qwen2.5-1.5B-Instruct', label: 'Qwen2.5 1.5B', note: 'Seimbang · unduhan ± 1 GB · disarankan' },
  { base: 'Llama-3.2-1B-Instruct', label: 'Llama 3.2 1B', note: 'Ringan · unduhan ± 0,8 GB' },
  { base: 'Qwen2.5-3B-Instruct', label: 'Qwen2.5 3B', note: 'Lebih pintar · unduhan ± 2 GB · butuh RAM/GPU besar' },
  { base: 'Llama-3.2-3B-Instruct', label: 'Llama 3.2 3B', note: 'Lebih pintar · unduhan ± 2 GB · butuh RAM/GPU besar' },
];

let lib = null;
let engine = null;
let loadedBase = null;

export const ready = () => !!engine;
export const loadedModel = () => loadedBase;

export async function detect() {
  if (!('gpu' in navigator)) {
    return { ok: false, reason: 'Browser ini tidak mendukung WebGPU. Gunakan Chrome Android versi terbaru.' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'WebGPU tersedia tetapi tidak ada GPU yang bisa dipakai di perangkat ini.' };
    return { ok: true, f16: adapter.features.has('shader-f16') };
  } catch (e) {
    return { ok: false, reason: 'Gagal mengakses WebGPU: ' + (e.message || e) };
  }
}

async function getLib() {
  if (!lib) lib = await import(/* @vite-ignore */ WEBLLM_URL);
  return lib;
}

export async function loadModel(base, { onProgress, useWorker = false } = {}) {
  const gpu = await detect();
  if (!gpu.ok) throw new Error(gpu.reason);
  const L = await getLib();
  const id = `${base}-${gpu.f16 ? 'q4f16_1' : 'q4f32_1'}-MLC`;
  const known = (L.prebuiltAppConfig?.model_list || []).some((m) => m.model_id === id);
  if (!known) throw new Error(`Model "${id}" tidak tersedia di versi WebLLM yang dipakai. Pilih model lain.`);
  const initProgressCallback = (r) => onProgress && onProgress(r.progress ?? 0, r.text || '');
  engine = null;
  loadedBase = null;
  let e;
  if (useWorker) {
    e = await L.CreateWebWorkerMLCEngine(new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }), id, { initProgressCallback });
  } else {
    e = await L.CreateMLCEngine(id, { initProgressCallback });
  }
  engine = e;
  loadedBase = base;
  return id;
}

export async function* generate(messages, { temperature = 0.5, max_tokens = 1024 } = {}) {
  if (!engine) throw new Error('Model belum dimuat.');
  const stream = await engine.chat.completions.create({
    messages, stream: true, temperature, top_p: 0.9, max_tokens,
  });
  for await (const chunk of stream) {
    const d = chunk.choices?.[0]?.delta?.content;
    if (d) yield d;
  }
}

export function stop() {
  try { engine && engine.interruptGenerate(); } catch (e) { /* abaikan */ }
}
