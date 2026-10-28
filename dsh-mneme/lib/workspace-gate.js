// Mneme-lite Workspace membership gate.
//
// Trust boundary: the only authorization inputs are the trusted DSH session's
// stable string `id` and the trusted Workspace Registry's stable workspace `id`
// plus its `sessionIds` membership list. Titles, directories, presets, session
// headers, caller JSON and request fields are never consulted.
//
// The registry is read fresh on every call. Nothing is cached: a session that
// was just added or moved between workspaces must take effect immediately.
// Every accessor is guarded; absence, malformed data, ambiguity and throws all
// deny. This module has no side effects and performs no database operations.

/**
 * Read an optional Cordis service without `inject`. In Cordis 4, reading an
 * undeclared ctx property throws; `ctx.reflect.get` is the supported opt-out.
 * Plain mock contexts (tests, older hosts) fall back to a direct property read.
 * @param {object} ctx
 * @param {string} name
 * @returns {*}
 */
function readOptionalService(ctx, name) {
  try {
    if (typeof ctx?.reflect?.get === "function") return ctx.reflect.get(name);
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

function stableId(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function displayTitle(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function sessionIdsOf(value) {
  if (!Array.isArray(value)) return null;
  const ids = [];
  const seen = new Set();
  for (const entry of value) {
    const id = stableId(entry);
    if (id === null) return null;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function sessionIdOf(session) {
  try {
    return stableId(session?.id);
  } catch {
    return null;
  }
}

// Normalize the registry once per call. Invalid entries are never exposed;
// they are counted as `malformed` so the authorization path can fail closed.
// Duplicate workspace IDs are both malformed and ambiguous.
function readRegistry(ctx) {
  let rawList;
  try {
    const registry = readOptionalService(ctx, "workspaceRegistry");
    if (typeof registry?.list !== "function") {
      return { ok: false, reason: "registry-unavailable" };
    }
    rawList = registry.list();
  } catch {
    return { ok: false, reason: "registry-unavailable" };
  }
  if (!Array.isArray(rawList)) return { ok: false, reason: "malformed-registry" };

  const workspaces = [];
  const ids = new Set();
  const duplicateIds = new Set();
  let malformed = false;

  for (const raw of rawList) {
    let id;
    let sessionIds;
    try {
      id = stableId(raw?.id);
      sessionIds = sessionIdsOf(raw?.sessionIds);
    } catch {
      malformed = true;
      continue;
    }
    if (id === null || sessionIds === null) {
      malformed = true;
      continue;
    }
    // A display title is never authorization evidence. A blank or throwing
    // title must not disable a valid Workspace's model access.
    let title = null;
    try { title = displayTitle(raw?.title); } catch { /* display fallback */ }
    if (ids.has(id)) {
      duplicateIds.add(id);
      malformed = true;
    }
    ids.add(id);
    workspaces.push({ id, title: title ?? id, sessionIds });
  }

  return { ok: true, workspaces, malformed, duplicateIds };
}

/**
 * List normalized workspaces from the trusted registry. Returns only
 * `{ id, title, sessionCount }`; a missing or unreadable registry yields `[]`.
 * Malformed entries and duplicate-ID workspaces are omitted.
 * @param {object} ctx trusted DSH context
 * @returns {{id: string, title: string, sessionCount: number}[]}
 */
export function listWorkspaces(ctx) {
  const state = readRegistry(ctx);
  if (!state.ok) return [];
  return state.workspaces
    .filter((workspace) => !state.duplicateIds.has(workspace.id))
    .map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      sessionCount: workspace.sessionIds.length
    }));
}

/**
 * List stable Session IDs in one selected Workspace for the authenticated
 * owner panel. The same strict Registry checks as model admission apply, so a
 * malformed or ambiguous Registry never becomes an incomplete permission list.
 * This is metadata only; callers must still authorize each actual Host Session
 * immediately before any memory read or write.
 */
export function listWorkspaceSessionIds(ctx, selectedWorkspaceId) {
  const selectedId = stableId(selectedWorkspaceId);
  if (selectedId === null) return { ok: false, reason: "missing-workspace-id", sessionIds: [] };
  const state = readRegistry(ctx);
  if (!state.ok) return { ok: false, reason: state.reason, sessionIds: [] };
  if (state.duplicateIds.size > 0) return { ok: false, reason: "ambiguous-registry", sessionIds: [] };
  if (state.malformed) return { ok: false, reason: "malformed-registry", sessionIds: [] };
  const selected = state.workspaces.find((workspace) => workspace.id === selectedId);
  if (!selected) return { ok: false, reason: "workspace-not-found", sessionIds: [] };
  const otherIds = new Set(state.workspaces
    .filter((workspace) => workspace.id !== selectedId)
    .flatMap((workspace) => workspace.sessionIds));
  if (selected.sessionIds.some((sessionId) => otherIds.has(sessionId))) {
    return { ok: false, reason: "ambiguous-membership", sessionIds: [] };
  }
  return { ok: true, reason: "ok", workspaceId: selectedId, sessionIds: [...selected.sessionIds] };
}

function deny(reason) {
  return { allowed: false, reason, workspaceId: null };
}

/**
 * Per-request membership check. Allows only when the trusted session's stable
 * ID belongs to exactly one valid registry workspace and that workspace's
 * stable ID exactly equals the configured workspace ID. The registry is read
 * fresh on every invocation.
 * @param {object} session trusted DSH session (only `session.id` is read)
 * @param {string} selectedWorkspaceId configured single workspace ID
 * @param {object} ctx trusted DSH context
 * @returns {{allowed: boolean, reason: string, workspaceId: string|null}}
 */
export function checkWorkspaceAccess(session, selectedWorkspaceId, ctx) {
  const selectedId = stableId(selectedWorkspaceId);
  if (selectedId === null) return deny("missing-workspace-id");

  const sessionId = sessionIdOf(session);
  if (sessionId === null) return deny("missing-session-id");

  const state = readRegistry(ctx);
  if (!state.ok) return deny(state.reason);
  if (state.duplicateIds.size > 0) return deny("ambiguous-registry");
  if (state.malformed) return deny("malformed-registry");

  const matches = state.workspaces.filter((workspace) =>
    workspace.sessionIds.includes(sessionId)
  );
  if (matches.length === 0) return deny("session-not-found");
  if (matches.length > 1) return deny("ambiguous-membership");
  if (matches[0].id !== selectedId) return deny("workspace-mismatch");

  return { allowed: true, reason: "ok", workspaceId: matches[0].id };
}
