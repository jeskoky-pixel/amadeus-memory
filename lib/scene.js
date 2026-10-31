import { currentUnifiedSession } from "./unified-session-acl.js";
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
const grants = new Map(); // legacy in-process test grants: admin private -> Set(source)
let aclReader = null;

export function setSceneReadAclReader(reader) {
  aclReader = typeof reader === "function" ? reader : null;
}

function sceneParts(sceneId) {
  const text = String(sceneId ?? "");
  const match = /^(qq|test):(group|private):(.+)$/.exec(text);
  return match ? { platform: match[1], kind: match[2], id: match[3] } : null;
}

function sameQQBot(readerId, sourceId) {
  const reader = sceneParts(readerId);
  const source = sceneParts(sourceId);
  return Boolean(reader && source && reader.platform === "qq" && source.platform === "qq"
    && reader.kind === "group" && source.kind === "group"
    && reader.id.split(":")[0] === source.id.split(":")[0]);
}

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

export function sceneAllowsMemory(outputScene, sourceSceneId) {
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
  // A verified Host-minted owner private scene is the owner/admin capability.
  // It may read every scope; writes are still attributed to this private scene.
  if (output.kind === "private" && output.admin) return true;
  if (!sourceSceneId) return false;
  if (sourceSceneId === output.sceneId) return true;
  if (output.kind === "private") return false; // non-owner private never crosses scenes
  if (output.kind !== "group") return false;
  const source = sceneParts(sourceSceneId);
  if (!source || source.platform !== "qq" || source.kind !== "group") return false;
  if (!sameQQBot(output.sceneId, sourceSceneId)) return false;
  // Directional, read-only group grant. Private, legacy and malformed sources
  // never qualify; the persisted ACL is the only source of truth.
  if (aclReader && aclReader(output.sceneId, sourceSceneId) === true) return true;
  return grants.get(output.sceneId)?.has(sourceSceneId) === true;
}

export function sceneAllowsRecent(outputScene, sourceSceneId) {
  if (!policy.enabled) {
    if (!sourceSceneId) return true;
    const output = normalizeScene(outputScene);
    if (!output) return false;
    return sourceSceneId === output.sceneId;
  }
  const output = normalizeScene(outputScene);
  if (!output) return false;
  if (output.platform !== "qq") return !String(sourceSceneId ?? "").startsWith("qq:");
  // Raw ephemeral transcript is never shared by the long-term memory group
  // allowlist. Only the same trusted Scene, or the verified owner capability,
  // may read it.
  if (output.kind === "private" && output.admin) return true;
  return Boolean(sourceSceneId) && sourceSceneId === output.sceneId;
}

export function sceneAllows(outputScene, sourceSceneId) {
  return sceneAllowsMemory(outputScene, sourceSceneId);
}

export function sceneFilterRows(rows) {
  if (!Array.isArray(rows)) return [];
  const unified = currentUnifiedSession();
  if (unified) return unified.acl.filterReadable(unified.identity, rows);
  if (!policy.enabled) {
    // Turning the feature off must not declassify already scene-tagged rows.
    // Legacy NULL-provenance rows stay readable; tagged rows are visible only
    // to an explicitly bound matching trusted scene.
    const output = currentScene();
    return rows.filter((row) => !row?.scene_scope || (output && row.scene_scope === output.sceneId));
  }
  const output = currentScene();
  // Ordinary DSH sessions have no QQ Scene. Their model access is checked by
  // the trusted Session/Workspace gates; they may still read legacy unscoped
  // memories, while tagged QQ rows remain hidden.
  if (!output) return rows.filter((row) => !row?.scene_scope);
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
  aclReader = null;
  policy = { enabled: false, strictQQ: false, hostContract: false };
}
