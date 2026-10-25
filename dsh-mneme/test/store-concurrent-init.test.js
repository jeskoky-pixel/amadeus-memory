import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { assertIsolatedMemoryDir } from "../src/qa-guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", ".test-tmp");
mkdirSync(ROOT, { recursive: true });

function waitReady(worker) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message.ready) { cleanup(); resolve(); }
    };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}
function waitResult(worker) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (!message.ready) { cleanup(); resolve(message); }
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code) => {
      if (code !== 0) { cleanup(); reject(new Error(`store-init worker exited ${code}`)); }
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

test("concurrent fresh-DB initialization converges under WAL/schema setup", async () => {
  const memoryDir = assertIsolatedMemoryDir(join(ROOT, `concurrent-init-${process.pid}-${Date.now()}`), { qaRoot: ROOT });
  try {
    for (let round = 0; round < 4; round += 1) {
      const path = join(memoryDir, `round-${round}.db`);
      const barrier = new SharedArrayBuffer(4);
      const workers = Array.from({ length: 8 }, () => new Worker(
        new URL("./helpers/store-init-worker.mjs", import.meta.url),
        { workerData: { path, barrier } }
      ));
      try {
        await Promise.all(workers.map(waitReady));
        const resultPromises = workers.map(waitResult);
        Atomics.store(new Int32Array(barrier), 0, 1);
        Atomics.notify(new Int32Array(barrier), 0, workers.length);
        const results = await Promise.all(resultPromises);
        for (const result of results) {
          assert.equal(result.ok, true, JSON.stringify({ round, result }));
        }
      } finally {
        await Promise.all(workers.map((worker) => worker.terminate()));
      }
    }
  } finally {
    rmSync(memoryDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
