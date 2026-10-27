// Internal background-conversion Scene job contract.
//
// This is NOT a model/HTTP capability. Only the plugin's own schedulers create
// a job scope after reading the persisted scene_scope of the rows they are
// about to process. The scope is carried through AsyncLocalStorage so the
// existing Dream/Sleep code can stay synchronous-looking while every service
// read/write is constrained to exactly one Scene (or the legacy null bucket).
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

// Sentinel for the NULL scene_scope bucket. It must never collide with a real
// persisted scene id such as the literal string "legacy"; only the scheduler
// maps store.listSceneScopes().null_scope to this value.
export const LEGACY_SCENE_JOB = "\u0000dsh-mneme:legacy-null";

export function runWithSceneJob(sceneScope, fn) {
  const value = sceneScope === LEGACY_SCENE_JOB || sceneScope == null
    ? LEGACY_SCENE_JOB
    : String(sceneScope);
  if (!value) throw new Error("SCENE_JOB_REQUIRED");
  return storage.run({ sceneScope: value }, fn);
}

export function currentSceneJob() {
  return storage.getStore() ?? null;
}

export function sceneJobScopes() {
  const job = currentSceneJob();
  if (!job) return null;
  // The SQL layer uses "legacy" for NULL. A real persisted scene named
  // "legacy" is wrapped so it cannot be mistaken for the NULL bucket.
  if (job.sceneScope === LEGACY_SCENE_JOB) return [LEGACY_SCENE_JOB];
  if (job.sceneScope === "legacy") return [{ realScope: "legacy" }];
  return [job.sceneScope];
}

export function sceneJobMatches(row) {
  const job = currentSceneJob();
  if (!job) return true;
  return job.sceneScope === LEGACY_SCENE_JOB
    ? (row?.scene_scope ?? null) === null
    : row?.scene_scope === job.sceneScope;
}

export function sceneJobEquals(sceneScope) {
  const job = currentSceneJob();
  if (!job) return true;
  return job.sceneScope === LEGACY_SCENE_JOB
    ? (sceneScope ?? null) === null
    : sceneScope === job.sceneScope;
}

// Preserve the original cancellation contract: an aborted Sleep round is never
// reported as a completed success just because an earlier Scene finished.
export function scopedSleepOutcome({ last, ok, processed, total, aborted }) {
  if (aborted) {
    return {
      ...(last ?? {}),
      ok: false,
      status: "aborted",
      reason: "user activity",
      processed,
      total_scenes: total
    };
  }
  return { ...(last ?? {}), ok };
}
