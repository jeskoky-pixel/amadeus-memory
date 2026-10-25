// Owner-authenticated, minimal admin surface for the native Amadeus Memory
// settings page. It never exposes API keys, database contents or memory bodies;
// dynamic reads/writes go through the existing service, settings and preference
// APIs. All requests must be same-origin and resolve to the DSH owner principal.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FEATURE_FLAG_SPEC } from "./settings.js";
import { TYPES } from "./store.js";
import { INTERNAL_AUTHORITY } from "./internal-authority.js";
import { scenePolicy, currentScene, listSceneGrants } from "./scene.js";
import { recentContextConfig, recentContextCounts, clearRecentContext } from "./recent-context.js";
import {
  createBackup,
  listBackups,
  preflightBackup,
  stageRestore
} from "./backup.js";

const PREFIX = "/api/amadeus-memory/admin";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const NESTED_FLAG_PATHS = {
  "memoryQualityFilter.enabled": ["memoryQualityFilter", "enabled"],
  "llmAudit.enabled": ["llmAudit", "enabled"],
  "writeAdmission.enabled": ["writeAdmission", "enabled"],
  "writeAdmission.enforce": ["writeAdmission", "enforce"],
  "preInjectGate.enabled": ["preInjectGate", "enabled"],
  "preInjectGate.enforce": ["preInjectGate", "enforce"],
  "distillRecords.enabled": ["distillRecords", "enabled"],
  "distillRecords.retentionDays": ["distillRecords", "retentionDays"],
  "scopeState.enabled": ["scopeState", "enabled"],
  "scopeState.enforce": ["scopeState", "enforce"]
};

function packageInfo() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return {
      name: String(pkg.name ?? ""),
      version: String(pkg.version ?? ""),
      edition: String(pkg.amadeus?.edition ?? ""),
      upstream: String(pkg.amadeus?.upstream ?? "")
    };
  } catch {
    return { name: "", version: "", edition: "", upstream: "" };
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  });
  res.end(body);
}

function sameOrigin(req) {
  const host = String(req.headers?.host ?? "");
  if (!host) return false;
  if (req.headers?.["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers?.origin;
  if (origin !== undefined) {
    try {
      const parsed = new URL(String(origin));
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      if (parsed.host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function ownerAuthorized(connection, req) {
  if (!connection || typeof connection.admit !== "function") {
    return { ok: false, status: 503, error: "this DSH version cannot verify an owner session" };
  }
  let admission;
  try {
    admission = connection.admit(req);
  } catch {
    return { ok: false, status: 403, error: "request authentication failed" };
  }
  if (!admission || admission.rejection !== undefined) {
    return { ok: false, status: Number(admission?.rejection ?? 403), error: "DSH authentication is required" };
  }
  if (admission.peer?.principal?.kind !== "owner") {
    return { ok: false, status: 403, error: "only the authenticated owner may manage memory settings" };
  }
  return { ok: true };
}

async function readJson(req) {
  const contentType = String(req.headers?.["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    const error = new Error("POST requests require application/json");
    error.status = 400;
    throw error;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!size) {
    const error = new Error("request body is required");
    error.status = 400;
    throw error;
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("request body must be a JSON object");
    }
    return value;
  } catch (error) {
    const wrapped = new Error(error?.message === "request body must be a JSON object"
      ? error.message : "request body must be valid JSON");
    wrapped.status = 400;
    throw wrapped;
  }
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "***";
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}

function memorySummary(m, status = m) {
  const content = String(m.content ?? "");
  return {
    id: m.id,
    type: m.type,
    title: m.title,
    excerpt: content.length > 500 ? `${content.slice(0, 500)}…` : content,
    content_length: content.length,
    tags: Array.isArray(m.tags) ? m.tags.slice(0, 50) : [],
    importance: m.importance,
    source: m.source,
    // service.toApiList intentionally omits archived/forgotten from the shared
    // model DTO. The admin projection must take those statuses from the
    // authoritative store row or Boolean(undefined) makes archived rows look
    // active and removes the restore action from the settings page.
    archived: Boolean(status?.archived),
    forgotten: Boolean(status?.forgotten),
    scene_scope: status?.scene_scope ?? null,
    protected: status?.protected === true,
    protected_at: status?.protected_at ?? null,
    protected_by: status?.protected_by ?? null,
    core_note: status?.core_note ?? null,
    created_at: m.created_at,
    updated_at: m.updated_at
  };
}

function memoryFull(service, id) {
  const row = service.getById(id);
  if (!row) {
    const error = new Error("memory not found");
    error.status = 404;
    throw error;
  }
  const dto = service.toApiList([row], { includePreference: false })[0];
  return {
    ...dto,
    archived: Boolean(row.archived),
    forgotten: Boolean(row.forgotten),
    scene_scope: row.scene_scope ?? null,
    protected: row.protected === true,
    protected_at: row.protected_at ?? null,
    protected_by: row.protected_by ?? null,
    core_note: row.core_note ?? null
  };
}

function memoryPatch(body) {
  const patch = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) {
      const error = new Error("title must be a non-empty string"); error.status = 400; throw error;
    }
    patch.title = body.title.trim();
  }
  if (body.content !== undefined) {
    if (typeof body.content !== "string" || !body.content.trim()) {
      const error = new Error("content must be a non-empty string"); error.status = 400; throw error;
    }
    patch.content = body.content.trim();
  }
  if (body.importance !== undefined) {
    if (!Number.isInteger(body.importance) || body.importance < 1 || body.importance > 5) {
      const error = new Error("importance must be an integer from 1 to 5"); error.status = 400; throw error;
    }
    patch.importance = body.importance;
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 64 ||
      !body.tags.every((tag) => typeof tag === "string" && tag.trim())) {
      const error = new Error("tags must be an array of up to 64 non-empty strings"); error.status = 400; throw error;
    }
    patch.tags = body.tags.map((tag) => tag.trim());
  }
  return patch;
}

function memoryType(value) {
  const type = String(value ?? "").trim();
  if (!TYPES.has(type) || type === "document") {
    const error = new Error("type must be an editable Memory type"); error.status = 400; throw error;
  }
  return type;
}

function requireMemoryDir(deps) {
  if (!deps.memoryDir) {
    const error = new Error("memoryDir is unavailable in this process"); error.status = 503; throw error;
  }
  return deps.memoryDir;
}

function featureState(settings, config) {
  const keys = [
    ...FEATURE_FLAG_SPEC.booleans,
    ...Object.keys(FEATURE_FLAG_SPEC.ints),
    ...Object.keys(FEATURE_FLAG_SPEC.numbers),
    ...FEATURE_FLAG_SPEC.strings,
    ...FEATURE_FLAG_SPEC.urls,
    ...Object.keys(FEATURE_FLAG_SPEC.enums)
  ];
  const configValue = (key) => {
    const path = NESTED_FLAG_PATHS[key];
    return path ? config?.[path[0]]?.[path[1]] : config?.[key];
  };
  const overrides = settings.getFeatureFlags();
  const effective = {};
  for (const key of keys) {
    const value = overrides[key] !== undefined ? overrides[key] : configValue(key);
    if (value !== undefined) effective[key] = value;
  }
  const pendingRestart = config
    ? keys.filter((key) => overrides[key] !== undefined && !Object.is(overrides[key], configValue(key)))
    : [];
  return { overrides, effective, pendingRestart };
}

function safeEmbedderStatus(embedder, config, settings, vectorIndex, service, reranker) {
  const stats = vectorIndex?.getStats?.() ?? null;
  const vectorConfig = settings.getVectorConfig?.() ?? null;
  const provider = embedder?.name ?? config?.embedProvider ?? null;
  let model = embedder?.model ?? null;
  if (!model) {
    if (provider === "OpenAI" || config?.embedProvider === "openai") model = vectorConfig?.model ?? null;
    else if (config?.embedProvider === "ollama") model = config?.ollamaModel ?? null;
    else model = config?.localEmbedModel ?? null;
  }
  const dimension = embedder?.dimension ?? (config?.embedProvider === "local" ? config?.localEmbedDimension : null);
  const embedded = Number(stats?.embeddedCount ?? 0);
  const total = Number(stats?.totalCount ?? 0);
  const dims = typeof service.embeddingDimensionBreakdown === "function"
    ? [...service.embeddingDimensionBreakdown().entries()].map(([dim, count]) => ({ dimension: Number(dim) || null, count }))
    : [];
  return {
    provider,
    model: model ? String(model) : null,
    dimension: dimension ? Number(dimension) : null,
    ready: embedder ? ("ready" in embedder ? embedder.ready === true : true) : false,
    configured: embedder ? (typeof embedder.configured === "boolean" ? embedder.configured : true) : false,
    index: {
      embedded,
      total,
      ratio: total > 0 ? embedded / total : null,
      by_dimension: dims
    },
    reranker: Boolean(reranker),
    vector_config: vectorConfig ? {
      enabled: vectorConfig.enabled === true,
      base_url: String(vectorConfig.baseUrl ?? ""),
      model: String(vectorConfig.model ?? ""),
      api_key_configured: Boolean(vectorConfig.apiKey),
      api_key_masked: maskKey(String(vectorConfig.apiKey ?? ""))
    } : null
  };
}

function lastDreamRuns(store) {
  try {
    return store.listDreamRuns({ limit: 5 }).map((row) => ({
      run_type: row.run_type ?? null,
      status: row.status ?? null,
      created_at: row.created_at ?? null,
      error: row.error ?? null,
      summary: row.summary ?? null
    }));
  } catch {
    return [];
  }
}

function overview({ store, service, settings, config, embedder, vectorIndex, reranker }) {
  const total = store.count(undefined, { includeArchived: true, includeForgotten: true });
  const active = store.count(undefined, {});
  const archived = store.count(undefined, { onlyArchived: true, includeForgotten: true });
  const notForgotten = store.count(undefined, { includeArchived: true });
  const byType = {};
  for (const type of TYPES) byType[type] = store.count(type, {});
  let url = "";
  try {
    url = store.db.prepare("PRAGMA database_list").get()?.file ?? "";
  } catch { /* path is diagnostic only */ }
  let quickCheck = "unknown";
  try {
    const row = store.db.prepare("PRAGMA quick_check").get();
    quickCheck = Object.values(row ?? {})[0] ?? "unknown";
  } catch { /* reported as unknown */ }
  const dreamRuns = lastDreamRuns(store);
  const flags = featureState(settings, config);
  return {
    package: packageInfo(),
    runtime: {
      started_at: null,
      auto_inject: flags.effective.autoInject === true,
      auto_summarize: flags.effective.autoSummarize === true,
      auto_dream: flags.effective.autoDream === true,
      sleep_mode: flags.effective.sleepModeEnabled === true,
      entity_extraction: flags.effective.entityExtractionEnabled === true,
      preference_rerank: flags.effective.memoryPreferenceEnabled === true,
      trusted_intake: flags.effective.trustedIntakeEnabled === true
    },
    memories: {
      total,
      active,
      archived,
      forgotten: total - notForgotten,
      by_type: byType
    },
    database: {
      file: url,
      quick_check: quickCheck,
      journal_mode: (() => {
        try { return store.db.prepare("PRAGMA journal_mode").get()?.journal_mode ?? null; } catch { return null; }
      })()
    },
    semantic: safeEmbedderStatus(embedder, config, settings, vectorIndex, service, reranker),
    features: flags,
    last_dream: dreamRuns.find((row) => row.run_type === "auto") ?? null,
    last_sleep: dreamRuns.find((row) => row.run_type === "sleep") ?? null,
    recent_runs: dreamRuns,
    config: {
      language: config?.language ?? null,
      max_injected_items: config?.maxInjectedItems ?? null,
      importance_threshold: config?.importanceThreshold ?? null,
      inject_content_max_chars: config?.injectContentMaxChars ?? null,
      vector_search_top_k: config?.vectorSearchTopK ?? null,
      vector_search_threshold: config?.vectorSearchThreshold ?? null,
      rerank: flags.effective.rerankEnabled === true
    }
  };
}

function resolveEntityForPreference(service, body) {
  const direct = typeof body.entity_id === "string" && body.entity_id.trim() ? body.entity_id.trim() : "";
  if (direct) return { id: direct };
  const query = typeof body.entity === "string" ? body.entity.trim() : "";
  if (!query) {
    const error = new Error("entity or entity_id is required");
    error.status = 400;
    throw error;
  }
  const found = service.findEntityGroup(query)?.groups ?? [];
  if (found.length === 0) {
    const error = new Error("entity not found");
    error.status = 404;
    throw error;
  }
  if (found.length > 1) {
    const error = new Error("entity name is ambiguous; choose a UUID");
    error.status = 409;
    error.candidates = found.slice(0, 10).map((group) => ({
      id: group.id, name: group.name, type: group.type
    }));
    throw error;
  }
  return { id: found[0].id };
}

async function handle(req, res, deps) {
  const { service } = deps;
  const url = new URL(String(req.url ?? "/"), "http://localhost");
  if (!sameOrigin(req)) return send(res, 403, { ok: false, error: "same-origin request required" });
  if (req.method === "POST" && req.headers?.["x-amadeus-memory"] !== "1") {
    return send(res, 403, { ok: false, error: "missing Amadeus Memory request marker" });
  }
  const path = url.pathname.slice(PREFIX.length) || "/";
  if (req.method === "GET") {
    if (path === "/overview") return send(res, 200, { ok: true, data: overview(deps) });
    if (path === "/scene") {
      const policy = scenePolicy();
      const current = currentScene();
      const tagged = service.hasSceneScopedRows?.() === true;
      const grants = listSceneGrants().slice(0, 50);
      return send(res, 200, {
        ok: true,
        data: {
          enabled: policy.enabled === true,
          strict_qq: policy.strictQQ === true,
          host_contract: policy.hostContract === true,
          current_scene: current?.sceneId ?? null,
          has_scene_scoped_rows: tagged,
          unknown_provenance: "deny",
          legacy_untagged: "readable",
          degraded: tagged || policy.enabled === true || policy.strictQQ === true,
          degraded_surfaces: (tagged || policy.strictQQ === true)
            ? ["ordinary-http", "standalone-mcp", "graph-identity-preference", "background-derivation"]
            : [],
          grants
        }
      });
    }
    if (path === "/recent") {
      const cfg = recentContextConfig();
      const counts = recentContextCounts().slice(0, 64);
      return send(res, 200, {
        ok: true,
        data: {
          enabled: cfg.enabled,
          ttl_ms: cfg.ttlMs,
          max_events: cfg.maxEvents,
          max_tokens: cfg.maxTokens,
          scenes: counts,
          total_events: counts.reduce((sum, row) => sum + row.count, 0)
        }
      });
    }
    if (path === "/memories") {
      const q = String(url.searchParams.get("q") ?? "").trim();
      const archived = url.searchParams.get("archived") === "1";
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20));
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
      let rows;
      if (q) {
        rows = service.search(q, {
          limit: Math.min(100, limit + offset),
          includeArchived: archived
        });
        rows = rows.slice(offset, offset + limit);
      } else {
        rows = service.list({
          limit, offset, includeArchived: archived, onlyArchived: archived, includeForgotten: false
        });
      }
      const byId = new Map(rows.map((row) => [row.id, row]));
      const items = service.toApiList(rows, { includePreference: false })
        .map((row) => memorySummary(row, byId.get(row.id)));
      return send(res, 200, { ok: true, data: { items, archived, limit, offset, q } });
    }
    if (path === "/memory") {
      const id = String(url.searchParams.get("id") ?? "").trim();
      if (!id) return send(res, 400, { ok: false, error: "id is required" });
      return send(res, 200, { ok: true, data: memoryFull(service, id) });
    }
    if (path === "/backups") {
      return send(res, 200, { ok: true, data: { items: listBackups(requireMemoryDir(deps)) } });
    }
    if (path === "/preferences") return send(res, 200, { ok: true, data: service.getPreferenceState() });
    if (path === "/vector") {
      const cfg = deps.settings.getVectorConfig() ?? { enabled: false, baseUrl: "", apiKey: "", model: "" };
      return send(res, 200, {
        ok: true,
        data: {
          enabled: cfg.enabled === true,
          base_url: String(cfg.baseUrl ?? ""),
          model: String(cfg.model ?? ""),
          api_key_configured: Boolean(cfg.apiKey),
          api_key_masked: maskKey(String(cfg.apiKey ?? "")),
          restart_required: false
        }
      });
    }
    if (path === "/features") return send(res, 200, { ok: true, data: featureState(deps.settings, deps.config) });
    return send(res, 404, { ok: false, error: "unknown admin endpoint" });
  }
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "method not allowed" });
  const body = await readJson(req);
  if (path === "/memory") {
    const type = memoryType(body.type);
    if (typeof body.title !== "string" || !body.title.trim()) {
      return send(res, 400, { ok: false, error: "title must be a non-empty string" });
    }
    if (typeof body.content !== "string" || !body.content.trim()) {
      return send(res, 400, { ok: false, error: "content must be a non-empty string" });
    }
    if (body.importance !== undefined &&
      (!Number.isInteger(body.importance) || body.importance < 1 || body.importance > 5)) {
      return send(res, 400, { ok: false, error: "importance must be an integer from 1 to 5" });
    }
    const tags = body.tags === undefined ? [] : body.tags;
    if (!Array.isArray(tags) || tags.length > 64 || !tags.every((tag) => typeof tag === "string" && tag.trim())) {
      return send(res, 400, { ok: false, error: "tags must be an array of up to 64 non-empty strings" });
    }
    const result = service.saveWithDedupe({
      type,
      title: body.title.trim(),
      content: body.content.trim(),
      importance: body.importance,
      tags: tags.map((tag) => tag.trim()),
      source: "settings-page"
    });
    if (result.action === "denied") {
      return send(res, 422, { ok: false, error: "write-rejected", reason: result.reason });
    }
    return send(res, result.action === "created" ? 201 : 200, {
      ok: true,
      data: {
        action: result.action,
        memory: memoryFull(service, result.memory.id)
      }
    });
  }
  if (path === "/memory/update") {
    const id = String(body.id ?? "").trim();
    if (!id) return send(res, 400, { ok: false, error: "id is required" });
    const existing = service.getById(id);
    if (!existing) return send(res, 404, { ok: false, error: "memory not found" });
    const expected = String(body.expected_updated_at ?? "").trim();
    if (!expected) return send(res, 400, { ok: false, error: "expected_updated_at is required" });
    if (existing.updated_at !== expected) {
      return send(res, 409, { ok: false, error: "memory changed since it was opened", data: { memory: memoryFull(service, id) } });
    }
    const patch = memoryPatch(body);
    const hasArchived = body.archived !== undefined;
    if (!Object.keys(patch).length && !hasArchived) {
      return send(res, 400, { ok: false, error: "no editable fields" });
    }
    if (hasArchived && typeof body.archived !== "boolean") {
      return send(res, 400, { ok: false, error: "archived must be boolean" });
    }
    let updated = existing;
    if (Object.keys(patch).length) {
      if (existing.protected) patch[INTERNAL_AUTHORITY] = true;
      updated = service.compareAndUpdate(id, expected, patch, { actor: "settings-page" });
      if (!updated) {
        return send(res, 409, { ok: false, error: "memory changed since it was opened", data: { memory: memoryFull(service, id) } });
      }
    }
    if (hasArchived) updated = service.setArchived(id, body.archived);
    return send(res, 200, { ok: true, data: { memory: memoryFull(service, id) } });
  }
  if (path === "/memory/archive") {
    const id = String(body.id ?? "").trim();
    if (!id) return send(res, 400, { ok: false, error: "id is required" });
    if (typeof body.archived !== "boolean") return send(res, 400, { ok: false, error: "archived must be boolean" });
    const existing = service.getById(id);
    if (!existing) return send(res, 404, { ok: false, error: "memory not found" });
    const expected = String(body.expected_updated_at ?? "").trim();
    if (expected && existing.updated_at !== expected) {
      return send(res, 409, { ok: false, error: "memory changed since it was opened", data: { memory: memoryFull(service, id) } });
    }
    service.setArchived(id, body.archived);
    return send(res, 200, { ok: true, data: { memory: memoryFull(service, id) } });
  }
  if (path === "/memory/delete") {
    const id = String(body.id ?? "").trim();
    if (!id) return send(res, 400, { ok: false, error: "id is required" });
    if (body.confirm !== "DELETE") return send(res, 400, { ok: false, error: "confirm must be DELETE" });
    const existing = service.getById(id);
    if (!existing) return send(res, 404, { ok: false, error: "memory not found" });
    service.remove(id);
    return send(res, 200, { ok: true, data: { deleted: id } });
  }
  if (path === "/recent/clear") {
    clearRecentContext();
    const cfg = recentContextConfig();
    return send(res, 200, {
      ok: true,
      data: {
        cleared: true,
        enabled: cfg.enabled,
        ttl_ms: cfg.ttlMs,
        max_events: cfg.maxEvents,
        max_tokens: cfg.maxTokens,
        scenes: recentContextCounts(),
        total_events: 0
      }
    });
  }
  if (path === "/core") {
    if (deps.config?.coreMemoryEnabled !== true) {
      return send(res, 409, { ok: false, error: "core memory feature is disabled" });
    }
    const action = String(body.action ?? "");
    const id = String(body.id ?? "").trim();
    if (!id) return send(res, 400, { ok: false, error: "id is required" });
    const existing = service.getById(id);
    if (!existing) return send(res, 404, { ok: false, error: "memory not found" });
    if (action === "protect") {
      deps.store.setProtected(id, true, { by: "settings-page", note: typeof body.note === "string" ? body.note : undefined });
    } else if (action === "unprotect") {
      deps.store.setProtected(id, false, { by: "settings-page" });
    } else if (action === "note") {
      if (!existing.protected) return send(res, 409, { ok: false, error: "memory is not protected" });
      deps.store.setProtected(id, true, { by: existing.protected_by ?? "settings-page", note: typeof body.note === "string" ? body.note : "" });
    } else if (action === "delete") {
      if (body.confirm !== "DELETE") return send(res, 400, { ok: false, error: "confirm must be DELETE" });
      deps.store.setProtected(id, false, { by: "settings-page" });
      service.remove(id);
      return send(res, 200, { ok: true, data: { deleted: id } });
    } else {
      return send(res, 400, { ok: false, error: "action must be protect, unprotect, note or delete" });
    }
    return send(res, 200, { ok: true, data: { memory: memoryFull(service, id) } });
  }
  if (path === "/backup") {
    const backup = createBackup({ store: deps.store, memoryDir: requireMemoryDir(deps) });
    const { directory, ...safe } = backup;
    return send(res, 201, { ok: true, data: safe });
  }
  if (path === "/restore/check") {
    return send(res, 200, {
      ok: true,
      data: preflightBackup(requireMemoryDir(deps), String(body.backup ?? ""))
    });
  }
  if (path === "/restore") {
    if (body.confirm !== "RESTORE") {
      return send(res, 400, { ok: false, error: "confirm must be RESTORE" });
    }
    const staged = stageRestore({
      memoryDir: requireMemoryDir(deps),
      name: String(body.backup ?? ""),
      sha256: body.sha256
    });
    return send(res, 200, {
      ok: true,
      data: {
        backup: staged.backup,
        sha256: staged.sha256,
        memories: staged.memories,
        restart_required: true
      }
    });
  }
  if (path === "/preferences") {
    const action = String(body.action ?? "");
    const actor = "settings-page";
    if (action === "set-tag") {
      const row = service.setTagWeight({ tag: body.tag, weight: body.weight, actor });
      return send(res, 200, { ok: true, data: { tag: row, state: service.getPreferenceState() } });
    }
    if (action === "delete-tag") {
      const removed = service.deleteTagWeight({ tag: body.tag, actor });
      return send(res, 200, { ok: true, data: { removed, state: service.getPreferenceState() } });
    }
    if (action === "set-entity") {
      const target = resolveEntityForPreference(service, body);
      const row = service.setEntityWeight({ entity_id: target.id, weight: body.weight, actor });
      return send(res, 200, { ok: true, data: { entity: row, state: service.getPreferenceState() } });
    }
    if (action === "delete-entity") {
      const target = resolveEntityForPreference(service, body);
      const removed = service.deleteEntityWeight({ entity_id: target.id, actor });
      return send(res, 200, { ok: true, data: { removed, state: service.getPreferenceState() } });
    }
    if (action === "reset") {
      for (const row of service.listTagWeights()) service.deleteTagWeight({ tag: row.tag, actor });
      for (const row of service.listEntityWeights()) service.deleteEntityWeight({ entity_id: row.entity_id, actor });
      return send(res, 200, { ok: true, data: { reset: true, state: service.getPreferenceState() } });
    }
    return send(res, 400, { ok: false, error: "action must be set-tag, delete-tag, set-entity, delete-entity or reset" });
  }
  if (path === "/features") {
    if (Object.keys(body).length === 0) return send(res, 400, { ok: false, error: "feature patch must not be empty" });
    try {
      deps.settings.setFeatureFlags(body);
    } catch (error) {
      return send(res, 400, { ok: false, error: error.message });
    }
    return send(res, 200, { ok: true, data: featureState(deps.settings, deps.config) });
  }
  if (path === "/vector") {
    const prev = deps.settings.getVectorConfig() ?? {};
    const incoming = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const keep = incoming === "" || maskKey(incoming) === incoming;
    const cfg = deps.settings.setVectorConfig({
      enabled: body.enabled,
      baseUrl: body.baseUrl,
      apiKey: keep ? (prev.apiKey ?? "") : incoming,
      model: body.model
    });
    return send(res, 200, {
      ok: true,
      data: {
        enabled: cfg.enabled === true,
        base_url: String(cfg.baseUrl ?? ""),
        model: String(cfg.model ?? ""),
        api_key_configured: Boolean(cfg.apiKey),
        api_key_masked: maskKey(String(cfg.apiKey ?? "")),
        restart_required: true
      }
    });
  }
  if (path === "/vector/test") {
    const embedder = deps.embedder;
    if (!embedder || typeof embedder.embedSingle !== "function") {
      return send(res, 503, { ok: false, error: "embedding is not configured in this process" });
    }
    const started = Date.now();
    try {
      const vector = await embedder.embedSingle("Amadeus Memory synthetic connectivity probe");
      if (!vector || !Array.isArray(vector)) {
        return send(res, 503, { ok: false, error: "embedding returned no vector", data: { remote: false } });
      }
      return send(res, 200, {
        ok: true,
        data: {
          remote: String(embedder.name ?? "").toLowerCase() === "openai",
          provider: embedder.name ?? null,
          model: embedder.model ?? null,
          dimension: vector.length,
          elapsed_ms: Date.now() - started
        }
      });
    } catch (error) {
      return send(res, 502, {
        ok: false,
        error: String(error?.message ?? error).slice(0, 300),
        data: { remote: String(embedder.name ?? "").toLowerCase() === "openai", elapsed_ms: Date.now() - started }
      });
    }
  }
  return send(res, 404, { ok: false, error: "unknown admin endpoint" });
}

export function mountAdminApi(ctx, deps) {
  ctx.inject(["webServer", "connection"], (child) => {
    if (!child.webServer || typeof child.webServer.register !== "function") return;
    child.effect(
      () => child.webServer.register({
        kind: "prefix",
        path: PREFIX,
        handler: async (req, res) => {
          const auth = ownerAuthorized(child.connection, req);
          if (!auth.ok) return send(res, auth.status, { ok: false, error: auth.error });
          try {
            return await handle(req, res, deps);
          } catch (error) {
            return send(res, Number(error?.status) || 500, {
              ok: false,
              error: String(error?.message ?? error).slice(0, 300),
              ...(error?.candidates ? { candidates: error.candidates } : {})
            });
          }
        }
      }),
      "amadeus-memory: owner settings API"
    );
  });
}

export const __adminInternals = { PREFIX, sameOrigin, maskKey, featureState, packageInfo };
