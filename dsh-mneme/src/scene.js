// Trusted scene identity and directional read policy.
//
// Trust is an in-process capability, not a JSON flag. Only mintTrustedScene()
// creates a scene object; normalizeScene() accepts only objects from that
// WeakSet. No route or tool accepts a scene from model/API input. A plain
// {verified:true,admin:true} object is ordinary data and is rejected.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();
const trustedScenes = new WeakSet();
let policy = { enabled: false, strictQQ: false, hostContract: false };
const grants = new Map(); // output admin private sceneId -> Set(source sceneId)

function validateSceneInput(scene) {
  if (!scene || typeof scene !== "object") return null;
  const platform = String(scene.platform ?? "").trim().toLowerCase();
  const kind = String(scene.kind ?? "").trim().toLowerCase();
  const id = String(scene.id ?? "").trim();
  if (!["qq", "test"].includes(platform)) return null;
  if (kind !== "group" && kind !== "private") return null;
  if (!id || id.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(id)) return null;
  if (scene.verified !== true) return null;
  return {
    platform,
    kind,
    id,
    verified: true,
    admin: kind === "private" && scene.admin === true,
    sceneId: `${platform}:${kind}:${id}`
  };
}

/**
 * Host-only adapter boundary. Callers must pass metadata from a verified
 * platform event, never message text, model arguments or HTTP parameters.
 * The returned frozen object is the capability; normalizeScene rejects plain
 * lookalikes.
 */
export function mintTrustedScene(scene) {
  const normalized = validateSceneInput(scene);
  if (!normalized) throw new Error("SCENE_UNVERIFIED");
  const frozen = Object.freeze(normalized);
  trustedScenes.add(frozen);
  return frozen;
}

export function isTrustedScene(scene) {
  return trustedScenes.has(scene);
}

export function normalizeScene(scene) {
  return trustedScenes.has(scene) ? scene : null;
}

export function configureScene({ enabled = false, strictQQ = false, hostContract = false } = {}) {
  policy = {
    enabled: enabled === true,
    strictQQ: strictQQ === true,
    // Cross-scene grants exist only for a real Host contract. Synthetic tests
    // opt in explicitly; the shipped plugin does not, so QQ sharing stays off.
    hostContract: hostContract === true
  };
  return { ...policy };
}

export function scenePolicy() {
  return { ...policy };
}

export function currentScene() {
  return normalizeScene(storage.getStore());
}

export function runWithTrustedScene(scene, fn) {
  const trusted = normalizeScene(scene);
  if (!trusted) throw new Error("SCENE_UNVERIFIED");
  return storage.run(trusted, fn);
}

export function sceneAllows(outputScene, sourceSceneId) {
  if (!policy.enabled) {
    // Independent switches: recent context can be on while scene isolation is
    // off. Tagged sources still obey direction/same-scene rules; only genuinely
    // untagged legacy sources fall through as compatible.
    if (!sourceSceneId) return true;
    const output = normalizeScene(outputScene);
    if (!output) return false;
    return sourceSceneId === output.sceneId;
  }
  const output = normalizeScene(outputScene);
  if (!output) return false;
  if (output.platform !== "qq") return !String(sourceSceneId ?? "").startsWith("qq:");
  if (!sourceSceneId) return false;
  if (sourceSceneId === output.sceneId) return true;
  if (output.kind === "private" && output.admin && policy.hostContract) {
    return grants.get(output.sceneId)?.has(sourceSceneId) === true;
  }
  return false;
}

export function sceneFilterRows(rows) {
  if (!Array.isArray(rows)) return [];
  if (!policy.enabled) {
    // Turning the feature off must not declassify already scene-tagged rows.
    // Legacy NULL-provenance rows stay readable; tagged rows are visible only
    // to an explicitly bound matching trusted scene.
    const output = currentScene();
    return rows.filter((row) => !row?.scene_scope || (output && row.scene_scope === output.sceneId));
  }
  const output = currentScene();
  if (!output) return []; // fail closed in strict scene mode with no trusted output scene
  return rows.filter((row) => sceneAllows(output, row?.scene_scope ?? null));
}

export function sceneIdOf(scene) {
  return normalizeScene(scene)?.sceneId ?? null;
}

export function isAdminPrivateScene(scene) {
  const normalized = normalizeScene(scene);
  return normalized?.kind === "private" && normalized.admin === true;
}

// Verified user intent evidence for permanent core creation. The text must come
// from the Host session's current user message, never from model tool args.
export function isExplicitCoreRequest(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return /(永远|一直|永久|务必|核心记忆|重要记忆).{0,24}(记住|记得|保存|留下)|(记住|保存).{0,12}(永远|永久|核心)|remember (this|it) (forever|always)|save (this )?as (a )?core memory/i.test(t);
}

export function grantSceneRead(adminPrivate, source) {
  const out = normalizeScene(adminPrivate);
  const src = normalizeScene(source);
  if (!out || !src) throw new Error("SCENE_UNVERIFIED");
  if (!(out.kind === "private" && out.admin)) throw new Error("SCENE_ADMIN_PRIVATE_REQUIRED");
  if (src.sceneId === out.sceneId) throw new Error("SCENE_SOURCE_MUST_DIFFER");
  if (!policy.hostContract) throw new Error("SCENE_HOST_CONTRACT_REQUIRED");
  const set = grants.get(out.sceneId) ?? new Set();
  set.add(src.sceneId);
  grants.set(out.sceneId, set);
  return { output: out.sceneId, source: src.sceneId };
}

export function revokeSceneRead(adminPrivate, source) {
  const out = normalizeScene(adminPrivate);
  const src = normalizeScene(source);
  if (!out || !src) throw new Error("SCENE_UNVERIFIED");
  const set = grants.get(out.sceneId);
  return { output: out.sceneId, source: src.sceneId, revoked: set?.delete(src.sceneId) === true };
}

export function listSceneGrants() {
  return [...grants].map(([output, sources]) => ({ output, sources: [...sources] }));
}

export function resetSceneStateForTests() {
  grants.clear();
  policy = { enabled: false, strictQQ: false, hostContract: false };
}
