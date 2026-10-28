// Central QQ long-term-memory model-access boundary.
//
// Workspace membership alone is not proof that a DSH Session is a non-QQ
// Session. This module wraps the existing Workspace authorization closure and
// adds one runtime question: what does the in-process QQ Host say about this
// exact Session ID?
//
// Trust rules:
//  - Only the trusted Session's stable `id` is sent to the Host. A positive QQ
//    binding is authoritative even for an ordinary-looking preset.
//  - The only preset consulted is the frozen `session.header.agentPreset`; tool
//    arguments, Session titles and caller JSON are never read.
//  - A verified QQ Scene is allowed only when both strict Scene switches are on
//    at execution time. Otherwise QQ model work fails closed.
//  - A known `amadeus-qq*` preset without a valid Host binding always fails
//    closed, regardless of Scene settings.
//  - A present QQ Host that cannot resolve an unknown/custom preset fails
//    closed unless the preset is one of the known ordinary DSH presets.
//
// This module does not change retrieval, storage or Hot Memory behavior. It
// only returns the allow/deny decision consumed by the existing
// `authorizeModelWork` closure in index.js.

import { mintTrustedScene } from "./scene.js";

export const QQ_SCENE_PRESETS = new Set([
  "amadeus-qq",
  "amadeus-qq-search",
  "amadeus-qq-media",
  "amadeus-qq-media-search",
  "amadeus-qq-owner"
]);
export const ORDINARY_DSH_PRESETS = new Set([
  "standard",
  "minimal",
  "creator",
  "creative",
  "default"
]);
const QQ_PRESET_PREFIX = "amadeus-qq";

function readOptionalHostService(ctx, name) {
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

function sessionIdOf(session) {
  try {
    return stableId(session?.id);
  } catch {
    return null;
  }
}

// Only the frozen Session header is consulted. A throwing or missing header is
// unknown provenance, never an error that widens access.
function sessionPresetOf(session) {
  try {
    return stableId(session?.header?.agentPreset)?.trim() ?? null;
  } catch {
    return null;
  }
}

function strictSceneMode(config) {
  try {
    return config?.sceneIsolationEnabled === true && config?.sceneStrictQQ === true;
  } catch {
    return false;
  }
}

function isKnownQQPreset(preset) {
  return typeof preset === "string" &&
    (QQ_SCENE_PRESETS.has(preset) || preset.startsWith(QQ_PRESET_PREFIX));
}

function isOrdinaryPreset(preset) {
  return typeof preset === "string" && ORDINARY_DSH_PRESETS.has(preset);
}

function resolveVerifiedQQScene(ctx, session) {
  const qq = readOptionalHostService(ctx, "qq");
  const hostPresent = qq !== undefined && qq !== null;
  let scene = null;
  if (typeof qq?.resolveTrustedSessionScene === "function") {
    try {
      const sessionId = sessionIdOf(session);
      if (sessionId !== null) {
        const minted = mintTrustedScene(qq.resolveTrustedSessionScene(sessionId));
        if (minted.platform === "qq") scene = minted;
      }
    } catch {
      scene = null;
    }
  }
  return { hostPresent, scene };
}

/**
 * Pure boundary decision for one trusted Session. This does not consult the
 * Workspace registry; callers must still authorize Workspace membership after
 * this returns `allowed: true`.
 * @param {object} session trusted DSH Session (only `id` and
 *   `header.agentPreset` are read)
 * @param {object} ctx trusted DSH context (optional `qq` service)
 * @param {object} config live Mneme config (`sceneIsolationEnabled`, `sceneStrictQQ`)
 * @returns {{allowed: boolean, reason: string, classification: string}}
 */
export function evaluateQQModelBoundary(session, ctx, config) {
  const preset = sessionPresetOf(session);
  const strictMode = strictSceneMode(config);
  const { hostPresent, scene } = resolveVerifiedQQScene(ctx, session);

  // A positive Host binding wins over every preset name. It is still only a
  // QQ Scene capability: strict-enforced visibility is required, and the
  // Workspace membership check still runs afterwards.
  if (scene) {
    return strictMode
      ? { allowed: true, reason: "ok", classification: "qq" }
      : { allowed: false, reason: "qq-scene-mode-required", classification: "qq" };
  }

  // Known QQ provenance must never fall back to unscoped long-term memory.
  if (isKnownQQPreset(preset)) {
    return { allowed: false, reason: "qq-host-unbound", classification: "qq" };
  }

  // A Host that is installed but cannot bind this Session is ambiguous for a
  // renamed/custom preset. Keep ordinary DSH sessions working; fail closed for
  // everything else. The same fail-closed rule applies to unknown provenance in
  // strict Scene mode even before a Host is installed.
  if (!isOrdinaryPreset(preset) && (hostPresent || strictMode)) {
    return { allowed: false, reason: "qq-preset-unverified", classification: "unknown" };
  }

  return { allowed: true, reason: "ok", classification: "ordinary" };
}

/**
 * Build the runtime `authorizeModelWork` closure used by the injector, model
 * tools, autoSummarize and event-derived writers.
 *
 * The QQ Host is consulted on every call (never cached) and the wrapped
 * Workspace guard is still responsible for the stable Workspace membership and
 * binding checks. Any throw denies.
 * @param {object} options
 * @param {object} options.ctx trusted DSH context
 * @param {object} options.config live Mneme config
 * @param {(session: object) => object} [options.authorizeWorkspace] existing
 *   Workspace guard closure, or an object exposing `.authorize`
 * @param {object} [options.workspaceGuard] alias for the guard object
 * @param {object} [options.logger]
 * @returns {(session: object) => {allowed: boolean, reason: string, workspaceId: string|null}}
 */
export function createQQModelAccessGate({
  ctx,
  config,
  authorizeWorkspace = null,
  workspaceGuard = null,
  logger = null
} = {}) {
  const suppliedGuard = authorizeWorkspace ?? workspaceGuard;
  const authorize = typeof suppliedGuard === "function"
    ? suppliedGuard
    : typeof suppliedGuard?.authorize === "function"
      ? suppliedGuard.authorize.bind(suppliedGuard)
      : null;
  let lastLogged = null;

  const logOnce = (reason) => {
    if (reason === lastLogged) return;
    lastLogged = reason;
    try {
      logger?.warn?.(`[dsh-mneme] QQ model access denied: ${reason}`);
    } catch {
      // Logging must never change the authorization result.
    }
  };

  return function authorizeModelWork(session) {
    if (!authorize) {
      return { allowed: false, reason: "workspace-guard-unavailable", workspaceId: null };
    }

    let boundary;
    try {
      boundary = evaluateQQModelBoundary(session, ctx, config);
    } catch {
      boundary = null;
    }
    if (boundary?.allowed !== true) {
      const reason = boundary?.reason ?? "qq-boundary-check-failed";
      logOnce(reason);
      return { allowed: false, reason, workspaceId: null };
    }

    let access;
    try {
      access = authorize(session);
    } catch {
      access = null;
    }
    if (access?.allowed !== true) {
      const reason = access?.reason ?? "access-check-failed";
      logOnce(reason);
      return { allowed: false, reason, workspaceId: null };
    }

    return { allowed: true, reason: "ok", workspaceId: access.workspaceId ?? null };
  };
}

// Readable alias for callers that only know the central model-access concept.
export const createModelAccessGate = createQQModelAccessGate;
