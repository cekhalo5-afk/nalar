// Web Worker untuk WebLLM (opsional, eksperimental). Menjaga UI tetap lancar saat model menghitung.
import { WebWorkerMLCEngineHandler } from 'https://esm.run/@mlc-ai/web-llm@0.2.79';
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
