import { parentPort, workerData } from "node:worker_threads";
import { createStore } from "../../src/store.js";

try {
  parentPort.postMessage({ ready: true });
  const barrier = new Int32Array(workerData.barrier);
  Atomics.wait(barrier, 0, 0);
  const store = createStore(workerData.path);
  store.close();
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, code: error?.code ?? null, error: String(error?.message ?? error) });
}
