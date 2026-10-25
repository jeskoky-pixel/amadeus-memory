// Bounded, in-memory Recent Context. No embedding, no LLM, no long-term write.
import { currentScene, normalizeScene, sceneAllows } from "./scene.js";
import { estimateTokens } from "./hot-memory.js";

let config = { enabled: false, ttlMs: 10 * 60 * 1000, maxEvents: 20, maxTokens: 500 };
const byScene = new Map(); // sceneId -> [{eventId, text, at, scene}]
const MAX_SCENES = 64;

function prune(now = Date.now()) {
  for (const [sceneId, list] of byScene) {
    const kept = list.filter((event) => now - event.at <= config.ttlMs);
    if (kept.length) byScene.set(sceneId, kept);
    else byScene.delete(sceneId);
  }
}

function touchScene(sceneId, list) {
  if (byScene.has(sceneId)) byScene.delete(sceneId); // LRU move to end
  byScene.set(sceneId, list);
  while (byScene.size > MAX_SCENES) {
    byScene.delete(byScene.keys().next().value);
  }
}

export function configureRecentContext(next = {}) {
  config = {
    enabled: next.enabled === true,
    ttlMs: Number.isFinite(next.ttlMs) ? Math.max(1, next.ttlMs) : 10 * 60 * 1000,
    maxEvents: Number.isSafeInteger(next.maxEvents) ? Math.min(20, Math.max(1, next.maxEvents)) : 20,
    maxTokens: Number.isFinite(next.maxTokens) ? Math.max(50, next.maxTokens) : 500
  };
  if (!config.enabled) clearRecentContext();
  return { ...config };
}

export function recentContextConfig() {
  return { ...config };
}

/** Trusted Host adapter writes an event; scene must be verified. */
export function recordTrustedRecentEvent({ eventId, scene, text, at = Date.now() } = {}) {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const trusted = normalizeScene(scene);
  if (!trusted) return { ok: false, reason: "unverified-scene" };
  const id = String(eventId ?? "").trim();
  const body = String(text ?? "").trim();
  const when = Number(at);
  if (!id || !body || !Number.isFinite(when)) return { ok: false, reason: "invalid-event" };
  prune();
  const list = byScene.get(trusted.sceneId) ?? [];
  if (list.some((event) => event.eventId === id)) return { ok: false, reason: "duplicate" };
  list.push({ eventId: id, text: body.slice(0, 4000), at: when, scene: trusted });
  while (list.length > config.maxEvents) list.shift();
  touchScene(trusted.sceneId, list);
  return { ok: true, scene: trusted.sceneId };
}

/** Read the newest authorized events for the current output scene. */
export function readRecentContext({ outputScene = currentScene(), now = Date.now() } = {}) {
  if (!config.enabled) return [];
  prune(now);
  const output = normalizeScene(outputScene);
  if (!output) return [];
  const events = [];
  for (const list of byScene.values()) {
    for (const event of list) {
      if (now - event.at > config.ttlMs) continue;
      if (!sceneAllows(output, event.scene.sceneId)) continue;
      events.push(event);
    }
  }
  events.sort((a, b) => b.at - a.at);
  const chosen = [];
  let tokens = 0;
  for (const event of events) {
    const cost = estimateTokens(event.text) + 8;
    if (tokens + cost > config.maxTokens) continue;
    chosen.push(event);
    tokens += cost;
  }
  return chosen.map(({ eventId, text, at, scene }) => ({
    eventId, text, at, scene: scene.sceneId
  }));
}

export function recentContextCounts() {
  prune();
  return [...byScene].map(([scene, list]) => ({ scene, count: list.length }));
}

export function clearRecentContext() {
  byScene.clear();
}

// Test/diagnostic only.
export function resetRecentContextForTests() {
  clearRecentContext();
  config = { enabled: false, ttlMs: 10 * 60 * 1000, maxEvents: 20, maxTokens: 500 };
}
