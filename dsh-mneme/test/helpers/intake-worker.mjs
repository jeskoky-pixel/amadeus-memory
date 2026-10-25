// Worker used only to create genuinely overlapping trusted-intake submissions
// on separate SQLite connections. Synthetic data only.
import { parentPort, workerData } from "node:worker_threads";
import { createStore } from "../../src/store.js";
import { createService } from "../../src/service.js";

const store = createStore(workerData.path);
const service = createService({ store, mirror: null, config: { trustedIntakeEnabled: true } });
const barrier = new Int32Array(workerData.barrier);
try {
  parentPort.postMessage({ ready: true });
  Atomics.wait(barrier, 0, 0);
  const result = service.submitTrustedMemory(workerData.payload);
  parentPort.postMessage({
    ok: true,
    memoryId: result.memory.id,
    provenanceId: result.provenance?.id,
    replayed: result.replayed,
    action: result.action
  });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    code: error?.code ?? null,
    error: String(error?.message ?? error)
  });
} finally {
  store.close();
}
