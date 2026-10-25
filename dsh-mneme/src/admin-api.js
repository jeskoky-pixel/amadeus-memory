// Owner-authenticated, minimal admin surface for the native Amadeus Memory
// settings page. It never exposes API keys, database contents or memory bodies;
// dynamic reads/writes go through the existing service, settings and preference
// APIs. All requests must be same-origin and resolve to the DSH owner principal.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FEATURE_FLAG_SPEC } from "./settings.js";
import { TYPES } from "./store.js";

const PREFIX = "/api/amadeus-memory/admin";
const MAX_BODY_BYTES = 64 * 1024;
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
