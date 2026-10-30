import { unifiedSnapshot, saveUnifiedPolicy, unifiedGraph, unifiedDisplay } from "./unified-admin.js";
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
import { listWorkspaces, listWorkspaceSessionIds } from "./workspace-gate.js";
import { readWorkspaceBinding, setWorkspaceBinding } from "./workspace-binding.js";
import { scenePolicy, currentScene, listSceneGrants } from "./scene.js";
import { recentContextConfig, recentContextCounts, clearRecentContext } from "./recent-context.js";
import { RECENT_ACTIVITY_LIMITS } from "./recent-activity.js";
import { renderUserSettingsBlock } from "./user-settings.js";
import {
  createBackup,
  listBackups,
  preflightBackup,
  stageRestore
} from "./backup.js";

const PREFIX = "/api/amadeus-memory/admin";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
// Display metadata only. The Host title projection is untrusted for identity and
// authorization, so it is bounded before leaving this owner-only surface.
const MAX_SESSION_TITLE_CHARS = 200;
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

export function sameOrigin(req) {
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

export function ownerAuthorized(connection, req) {
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

function graphScopeClause(scope) {
  return scope === "legacy" ? "m.scene_scope IS NULL" : "m.scene_scope = ?";
}
function graphScopeParams(scope) {
  return scope === "legacy" ? [] : [scope];
}

function sceneAclGroup(sceneId) {
  const match = /^qq:group:([^:]+):(.+)$/.exec(String(sceneId ?? ""));
  if (!match) return null;
  return { botId: match[1], peerId: match[2] };
}

function sceneAclState(deps) {
  const scopes = typeof deps.store.listSceneScopes === "function"
    ? deps.store.listSceneScopes({ limit: 500 })
    : graphScopes(deps).items;
  return {
    grants: typeof deps.store.listSceneReadGrants === "function"
      ? deps.store.listSceneReadGrants({ limit: 500 })
      : [],
    scenes: scopes.filter((row) => sceneAclGroup(row.scope))
      .map((row) => ({ scope: row.scope, ...sceneAclGroup(row.scope), total: row.total, active: row.active })),
    policy: {
      owner_reads_all: true,
      grants_are_directional: true,
      grants_are_read_only: true,
      grants_include_private: false,
      grants_include_legacy: false
    }
  };
}

function aclKnownBots(deps) {
  const bots = new Set();
  for (const row of deps.store.listSceneScopes({ limit: 500 })) {
    const group = sceneAclGroup(row.scope);
    if (group?.botId) bots.add(group.botId);
  }
  return [...bots].sort();
}

function validateAclPair(deps, body) {
  let reader = String(body.reader_scene ?? "").trim();
  let source = String(body.source_scene ?? "").trim();
  if (!reader || !source) {
    const readerGroupId = String(body.reader_group ?? "").trim();
    const sourceGroupId = String(body.source_group ?? "").trim();
    let bot = String(body.bot ?? "").trim();
    if (!/^\d+$/.test(readerGroupId) || !/^\d+$/.test(sourceGroupId)) {
      const error = new Error("reader_group and source_group must be numeric QQ group IDs");
      error.status = 400;
      throw error;
    }
    if (!bot) {
      const known = aclKnownBots(deps);
      if (known.length !== 1) {
        const error = new Error("bot is required when zero or multiple QQ bots are known");
        error.status = 400;
        throw error;
      }
      bot = known[0];
    }
    if (!/^\d+$/.test(bot)) {
      const error = new Error("bot must be a numeric QQ bot ID");
      error.status = 400;
      throw error;
    }
    reader = `qq:group:${bot}:${readerGroupId}`;
    source = `qq:group:${bot}:${sourceGroupId}`;
  }
  const readerGroup = sceneAclGroup(reader);
  const sourceGroup = sceneAclGroup(source);
  if (!readerGroup || !sourceGroup) {
    const error = new Error("reader and source must be canonical QQ group scenes");
    error.status = 400;
    throw error;
  }
  if (reader === source) {
    const error = new Error("self grant is not allowed");
    error.status = 400;
    throw error;
  }
  if (readerGroup.botId !== sourceGroup.botId) {
    const error = new Error("grants must stay on the same QQ bot");
    error.status = 400;
    throw error;
  }
  // Canonical same-bot group IDs are sufficient. Do not require the groups to
  // already have memory rows: grants may precede first memory, and revocation
  // must survive deletion of a group's last row.
  return { reader, source };
}

function selectedSceneFilter(url) {
  const raw = String(url.searchParams.get("scenes") ?? "").trim();
  if (!raw || raw === "all") return null;
  return new Set(raw.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 50));
}

function sceneFilterMemories(rows, selected) {
  if (!selected) return rows;
  return rows.filter((row) => selected.has(row.scene_scope ?? "legacy"));
}

function graphScopes(deps) {  const db = deps.store.db;
  const rows = db.prepare(
    `SELECT scene_scope AS scope,
            COUNT(*) AS total,
            SUM(CASE WHEN forgotten = 0 AND archived = 0 THEN 1 ELSE 0 END) AS active
       FROM memories
      GROUP BY scene_scope
      ORDER BY active DESC, total DESC, scene_scope ASC
      LIMIT 200`
  ).all();
  const items = rows.map((row) => ({
    scope: row.scope ?? "legacy",
    label: row.scope ?? "legacy (unscoped)",
    legacy: row.scope == null,
    total: Number(row.total) || 0,
    active: Number(row.active) || 0
  }));
  return { items, bounded: rows.length >= 200 };
}

function graphForScope(deps, scope, limitEdges = 120, limitNodes = 80) {
  const db = deps.store.db;
  const clause = graphScopeClause(scope);
  const params = graphScopeParams(scope);
  const present = db.prepare(
    `SELECT 1 AS present FROM memories m WHERE ${clause} LIMIT 1`
  ).get(...params);
  if (!present) return null;

  const edgeLimit = Math.min(200, Math.max(1, Number(limitEdges) || 120));
  const nodeLimit = Math.min(100, Math.max(1, Number(limitNodes) || 80));
  const edgeTotal = Number(db.prepare(
    `SELECT COUNT(*) AS c FROM entity_relations r
       JOIN memories m ON m.id = r.memory_id
      WHERE m.forgotten = 0 AND m.archived = 0 AND ${clause}`
  ).get(...params).c) || 0;
  const edgeRows = db.prepare(
    `SELECT r.id, r.from_entity, r.to_entity, r.relation_type, r.weight, r.source,
            r.memory_id
       FROM entity_relations r
       JOIN memories m ON m.id = r.memory_id
      WHERE m.forgotten = 0 AND m.archived = 0 AND ${clause}
      ORDER BY r.created_at DESC, r.id ASC
      LIMIT ?`
  ).all(...params, edgeLimit + 1);
  const edgesTruncated = edgeRows.length > edgeLimit;
  const edges = edgesTruncated ? edgeRows.slice(0, edgeLimit) : edgeRows;

  const attrLimit = Math.min(400, nodeLimit * 4);
  const attrTotal = Number(db.prepare(
    `SELECT COUNT(DISTINCT ea.entity_id) AS c
       FROM entity_attrs ea JOIN memories m ON m.id = ea.memory_id
      WHERE ea.valid_until IS NULL AND m.forgotten = 0 AND m.archived = 0 AND ${clause}`
  ).get(...params).c) || 0;
  const attrRows = db.prepare(
    `SELECT ea.entity_id, ea.memory_id
       FROM entity_attrs ea JOIN memories m ON m.id = ea.memory_id
      WHERE ea.valid_until IS NULL AND m.forgotten = 0 AND m.archived = 0 AND ${clause}
      ORDER BY ea.valid_from DESC, ea.id ASC
      LIMIT ?`
  ).all(...params, attrLimit);
  const attrsTruncated = attrTotal > new Set(attrRows.map((row) => row.entity_id)).size;

  const memoryByEntity = new Map();
  const nodeIds = new Set();
  const addEvidence = (entityId, memoryId) => {
    if (!entityId || !memoryId) return;
    nodeIds.add(entityId);
    const set = memoryByEntity.get(entityId) ?? new Set();
    set.add(memoryId);
    memoryByEntity.set(entityId, set);
  };
  for (const edge of edges) {
    nodeIds.add(edge.from_entity);
    nodeIds.add(edge.to_entity);
    addEvidence(edge.from_entity, edge.memory_id);
    addEvidence(edge.to_entity, edge.memory_id);
  }
  // Relation endpoints get first claim on the bounded node slots. Attribute
  // entities fill whatever remains, so a large attr set cannot crowd out every
  // returned edge's endpoints.
  for (const row of attrRows) addEvidence(row.entity_id, row.memory_id);
  const nodeIdsAll = [...nodeIds];
  const selectedIds = nodeIdsAll.slice(0, nodeLimit);
  const selected = new Set(selectedIds);
  const nodesTruncated = nodeIdsAll.length > nodeLimit;
  let nodes = [];
  if (selectedIds.length) {
    const placeholders = selectedIds.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT id, name, type FROM entities WHERE id IN (${placeholders})`
    ).all(...selectedIds);
    nodes = rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type ?? "concept",
      related_memories: memoryByEntity.get(row.id)?.size ?? 0,
      degree: 0
    }));
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const visibleEdges = edges.filter((edge) => nodeById.has(edge.from_entity) && nodeById.has(edge.to_entity));
  for (const edge of visibleEdges) {
    nodeById.get(edge.from_entity).degree += 1;
    nodeById.get(edge.to_entity).degree += 1;
  }
  nodes.sort((a, b) => b.degree - a.degree || b.related_memories - a.related_memories || a.name.localeCompare(b.name));
  visibleEdges.sort((a, b) => String(a.relation_type).localeCompare(String(b.relation_type)) || String(a.id).localeCompare(String(b.id)));
  const truncated = edgesTruncated || attrsTruncated || nodesTruncated;
  return {
    scope,
    scope_label: scope === "legacy" ? "legacy (unscoped)" : scope,
    nodes,
    edges: visibleEdges.map((edge) => ({
      id: edge.id,
      from: edge.from_entity,
      to: edge.to_entity,
      relation_type: edge.relation_type,
      weight: edge.weight ?? 1,
      source: edge.source ?? "unknown"
    })),
    counts: {
      nodes: nodes.length,
      edges: visibleEdges.length,
      total_edges: edgeTotal,
      attr_entities: attrTotal
    },
    limits: { nodes: nodeLimit, edges: edgeLimit, attrs: attrLimit },
    truncated
  };
}

function graphForScopes(deps, scopes, limitEdges = 120, limitNodes = 80) {
  const selected = Array.isArray(scopes) ? scopes.filter(Boolean).slice(0, 50) : [];
  if (selected.length === 0) {
    return { scope: "all", scope_label: "all Scenes", scopes: [], nodes: [], edges: [], counts: { nodes: 0, edges: 0 }, truncated: false };
  }
  const nodeMap = new Map();
  const edgeMap = new Map();
  let truncated = false;
  for (const scope of selected) {
    const graph = graphForScope(deps, scope, 200, 100);
    if (!graph) continue;
    truncated ||= graph.truncated === true;
    for (const node of graph.nodes) {
      const existing = nodeMap.get(node.id);
      if (existing) {
        existing.related_memories += node.related_memories;
        if (!existing.scopes.includes(scope)) existing.scopes.push(scope);
      } else {
        nodeMap.set(node.id, { ...node, degree: 0, scopes: [scope] });
      }
    }
    for (const edge of graph.edges) {
      if (!edgeMap.has(edge.id)) edgeMap.set(edge.id, { ...edge, scopes: [scope] });
      else if (!edgeMap.get(edge.id).scopes.includes(scope)) edgeMap.get(edge.id).scopes.push(scope);
    }
  }
  let nodes = [...nodeMap.values()]
    .sort((a, b) => b.related_memories - a.related_memories || a.name.localeCompare(b.name));
  if (nodes.length > limitNodes) { nodes = nodes.slice(0, limitNodes); truncated = true; }
  const visible = new Set(nodes.map((node) => node.id));
  let edges = [...edgeMap.values()].filter((edge) => visible.has(edge.from) && visible.has(edge.to));
  for (const edge of edges) {
    const from = nodes.find((node) => node.id === edge.from);
    const to = nodes.find((node) => node.id === edge.to);
    if (from) from.degree += 1;
    if (to) to.degree += 1;
  }
  if (edges.length > limitEdges) { edges = edges.slice(0, limitEdges); truncated = true; }
  return {
    scope: selected.length === 1 ? selected[0] : "multi",
    scope_label: selected.length === 1 ? selected[0] : `${selected.length} selected Scenes`,
    scopes: selected,
    nodes,
    edges,
    counts: { nodes: nodes.length, edges: edges.length },
    truncated
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

// The Workspace binding lives at the configured control root, never at the
// selected Workspace's runtime directory. This route deliberately uses its own
// dependency so a runtime path override cannot redirect the selection file.
function workspaceControlRoot(deps) {
  const root = deps.controlRoot;
  if (typeof root !== "string" || root.trim() === "") {
    const error = new Error("the Workspace control root is unavailable in this process");
    error.status = 503;
    throw error;
  }
  return root;
}

function readOptionalService(ctx, name) {
  try {
    if (typeof ctx?.reflect?.get === "function") return ctx.reflect.get(name);
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

// Distinguish a genuinely empty Registry from an unavailable/malformed one.
// The selection path re-reads the Registry inside setWorkspaceBinding, so this
// probe is only for the API's availability answer and never authorization.
function workspaceRegistryState(ctx) {
  let rawList;
  try {
    const registry = readOptionalService(ctx, "workspaceRegistry");
    if (!registry || typeof registry.list !== "function") {
      return { available: false, reason: "registry-unavailable" };
    }
    rawList = registry.list();
  } catch {
    return { available: false, reason: "registry-unavailable" };
  }
  if (!Array.isArray(rawList)) return { available: false, reason: "malformed-registry" };
  return { available: true, reason: null };
}

// A safe host remount is not available on the observed loader version:
// loader.update(id, options) only restarts when an effective entry option
// (config/group) changes. Passing unchanged options with its forced patch does
// not restart the plugin, and there is no public "force restart" option.
// Returning this truthfully is safer than toggling `disabled`, which would
// unmount the owner API before a remount could be proven successful.
function workspaceRemountState() {
  return {
    supported: false,
    reason: "host-loader-update-requires-effective-option-change",
    action: "restart-plugin"
  };
}

function workspaceSnapshot(deps) {
  const controlRoot = workspaceControlRoot(deps);
  const registry = workspaceRegistryState(deps.ctx);
  const workspaces = registry.available
    ? listWorkspaces(deps.ctx).map((workspace) => ({
        id: workspace.id,
        title: workspace.title,
        session_count: workspace.sessionCount
      }))
    : [];
  const binding = readWorkspaceBinding(controlRoot);
  const active = typeof deps.activeWorkspaceId === "string" && deps.activeWorkspaceId.trim() !== ""
    ? deps.activeWorkspaceId
    : null;
  const selected = binding.bound ? binding.workspaceId : null;
  // A change is latched for the life of this mounted runtime. The guard latches
  // on the first mismatch, so selecting the original ID back before a remount
  // must not be reported as already active.
  const changedThisMount = deps.workspaceState?.changedSinceBoot === true;
  const changedSinceBoot = deps.initialSelectedWorkspaceId !== undefined
    ? selected !== (deps.initialSelectedWorkspaceId ?? null)
    : false;
  const pendingRemount = changedThisMount || changedSinceBoot ||
    (binding.bound ? selected !== active : active !== null);
  return {
    workspaces,
    selected_workspace_id: selected,
    active_workspace_id: active,
    runtime_mode: active === null ? "unbound" : "selected",
    pending_remount: pendingRemount,
    restart_required: pendingRemount,
    registry_available: registry.available,
    ...(registry.reason ? { registry_error: registry.reason } : {}),
    ...(binding.diagnostic ? { binding_diagnostic: binding.diagnostic } : {}),
    remount: workspaceRemountState()
  };
}

function workspaceSelectionStatus(reason) {
  if (reason === "invalid-workspace-id" || reason === "unknown-workspace-id") return 400;
  if (reason === "invalid-memory-dir") return 503;
  return 409;
}

function workspaceSelectionError(reason) {
  if (reason === "unknown-workspace-id") return "workspace is not present in the trusted Registry";
  if (reason === "invalid-workspace-id") return "workspace_id must be an exact Registry ID";
  if (reason === "invalid-memory-dir") return "the Workspace control root is unavailable in this process";
  return "the Workspace binding could not be saved";
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

// --- recent-activity owner surface -----------------------------------------
// All recent-activity routes operate on the active isolated Workspace store.
// Session IDs are never accepted from a request as authorization input: every
// listed/updated/previewed ID must first be present in the strict Registry list
// for `deps.activeWorkspaceId`. The model core stays authoritative for content
// filtering; this layer only refuses stale/unknown IDs and safe status fields.

function recentActivityConfigDto(config) {
  const source = config && typeof config === "object" ? config : {};
  const ttl = Number(source.ttl_hours);
  const maxItems = Number(source.max_items);
  const maxTokens = Number(source.max_tokens);
  return {
    ttl_hours: RECENT_ACTIVITY_LIMITS.TTL_HOURS.includes(ttl)
      ? ttl
      : RECENT_ACTIVITY_LIMITS.DEFAULT_TTL_HOURS,
    auto_inject: source.auto_inject !== false,
    max_items: Number.isInteger(maxItems) && maxItems >= 1 && maxItems <= RECENT_ACTIVITY_LIMITS.MAX_ITEMS
      ? maxItems
      : RECENT_ACTIVITY_LIMITS.DEFAULT_MAX_ITEMS,
    max_tokens: Number.isInteger(maxTokens) &&
      maxTokens >= RECENT_ACTIVITY_LIMITS.MIN_MAX_TOKENS &&
      maxTokens <= RECENT_ACTIVITY_LIMITS.MAX_MAX_TOKENS
      ? maxTokens
      : RECENT_ACTIVITY_LIMITS.DEFAULT_MAX_TOKENS
  };
}

function recentActivityConfiguredEnabled(deps) {
  try {
    const flags = deps.settings.getFeatureFlags();
    if (typeof flags?.recentActivityEnabled === "boolean") return flags.recentActivityEnabled;
  } catch {
    // Fall through to the boot-time effect below.
  }
  return deps.config?.recentActivityEnabled === true;
}

function recentActivityBootEnabled(deps) {
  // Older embedders/tests may pass only the mounted core; infer the boot state
  // from it rather than reporting a live core as disabled.
  return deps.recentActivityBootEnabled === undefined
    ? deps.recentActivity != null
    : deps.recentActivityBootEnabled === true;
}

function recentActivityRuntimeEnabled(deps) {
  if (recentActivityBootEnabled(deps) !== true) return false;
  if (!deps.recentActivity || typeof deps.recentActivity.status !== "function") return false;
  try {
    if (deps.recentActivity.status()?.ok !== true) return false;
  } catch {
    return false;
  }
  // A persisted explicit false denies model reads immediately through the core's
  // wrapped allowSession callback; the owner surface reports the same state.
  return recentActivityConfiguredEnabled(deps) === true;
}

function recentActivityWorkspaceState(deps) {
  const active = typeof deps.activeWorkspaceId === "string" && deps.activeWorkspaceId.trim() !== ""
    ? deps.activeWorkspaceId
    : null;
  let bindingKnown = false;
  let binding = null;
  if (typeof deps.controlRoot === "string" && deps.controlRoot.trim() !== "") {
    try {
      binding = readWorkspaceBinding(deps.controlRoot);
      bindingKnown = true;
    } catch {
      bindingKnown = false;
    }
  }
  const selected = bindingKnown
    ? (binding?.bound ? binding.workspaceId : null)
    : active;
  const staleBinding = Boolean(
    bindingKnown && active !== null && binding?.bound === true && selected !== active
  );
  const pendingBinding = bindingKnown && selected !== active;
  return {
    active,
    selected,
    bindingKnown,
    staleBinding,
    pendingBinding,
    runtimeMode: active === null ? "unbound" : "selected"
  };
}

function parseRecentActivityAllowlist(raw) {
  let list;
  try {
    list = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const ids = [];
  for (const entry of list.slice(0, RECENT_ACTIVITY_LIMITS.MAX_SHARED_TARGETS)) {
    if (typeof entry === "string" && entry.trim() !== "" && entry.length <= RECENT_ACTIVITY_LIMITS.MAX_ID_CHARS) {
      ids.push(entry);
    }
  }
  return [...new Set(ids)];
}

function recentActivityPolicyMap(deps, workspaceId) {
  const map = new Map();
  if (!workspaceId) return map;
  try {
    const rows = deps.store.db.prepare(
      `SELECT source_session_id AS sourceSessionId, mode, allowlist, enabled
         FROM recent_activity_source_policy
        WHERE workspace_id = ?`
    ).all(workspaceId);
    for (const row of rows) {
      const id = typeof row?.sourceSessionId === "string" ? row.sourceSessionId : null;
      if (!id) continue;
      const mode = row.mode === "owner" || row.mode === "shared" ? row.mode : "self";
      map.set(id, {
        enabled: Number(row.enabled) !== 0,
        mode,
        shared_session_ids: mode === "shared" ? parseRecentActivityAllowlist(row.allowlist) : []
      });
    }
  } catch {
    // The table is created by the core only after the feature is mounted. An
    // absent table means "no persisted policies yet", never an error page.
  }
  return map;
}

// The DSH session-title projection is optional display data. Strip control
// characters, collapse whitespace, and bound the result; never derive identity
// or authorization from this value.
function recentActivitySessionTitle(item) {
  const raw = item?.projections?.values?.title;
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const chars = Array.from(cleaned);
  return chars.length > MAX_SESSION_TITLE_CHARS
    ? chars.slice(0, MAX_SESSION_TITLE_CHARS).join("")
    : cleaned;
}

async function recentActivitySessionActivity(ctx) {
  let controller;
  try {
    controller = readOptionalService(ctx, "sessionController");
  } catch {
    controller = undefined;
  }
  if (!controller || typeof controller.list !== "function") {
    return { available: false, byId: new Map() };
  }
  let value;
  try {
    // The official SessionController.list is asynchronous and returns
    // `{ items: [...] }`. Await it once; never call per Session.
    value = await controller.list({});
  } catch {
    return { available: false, byId: new Map() };
  }
  const items = Array.isArray(value) ? value : (Array.isArray(value?.items) ? value.items : null);
  if (!items) return { available: false, byId: new Map() };
  const byId = new Map();
  for (const item of items) {
    const id = item?.sessionId;
    if (typeof id !== "string" || id.trim() === "") continue;
    // Host milliseconds must be a real, finite, nonnegative number. Do not
    // coerce null/""/Date/booleans to a timestamp.
    const rawUpdatedAt = item?.updatedAt;
    const updatedAt = typeof rawUpdatedAt === "number" &&
      Number.isFinite(rawUpdatedAt) && rawUpdatedAt >= 0
      ? rawUpdatedAt
      : null;
    const title = recentActivitySessionTitle(item);
    const previous = byId.get(id);
    if (previous === undefined) {
      byId.set(id, { updatedAt, title });
      continue;
    }
    if (updatedAt !== null && (previous.updatedAt === null || updatedAt > previous.updatedAt)) {
      previous.updatedAt = updatedAt;
    }
    // A later duplicate without the title projection must not erase a valid
    // display title; the ID remains authoritative either way.
    if (title !== null && previous.title === null) previous.title = title;
  }
  return { available: true, byId };
}

async function recentActivitySessions(deps, workspaceId, policyMap) {
  if (!workspaceId) {
    return { ok: false, reason: "no-active-workspace", sessions: [] };
  }
  const listed = listWorkspaceSessionIds(deps.ctx, workspaceId);
  if (!listed.ok) {
    return { ok: false, reason: listed.reason ?? "workspace-registry-unavailable", sessions: [] };
  }
  const live = new Set(listed.sessionIds);
  const activity = await recentActivitySessionActivity(deps.ctx);
  const sessions = listed.sessionIds.map((id) => {
    const policy = policyMap.get(id) ?? { enabled: true, mode: "self", shared_session_ids: [] };
    // Intersect by the exact Registry ID. A returned Host item only enriches a
    // Session already authorized by the Workspace Registry list.
    const metadata = activity.byId.get(id);
    return {
      id,
      title: metadata?.title ?? null,
      last_active_at: metadata?.updatedAt ?? null,
      enabled: policy.enabled,
      mode: policy.mode,
      shared_session_ids: policy.mode === "shared"
        ? policy.shared_session_ids.filter((target) => live.has(target))
        : []
    };
  });
  sessions.sort((a, b) => {
    const left = a.last_active_at ?? -Infinity;
    const right = b.last_active_at ?? -Infinity;
    if (left !== right) return right - left;
    return a.id.localeCompare(b.id);
  });
  return {
    ok: true,
    reason: "ok",
    sessions,
    lastActivityAvailable: activity.available
  };
}

function recentActivityStats(deps, liveSessionIds = null) {
  const config = recentActivityConfigDto(deps.settings.getRecentActivityConfig?.());
  let stats = null;
  try {
    stats = deps.recentActivity?.stats?.() ?? null;
  } catch {
    stats = null;
  }
  if (!stats || stats.ok !== true) {
    return {
      available: false,
      event_count: 0,
      source_counts: [],
      last_updated: null,
      summary_bytes: 0,
      policy_count: 0,
      config
    };
  }
  const sourceCounts = Array.isArray(stats.sourceCounts)
    ? stats.sourceCounts.map((row) => ({
        source_session_id: String(row?.sourceSessionId ?? ""),
        count: Number(row?.count) || 0
      })).filter((row) =>
        row.source_session_id !== "" &&
        liveSessionIds instanceof Set &&
        liveSessionIds.has(row.source_session_id)
      )
    : [];
  return {
    available: true,
    event_count: Number(stats.eventCount) || 0,
    source_counts: sourceCounts,
    last_updated: stats.lastUpdatedAt === null || stats.lastUpdatedAt === undefined
      ? null
      : (Number.isFinite(Number(stats.lastUpdatedAt)) ? Number(stats.lastUpdatedAt) : null),
    summary_bytes: Number(stats.summaryBytes) || 0,
    policy_count: Number(stats.policyCount) || 0,
    config
  };
}

async function recentActivitySnapshot(deps) {
  const workspace = recentActivityWorkspaceState(deps);
  const configuredEnabled = recentActivityConfiguredEnabled(deps);
  const runtimeEnabled = recentActivityRuntimeEnabled(deps);
  const featurePendingRestart = configuredEnabled === true && recentActivityBootEnabled(deps) !== true;
  const policyMap = recentActivityPolicyMap(deps, workspace.active);
  const sessionsState = await recentActivitySessions(deps, workspace.active, policyMap);
  const liveSessionIds = sessionsState.ok
    ? new Set(sessionsState.sessions.map((session) => session.id))
    : null;
  // The previous Recent card (trusted Scene buffer) is obsolete but its route
  // and data are kept for existing clients that still read this endpoint.
  const recentContext = recentContextConfig();
  const recentScenes = recentContextCounts().slice(0, 64);
  return {
    active_workspace_id: workspace.active,
    selected_workspace_id: workspace.selected,
    runtime_mode: workspace.runtimeMode,
    enabled: runtimeEnabled,
    configured_enabled: configuredEnabled,
    pending_restart: featurePendingRestart || workspace.pendingBinding,
    feature_pending_restart: featurePendingRestart,
    binding_pending_remount: workspace.pendingBinding,
    config: recentActivityConfigDto(deps.settings.getRecentActivityConfig?.()),
    stats: recentActivityStats(deps, liveSessionIds),
    sessions: sessionsState.sessions,
    sessions_available: sessionsState.ok,
    last_activity_available: sessionsState.lastActivityAvailable === true,
    ...(sessionsState.ok ? {} : { sessions_error: sessionsState.reason }),
    recent_context: {
      enabled: recentContext.enabled,
      ttl_ms: recentContext.ttlMs,
      max_events: recentContext.maxEvents,
      max_tokens: recentContext.maxTokens,
      scenes: recentScenes,
      total_events: recentScenes.reduce((sum, row) => sum + row.count, 0)
    },
    // Legacy top-level fields consumed by the old Recent card. New clients use
    // `stats`/`config`; keeping these avoids breaking an existing page while it
    // is replaced by the cross-Session recent-activity card.
    ttl_ms: recentContext.ttlMs,
    max_events: recentContext.maxEvents,
    scenes: recentScenes,
    total_events: recentScenes.reduce((sum, row) => sum + row.count, 0)
  };
}

function recentActivityMutationGate(deps) {
  const workspace = recentActivityWorkspaceState(deps);
  if (!workspace.active) {
    return {
      ok: false,
      status: 409,
      error: "a selected Workspace runtime is required before changing recent activity",
      reason: "no-active-workspace"
    };
  }
  if (workspace.staleBinding) {
    return {
      ok: false,
      status: 409,
      error: "the Workspace binding changed; restart or reload the plugin before changing recent activity",
      reason: "binding-pending-remount"
    };
  }
  return { ok: true, workspace };
}

function recentActivityLiveSessionIds(deps, workspace) {
  const listed = listWorkspaceSessionIds(deps.ctx, workspace.active);
  if (!listed.ok) {
    return {
      ok: false,
      status: 409,
      error: "the trusted Workspace Registry is unavailable or ambiguous",
      reason: listed.reason ?? "workspace-registry-unavailable"
    };
  }
  return { ok: true, ids: new Set(listed.sessionIds), sessionIds: listed.sessionIds };
}

function validateRecentActivityConfigBody(body) {
  const patch = {};
  let enabled;
  let count = 0;
  for (const [key, value] of Object.entries(body)) {
    count += 1;
    if (key === "enabled") {
      if (typeof value !== "boolean") {
        return { ok: false, error: "enabled must be a boolean" };
      }
      enabled = value;
      continue;
    }
    if (key === "ttl_hours") {
      if (!Number.isInteger(value) || !RECENT_ACTIVITY_LIMITS.TTL_HOURS.includes(value)) {
        return { ok: false, error: "ttl_hours must be one of 1, 6, 24, 72" };
      }
      patch[key] = value;
      continue;
    }
    if (key === "auto_inject") {
      if (typeof value !== "boolean") {
        return { ok: false, error: "auto_inject must be a boolean" };
      }
      patch[key] = value;
      continue;
    }
    if (key === "max_items") {
      if (!Number.isInteger(value) || value < 1 || value > RECENT_ACTIVITY_LIMITS.MAX_ITEMS) {
        return { ok: false, error: `max_items must be an integer in [1, ${RECENT_ACTIVITY_LIMITS.MAX_ITEMS}]` };
      }
      patch[key] = value;
      continue;
    }
    if (key === "max_tokens") {
      if (!Number.isInteger(value) ||
        value < RECENT_ACTIVITY_LIMITS.MIN_MAX_TOKENS ||
        value > RECENT_ACTIVITY_LIMITS.MAX_MAX_TOKENS) {
        return {
          ok: false,
          error: `max_tokens must be an integer in [${RECENT_ACTIVITY_LIMITS.MIN_MAX_TOKENS}, ${RECENT_ACTIVITY_LIMITS.MAX_MAX_TOKENS}]`
        };
      }
      patch[key] = value;
      continue;
    }
    return { ok: false, error: `unknown recent activity setting "${key}"` };
  }
  if (count === 0) return { ok: false, error: "at least one recent activity setting is required" };
  return { ok: true, patch, enabled };
}

function validateRecentActivityPolicyBody(body) {
  const source = body.source_session_id;
  if (typeof source !== "string" || source === "" || source.length > RECENT_ACTIVITY_LIMITS.MAX_ID_CHARS) {
    return { ok: false, error: "source_session_id must be an exact Session ID" };
  }
  let enabled;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return { ok: false, error: "enabled must be a boolean" };
    }
    enabled = body.enabled;
  }
  if (body.mode !== "self" && body.mode !== "owner" && body.mode !== "shared") {
    return { ok: false, error: "mode must be self, owner or shared" };
  }
  let sharedSessionIds = [];
  if (body.shared_session_ids !== undefined) {
    if (!Array.isArray(body.shared_session_ids) ||
      body.shared_session_ids.length > RECENT_ACTIVITY_LIMITS.MAX_SHARED_TARGETS) {
      return {
        ok: false,
        error: `shared_session_ids must be an array of up to ${RECENT_ACTIVITY_LIMITS.MAX_SHARED_TARGETS} exact Session IDs`
      };
    }
    for (const id of body.shared_session_ids) {
      if (typeof id !== "string" || id === "" || id.length > RECENT_ACTIVITY_LIMITS.MAX_ID_CHARS) {
        return { ok: false, error: "shared_session_ids must contain exact Session IDs" };
      }
    }
    sharedSessionIds = [...new Set(body.shared_session_ids)];
  }
  return {
    ok: true,
    source,
    enabled,
    mode: body.mode,
    sharedSessionIds: body.mode === "shared" ? sharedSessionIds : []
  };
}

function safeRecentPreview(result) {
  const source = result && typeof result === "object" ? result : {};
  const items = Array.isArray(source.items)
    ? source.items.map((item) => ({
        sourceSessionId: typeof item?.sourceSessionId === "string" ? item.sourceSessionId : "",
        kind: item?.kind === "agent_action" ? "agent_action" : "conversation",
        summary: typeof item?.summary === "string" ? item.summary : "",
        occurredAt: item?.occurredAt === null || item?.occurredAt === undefined
          ? null
          : (Number.isFinite(Number(item.occurredAt)) ? Number(item.occurredAt) : null),
        estimatedTokens: Number(item?.estimatedTokens) || 0
      }))
    : [];
  const ok = source.ok === true;
  return {
    ok,
    reason: typeof source.reason === "string" && source.reason !== ""
      ? source.reason
      : (ok ? "ok" : "recent-activity-unavailable"),
    items,
    count: items.length,
    estimatedTokens: Number(source.estimatedTokens) || 0,
    truncated: source.truncated === true
  };
}

function deniedRecentPreview(reason) {
  return safeRecentPreview({ ok: false, reason, items: [] });
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

function safeDreamRun(row) {
  if (!row) return null;
  return {
    run_type: row.run_type ?? null,
    status: row.status ?? null,
    created_at: row.created_at ?? null,
    error: row.error ?? null,
    summary: row.summary ?? null
  };
}

function lastDreamRuns(store) {
  try {
    return store.listDreamRuns({ limit: 5 }).map(safeDreamRun);
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
  const latestDream = safeDreamRun((() => {
    try { return store.latestDreamRun("auto"); } catch { return null; }
  })());
  const latestSleep = safeDreamRun((() => {
    try { return store.latestDreamRun("sleep"); } catch { return null; }
  })());
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
    last_dream: latestDream,
    last_sleep: latestSleep,
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
    if (path === "/unified") return send(res, 200, { ok: true, data: await unifiedDisplay(deps.ctx, unifiedSnapshot(deps)) });
    if (path === "/unified/graph") return send(res, 200, { ok: true, data: unifiedGraph(deps, url.searchParams.get("session_id")) });
    if (path === "/workspace") {
      return send(res, 200, { ok: true, data: workspaceSnapshot(deps) });
    }
    if (path === "/overview") return send(res, 200, { ok: true, data: overview(deps) });
    if (path === "/graph/scopes") {
      return send(res, 200, { ok: true, data: graphScopes(deps) });
    }
    if (path === "/graph") {
      const scopesRaw = String(url.searchParams.get("scopes") ?? "").trim();
      const edgeLimit = Number(url.searchParams.get("edge_limit") ?? 120);
      const nodeLimit = Number(url.searchParams.get("node_limit") ?? 80);
      if (scopesRaw) {
        const selected = scopesRaw === "all"
          ? graphScopes(deps).items.map((row) => row.scope)
          : scopesRaw.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 50);
        return send(res, 200, { ok: true, data: graphForScopes(deps, selected, edgeLimit, nodeLimit) });
      }
      const scope = String(url.searchParams.get("scope") ?? "").trim();
      if (!scope) return send(res, 400, { ok: false, error: "scope is required" });
      const graph = graphForScope(deps, scope, edgeLimit, nodeLimit);
      if (graph === null) return send(res, 400, { ok: false, error: "unknown scope" });
      return send(res, 200, { ok: true, data: graph });
    }
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
    if (path === "/recent/preview") {
      const gate = recentActivityMutationGate(deps);
      if (!gate.ok) {
        return send(res, gate.status, { ok: false, error: gate.error, reason: gate.reason });
      }
      const target = url.searchParams.get("target_session_id");
      if (typeof target !== "string" || target === "") {
        return send(res, 400, { ok: false, error: "target_session_id is required" });
      }
      if (!deps.recentActivity || typeof deps.recentActivity.previewRecentActivity !== "function") {
        return send(res, 409, {
          ok: false,
          error: "recent activity is not active in this runtime; restart after enabling it",
          reason: "recent-activity-unavailable"
        });
      }
      const live = recentActivityLiveSessionIds(deps, gate.workspace);
      if (!live.ok) {
        return send(res, live.status, { ok: false, error: live.error, reason: live.reason });
      }
      if (!live.ids.has(target)) {
        return send(res, 400, {
          ok: false,
          error: "target_session_id is not a Session in the active Workspace",
          reason: "unknown-session-id"
        });
      }
      if (recentActivityConfiguredEnabled(deps) !== true) {
        return send(res, 200, { ok: true, data: deniedRecentPreview("recent-activity-disabled") });
      }
      let preview;
      try {
        preview = deps.recentActivity.previewRecentActivity(
          { id: target },
          { includeSelf: url.searchParams.get("include_self") === "true" }
        );
      } catch {
        preview = { ok: false, reason: "preview-failed", items: [] };
      }
      return send(res, 200, { ok: true, data: safeRecentPreview(preview) });
    }
    if (path === "/recent") {
      return send(res, 200, { ok: true, data: await recentActivitySnapshot(deps) });
    }
    if (path === "/memories") {
      const q = String(url.searchParams.get("q") ?? "").trim();
      const archived = url.searchParams.get("archived") === "1";
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20));
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
      const selected = selectedSceneFilter(url);
      const typeFilter = String(url.searchParams.get("type") ?? "").trim();
      const minImportance = Number(url.searchParams.get("min_importance") ?? 0) || 0;
      const updatedFrom = String(url.searchParams.get("updated_from") ?? "").trim();
      const order = String(url.searchParams.get("order") ?? "").trim();
      const sceneScopes = selected ? [...selected] : null;
      const options = {
        limit, offset,
        includeArchived: archived, onlyArchived: archived, includeForgotten: false,
        ...(typeFilter ? { type: typeFilter } : {}),
        ...(minImportance ? { minImportance } : {}),
        ...(updatedFrom ? { updatedFrom } : {}),
        ...(order === "chrono" ? { order } : {}),
        ...(sceneScopes ? { sceneScopes } : {})
      };
      let rows;
      let total;
      if (q) {
        const searchOptions = {
          limit, offset,
          onlyArchived: archived,
          ...(typeFilter ? { type: typeFilter } : {}),
          ...(minImportance ? { minImportance } : {}),
          ...(updatedFrom ? { updatedFrom } : {}),
          ...(sceneScopes ? { sceneScopes } : {})
        };
        rows = deps.store.search(q, searchOptions);
        total = deps.store.countSearch(q, searchOptions);
      } else {
        rows = deps.store.list(options);
        total = deps.store.count(typeFilter || undefined, {
          includeArchived: archived, onlyArchived: archived, includeForgotten: false,
          ...(minImportance ? { minImportance } : {}),
          ...(updatedFrom ? { updatedFrom } : {}),
          ...(sceneScopes ? { sceneScopes } : {})
        });
      }
      const byId = new Map(rows.map((row) => [row.id, row]));
      const items = service.toApiList(rows, { includePreference: false })
        .map((row) => memorySummary(row, byId.get(row.id)));
      return send(res, 200, {
        ok: true,
        data: { items, total, archived, limit, offset, q, scenes: selected ? [...selected] : "all" }
      });
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
    if (path === "/acl") return send(res, 200, { ok: true, data: sceneAclState(deps) });
    if (path === "/personalization") {
      const agentId = url.searchParams.get("agent") || null;
      return send(res, 200, {
        ok: true,
        data: {
          profile: deps.settings.getProfile(),
          persona: deps.settings.getPersona(),
          preview: renderUserSettingsBlock({ settings: deps.settings, config: deps.config, agentId })
        }
      });
    }
    if (path === "/status") {
      const ov = overview(deps);
      const audit = typeof service.getLlmAuditStats === "function"
        ? service.getLlmAuditStats({ days: 7 })
        : null;
      return send(res, 200, {
        ok: true,
        data: {
          overview: ov,
          audit,
          dreams: typeof service.listDreamRuns === "function" ? service.listDreamRuns({ limit: 10 }) : [],
          conflicts: typeof service.countConflictPending === "function" ? service.countConflictPending() : null
        }
      });
    }
    return send(res, 404, { ok: false, error: "unknown admin endpoint" });
  }
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "method not allowed" });
  const body = await readJson(req);
  if (path === "/unified/mirror") return send(res, 200, { ok: true, data: service.recoverMirror() });
  if (path === "/unified") return send(res, 200, { ok: true, data: await unifiedDisplay(deps.ctx, saveUnifiedPolicy(deps, body)) });
  if (path === "/workspace") {
    const controlRoot = workspaceControlRoot(deps);
    const requested = body.workspace_id;
    if (typeof requested !== "string" || requested.trim() === "") {
      return send(res, 400, {
        ok: false,
        error: "workspace_id must be an exact Registry ID",
        reason: "invalid-workspace-id"
      });
    }
    const registry = workspaceRegistryState(deps.ctx);
    if (!registry.available) {
      return send(res, 503, {
        ok: false,
        error: "the trusted Workspace Registry is unavailable",
        reason: registry.reason
      });
    }
    const current = readWorkspaceBinding(controlRoot);
    const changing = !current.bound || current.workspaceId !== requested;
    if (changing && body.confirm !== true) {
      return send(res, 400, {
        ok: false,
        error: "confirm: true is required to change the selected Workspace",
        reason: "confirmation-required"
      });
    }
    const result = setWorkspaceBinding({
      memoryDir: controlRoot,
      workspaceId: requested,
      ctx: deps.ctx
    });
    if (!result.ok) {
      return send(res, workspaceSelectionStatus(result.reason), {
        ok: false,
        error: workspaceSelectionError(result.reason),
        reason: result.reason
      });
    }
    if (result.changed === true && deps.workspaceState) deps.workspaceState.changedSinceBoot = true;
    const data = workspaceSnapshot(deps);
    return send(res, 200, {
      ok: true,
      data: {
        ...data,
        changed: result.changed === true,
        old_workspace_id: result.oldWorkspaceId ?? null,
        ...(data.pending_remount
          ? { message: "Workspace binding saved; restart or reload the plugin to activate it" }
          : {})
      }
    });
  }
  if (path === "/personalization/profile") {
    if (typeof body.profile !== "string") return send(res, 400, { ok: false, error: "profile must be a string" });
    deps.settings.setProfile(body.profile);
    return send(res, 200, { ok: true, data: { profile: deps.settings.getProfile() } });
  }
  if (path === "/personalization/persona") {
    if (!body.persona || typeof body.persona !== "object" || Array.isArray(body.persona)) {
      return send(res, 400, { ok: false, error: "persona must be an object" });
    }
    deps.settings.setPersona(body.persona);
    return send(res, 200, { ok: true, data: { persona: deps.settings.getPersona() } });
  }
  if (path === "/acl/grant") {
    try {
      const pair = validateAclPair(deps, body);
      const result = deps.store.grantSceneRead(pair.reader, pair.source, { actor: "owner:settings", note: body.note });
      return send(res, 200, { ok: true, data: { ...result, state: sceneAclState(deps) } });
    } catch (error) {
      return send(res, Number(error?.status) || 400, { ok: false, error: error.message });
    }
  }
  if (path === "/acl/revoke") {
    try {
      const pair = validateAclPair(deps, body);
      const result = deps.store.revokeSceneRead(pair.reader, pair.source);
      return send(res, 200, { ok: true, data: { ...result, state: sceneAclState(deps) } });
    } catch (error) {
      return send(res, Number(error?.status) || 400, { ok: false, error: error.message });
    }
  }
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
  if (path === "/recent/config") {
    const gate = recentActivityMutationGate(deps);
    if (!gate.ok) {
      return send(res, gate.status, { ok: false, error: gate.error, reason: gate.reason });
    }
    const parsed = validateRecentActivityConfigBody(body);
    if (!parsed.ok) return send(res, 400, { ok: false, error: parsed.error });
    let nextConfig;
    let transactionOpen = false;
    try {
      deps.store.db.exec("SAVEPOINT recent_activity_config");
      transactionOpen = true;
      nextConfig = Object.keys(parsed.patch).length
        ? deps.settings.setRecentActivityConfig(parsed.patch)
        : deps.settings.getRecentActivityConfig();
      if (parsed.enabled !== undefined) {
        deps.settings.setFeatureFlags({ recentActivityEnabled: parsed.enabled });
      }
      deps.store.db.exec("RELEASE SAVEPOINT recent_activity_config");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) {
        try {
          deps.store.db.exec("ROLLBACK TO SAVEPOINT recent_activity_config");
          deps.store.db.exec("RELEASE SAVEPOINT recent_activity_config");
        } catch { /* preserve the original failure */ }
      }
      return send(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
    // TTL/item/token changes are live for the mounted cores. auto_inject is
    // consulted by inject.js on every prompt, so it never needs a restart.
    const coreConfig = {
      ttlHours: nextConfig.ttl_hours,
      maxItems: nextConfig.max_items,
      maxTokens: nextConfig.max_tokens
    };
    for (const core of [deps.recentActivity, deps.recentActivityAdmin]) {
      try {
        core?.configure?.(coreConfig);
      } catch {
        // Configuration was validated; a malformed core must not roll it back.
      }
    }
    return send(res, 200, { ok: true, data: await recentActivitySnapshot(deps) });
  }
  if (path === "/recent/policy") {
    const gate = recentActivityMutationGate(deps);
    if (!gate.ok) {
      return send(res, gate.status, { ok: false, error: gate.error, reason: gate.reason });
    }
    const parsed = validateRecentActivityPolicyBody(body);
    if (!parsed.ok) return send(res, 400, { ok: false, error: parsed.error });
    const live = recentActivityLiveSessionIds(deps, gate.workspace);
    if (!live.ok) {
      return send(res, live.status, { ok: false, error: live.error, reason: live.reason });
    }
    if (!live.ids.has(parsed.source)) {
      return send(res, 400, {
        ok: false,
        error: "source_session_id is not a Session in the active Workspace",
        reason: "unknown-session-id"
      });
    }
    for (const target of parsed.sharedSessionIds) {
      if (!live.ids.has(target)) {
        return send(res, 400, {
          ok: false,
          error: "shared_session_ids may only contain Sessions in the active Workspace",
          reason: "unknown-session-id"
        });
      }
    }
    // The admin core (when present) keeps policy management available while the
    // opt-in feature is disabled. The model core remains the read/preview
    // authority and is still wrapped by the immediate-disable callback.
    const core = deps.recentActivityAdmin ?? deps.recentActivity;
    if (!core || typeof core.setSourcePolicy !== "function") {
      return send(res, 409, {
        ok: false,
        error: "recent activity is not active in this runtime; restart after enabling it",
        reason: "recent-activity-unavailable"
      });
    }
    const policyInput = {
      mode: parsed.mode,
      sharedSessionIds: parsed.sharedSessionIds
    };
    if (parsed.enabled !== undefined) policyInput.enabled = parsed.enabled;
    let result;
    try {
      result = core.setSourcePolicy({ id: parsed.source }, policyInput);
    } catch {
      result = { ok: false, reason: "policy-write-failed" };
    }
    if (!result?.ok) {
      return send(res, 409, {
        ok: false,
        error: "the recent activity policy was not saved",
        reason: typeof result?.reason === "string" ? result.reason : "policy-write-failed"
      });
    }
    const snapshot = await recentActivitySnapshot(deps);
    return send(res, 200, {
      ok: true,
      data: {
        source_session_id: parsed.source,
        enabled: result.enabled !== false,
        mode: result.mode === "owner" || result.mode === "shared" ? result.mode : "self",
        shared_session_ids: Array.isArray(result.sharedSessionIds) ? result.sharedSessionIds : [],
        policy: {
          enabled: result.enabled !== false,
          mode: result.mode === "owner" || result.mode === "shared" ? result.mode : "self",
          shared_session_ids: Array.isArray(result.sharedSessionIds) ? result.sharedSessionIds : []
        },
        state: snapshot
      }
    });
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
  // Live for this mounted plugin instance only. It records that a selection
  // changed, including a change back to the original ID, so the response cannot
  // claim the runtime is active before the plugin is remounted.
  const workspaceState = { changedSinceBoot: false };
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
            // `ctx` is the trusted plugin context: the Workspace Registry and
            // binding validation must never come from request data.
            return await handle(req, res, { ...deps, ctx, workspaceState });
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
