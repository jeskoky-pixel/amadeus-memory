import { createUnifiedRuntime } from "./unified-runtime.js";
import { createStore } from "./store.js";
import { createMirror, TYPE_FILE } from "./mirror.js";
import { createDocumentIndex } from "./document-index.js";
import { resolveDocumentDir } from "./document.js";
// #368 v1：profile 作用域落点检测（只提示，不改行为）。
import { findProfileScopeSegment } from "./placement.js";
import { createService } from "./service.js";
// #254 写入准入（第一阶段只计量，不拦截）：见 src/write-admission.js 的文件头。
import { createWriteAdmission } from "./write-admission.js";
// #164 A2：写入边界的密钥 / PII 判据，注入给上面的写入准入。
import { createSensitiveScan } from "./sensitive-scan.js";
import { createTools } from "./tools.js";
import { createInjector } from "./inject.js";
import { createPreInjectGate } from "./pre-inject-gate.js";
import { createContinuityRescue } from "./continuity.js";
import { createSummarizer } from "./summarize.js";
import { createDreamScheduler, describeStreamFailure, recordScopedDreamBaseline } from "./dream.js";
import { createSleepScheduler, runSleep } from "./dream/sleep.js";
import { createApi } from "./api.js";
// #275 存储生命周期第一批：无损回收（手动入口，不挂启动路径）。
import { createMaintenance } from "./maintenance.js";
import { createSettings, RETIRED_FEATURE_FLAGS } from "./settings.js";
import { configureScene, mintTrustedScene, setSceneReadAclReader } from "./scene.js";
import { runWithSceneJob, LEGACY_SCENE_JOB, scopedSleepOutcome } from "./scene-job.js";
import { configureRecentContext } from "./recent-context.js";
import { createRecentActivityCore } from "./recent-activity.js";
import { mountAdminApi } from "./admin-api.js";
import { applyStagedRestore } from "./backup.js";
import { createCommandManager } from "./commands.js";
import { createExecutionRecorder } from "./pipeline-runner.js";
import { registerMoRunCommand } from "./pipeline-command.js";
// M.O. 自动沉淀的触发侧（冷却 / 排队 / 兜底）。挖掘与落盘在 pipeline-nudge.js，
// 这里只管「什么时候跑」。两者分开的理由见 src/pipeline-nudge-auto.js 文件头。
import { createNudgeAutoRun } from "./pipeline-nudge-auto.js";
import { createVectorIndex } from "./vector-index.js";
// semantic(embedder/reranker/boot 回填)纯搬移至 src/semantic.js(PR2):宿主与
// daemon(dsh-mneme-serve,#363)共用同一套装配,原文件保留 barrel 出口。
import { createSemantic } from "./semantic.js";
import { Config, applyLightModePreset, injectChildEnabled } from "./config.js";
import { langOf } from "./lang.js";
import { extractEntities } from "./entities/extractor.js";
import { createProfileExtractor } from "./profile-extract.js";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import {
  UNBOUND_CONTROL_DIR,
  createWorkspaceAccessGuard,
  initializeWorkspaceDataDir,
  readWorkspaceBinding
} from "./workspace-binding.js";
import { listWorkspaces } from "./workspace-gate.js";
import { createQQModelAccessGate, ORDINARY_DSH_PRESETS } from "./qq-model-boundary.js";

export const name = "dsh-mneme";
// webServer 在 inject 声明中：cordis 会等宿主 webServer 服务激活后才 apply 本
// 插件，保证 apply 时路由注册不落时序（v0.7.23 曾移出 inject 想支持 headless，
// 结果 cordis 不再等待，apply 时宿主 webServer 未就绪 → 桌面端 "cannot get
// property without inject" 崩溃）。守卫用 ctx.reflect.get（免 inject 读取，
// 未提供返回 undefined）而非 if (ctx.webServer)：直接访问未注入属性在 cordis
// Proxy 下会抛错而非返回 undefined。
export const inject = ["tools", "systemPrompt", "llm", "agentDefaultModel", "commands", "webServer"];
export { Config };

// Arrow (not function declaration): cordis 4 treats any apply with a
// prototype as a class constructor (`new apply(...)`) and discards its return
// value, so a `function apply` disposer would never run on unload. An arrow
// has no prototype, is called normally, and its returned disposer is collected
// and run by the fiber on unload.
// Entity-extraction LLM adapter (issue #108/#109): maps the extractor's
// options (provider/model override + reasoningEffort) onto a real dsh-llm
// stream route and retries once without the effort when the first attempt is
// rejected. Extracted from apply() so the effort-fallback branch is
// unit-testable; the extractor only ever sees a callLLM(messages, options)
// => Promise<string>. The route always carries a real provider/model (dsh-llm
// GenerateOptions requires both) — never a bare stream.
//
// Issue #250: it also accounts for itself. Entity extraction is the background
// LLM path that runs on every memory write, yet it never reached
// llm_audit_logs — the adapter only ever held an llm handle, so it had no way
// to call service.saveLlmAudit. It now takes service (+ config for the shared
// llmAudit.enabled gate) and writes one row per stream attempt, matching the
// contract of runAuditedLlm in dream.js: a rejected effort attempt records its
// own error row and the retry records its own success row.
export function createEntityStreamAdapter({ llm, agentDefaultModel, logger, service, config }) {
  return async function streamEntityText(messages, options = {}) {
    let route = {};
    if (options.provider) route.provider = options.provider;
    if (options.model) route.model = options.model;
    if (!route.provider || !route.model) {
      try {
        const sel = agentDefaultModel?.currentSelection?.();
        if (sel?.provider && sel?.model) {
          route.provider ??= sel.provider;
          route.model ??= sel.model;
        }
      } catch { /* fall through to whatever route we already have */ }
    }
    const effort = options.reasoningEffort;
    // #405: 审计行的 related_memory_ids 此前恒空、error_message 又被压成一句常量，
    // 于是「哪条记忆没抽到实体、为什么」在库里查不出来（主库 735 条 error 行全是
    // 同一句话）。id 由 extractor 顺 options 传下来——它只认 memory.content，不认
    // id。口径同 write-admission:350：拿不到 id 就留空，绝不挂不存在的 id 造虚账。
    const relatedMemoryIds = options.memoryId ? [options.memoryId] : [];
    // 没有解析出 provider/model 就没有可归属的模型——与 dream 的 resolveRoute
    // 无路由早退同口径，那种情况不写审计行。
    const modelId = route.provider && route.model ? `${route.provider}:${route.model}` : "";
    const tryStream = (withEffort) => {
      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      const startedAt = Date.now();
      const timestamp = new Date(startedAt).toISOString();
      // 记账是 best-effort：写审计行失败只 warn，绝不反噬抽取本身（CONTRIBUTING
      // 的 fail-safe 硬约定）。
      const writeAudit = (status, errorMessage, relatedMemoryIds = []) => {
        if (config?.llmAudit?.enabled === false || typeof service?.saveLlmAudit !== "function") return;
        // #372: modelId 为空 = 路由解析失败——此前整个 writeAudit 静默 return，
        // llm.stream 抛错也留不下任何行，正是 #108 要消灭的「零实体零日志」同款盲区。
        // 空路由无法记账，但至少要留一条可解释的 warn，别让失败面完全不可见。
        if (!modelId) {
          if (status !== "ok") logger?.warn?.(`dsh-mneme: entity extraction ${status} without audit row (llm route unresolved: ${errorMessage ?? "no route"})`);
          return;
        }
        try {
          service.saveLlmAudit({
            timestamp,
            trigger_source: "entityExtract",
            operation_type: "entity_extract",
            model_id: modelId,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            cost_usd: 0,
            duration_ms: Date.now() - startedAt,
            status,
            error_message: errorMessage,
            related_memory_ids: relatedMemoryIds
          });
        } catch (auditError) {
          logger?.warn?.(`dsh-mneme: entity extraction llm audit write failed: ${String(auditError)}`);
        }
      };
      return (async () => {
        for await (const chunk of llm.stream({
          ...route,
          maxTokens: 4096,
          ...(withEffort && effort ? { reasoningEffort: effort } : {}),
          messages
        })) {
          if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
          // DSH 的 StreamChunk 契约把用量嵌在 chunk.usage（TokenUsage）；兼容直接
          // 平铺在 chunk 上的旧形态。归一放在这里，下面只需认平铺形状——与
          // dream.js 的 streamText 同一处理。
          if (chunk.type === "usage") {
            const u = chunk.usage ?? chunk;
            const i = u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? u.promptTokens;
            const o = u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? u.completionTokens;
            if (Number.isFinite(i)) inputTokens = i;
            if (Number.isFinite(o)) outputTokens = o;
          }
          if (chunk.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
            writeAudit("error", describeStreamFailure(chunk.reason) || "llm stream aborted or errored", relatedMemoryIds);
            return undefined;
          }
        }
        writeAudit("success", null);
        return text;
      })().catch((err) => {
        logger?.warn?.(`[dsh-mneme] entity extraction llm stream failed: ${String(err)}`);
        writeAudit("error", String(err?.message ?? err), relatedMemoryIds);
        return undefined;
      });
    };
    let text = await tryStream(true);
    if (text === undefined && effort) {
      // Mirror dream's effort fallback: a provider rejecting the reasoning
      // effort must not sink the whole extraction — retry once without it.
      logger?.warn?.(`[dsh-mneme] entity extraction: reasoningEffort "${effort}" rejected, retrying without it`);
      text = await tryStream(false);
    }
    return text;
  };
}

// backfillMissingEmbeddings 已随语义装配整体搬至 src/semantic.js(纯搬移);
// 保留 barrel 再出口 —— test/reindex-backfill.test.js 仍从本模块 import,调用方零改动。
export { backfillMissingEmbeddings } from "./semantic.js";

// DSH Config Forms serves *only* fields marked volatile. The fields listed in
// the native settings page are marked volatile in config.js, so Config() yields
// stable references for them. This adapter dereferences those references on
// every read, while preserving feature-flag precedence and light-mode behavior.
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");
function isVolatileRef(value) {
  return Boolean(value && typeof value === "object" &&
    typeof value.get === "function" && VOLATILE_WRITE in value);
}
function plainConfigValue(value) {
  if (isVolatileRef(value)) return plainConfigValue(value.get());
  if (Array.isArray(value)) return value.map(plainConfigValue);
  if (value && typeof value === "object") {
    try {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfigValue(child)]));
    } catch {
      return value;
    }
  }
  return value;
}
function createLiveConfig(rawCfg, flatFlags, nestedFlags) {
  const read = (prop) => {
    if (typeof prop !== "string") return rawCfg[prop];
    if (Object.hasOwn(flatFlags, prop)) return flatFlags[prop];
    if (Object.hasOwn(nestedFlags, prop)) {
      return { ...(plainConfigValue(rawCfg[prop]) ?? {}), ...nestedFlags[prop] };
    }
    return plainConfigValue(rawCfg[prop]);
  };
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      return read(prop);
    },
    has(_target, prop) { return prop in rawCfg || prop in flatFlags || prop in nestedFlags; },
    ownKeys() {
      return [...new Set([...Reflect.ownKeys(rawCfg), ...Object.keys(flatFlags), ...Object.keys(nestedFlags)])];
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (prop in rawCfg || prop in flatFlags || prop in nestedFlags) {
        return { enumerable: true, configurable: true, get: () => read(prop) };
      }
      return undefined;
    }
  });
}

const TRUSTED_SCENE_ACL_CONTRACT = "amadeus-memory/trusted-scene-acl-read";
const TRUSTED_SCENE_ACL_TOOLS = Object.freeze(["memory_search", "memory_list", "memory_get"]);

/**
 * Optional cross-plugin handshake. This is a synchronous capability declaration,
 * not an authorization input: callers cannot ask for it with arguments, and the
 * Host binding must already be present. It returns null unless strict QQ Scene
 * isolation is effective in this running instance.
 */
export function sceneAclReadDeclaration(ctx, cfg, unifiedReady = false) {
  try {
    if (!(unifiedReady && cfg?.unifiedSessionAclEnabled === true) &&
        (cfg?.sceneIsolationEnabled !== true || cfg?.sceneStrictQQ !== true)) return null;
    const qq = ctx?.reflect?.get?.("qq");
    if (typeof qq?.resolveTrustedSessionScene !== "function") return null;
    return Object.freeze({
      contract: TRUSTED_SCENE_ACL_CONTRACT,
      version: 1,
      trustedSceneAcl: true,
      strictQQ: true,
      tools: TRUSTED_SCENE_ACL_TOOLS
    });
  } catch {
    return null;
  }
}

export function provideSceneAclRead(ctx, cfg, unifiedReady = false) {
  if (typeof ctx?.provide !== "function") return () => {};
  try {
    let disposed = false;
    const dispose = ctx.provide("amadeus.memory", Object.freeze({
      sceneAclRead: () => sceneAclReadDeclaration(ctx, cfg, unifiedReady)
    }));
    return async () => {
      if (disposed) return;
      disposed = true;
      if (typeof dispose === "function") await dispose();
    };
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-mneme] optional amadeus.memory handshake unavailable: ${String(error?.message ?? error)}`);
    return () => {};
  }
}

/**
 * Read an optional Cordis service without `inject`. Cordis 4 throws on a bare
 * read of an undeclared ctx property; `ctx.reflect.get` is the supported
 * opt-out. Plain mock contexts (tests, older hosts) fall back to a property
 * read. Any failure means "service absent", never an error in a caller.
 * @param {object} ctx
 * @param {string} name
 * @returns {*}
 */
function readOptionalHostService(ctx, name) {
  try {
    if (typeof ctx?.reflect?.get === "function") return ctx.reflect.get(name);
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

/**
 * Resolve a Session ID through the live DSH Session Store (`ctx.sessions`).
 *
 * This is the trusted Host identity source for cross-Session recent activity.
 * It is deliberately read through `reflect.get` so an older Host without the
 * service is not an error, and it returns only the live Session object whose
 * immutable header the Host owns. A missing service, missing Session, throwing
 * getter or ID mismatch yields null; callers must then fail closed. A caller
 * can supply an ID as a lookup key, but never the object or header used for
 * authorization.
 * @param {object} ctx trusted DSH context
 * @returns {(sessionId: string) => object|null}
 */
export function createTrustedSessionResolver(ctx) {
  return function resolveTrustedSession(sessionId) {
    try {
      if (typeof sessionId !== "string" || sessionId.trim() === "") return null;
      const sessions = readOptionalHostService(ctx, "sessions");
      if (typeof sessions?.get !== "function") return null;
      const session = sessions.get(sessionId);
      if (session === null || typeof session !== "object") return null;
      if (session.id !== sessionId) return null;
      return session;
    } catch {
      return null;
    }
  };
}

/**
 * Build the Host-authenticated owner predicate for the recent-activity
 * `owner` sharing mode.
 *
 * The only acceptance input is the actual Session's stable ID resolved through
 * the optional Amadeus QQ Host service. A scene counts as owner only when that
 * Host returns exactly `platform: "qq"`, `kind: "private"` and `admin: true`;
 * Session titles, presets, model arguments or HTTP fields are never consulted.
 * QQ is optional: a missing service, a missing method, a throw or any other
 * scene shape all yield false.
 * @param {object} ctx trusted DSH context
 * @returns {(session: object) => boolean}
 */
export function createRecentActivityOwnerCheck(ctx) {
  return function isRecentActivityOwner(session) {
    try {
      const sessionId = session?.id;
      if (typeof sessionId !== "string" || sessionId.trim() === "") return false;
      const qq = readOptionalHostService(ctx, "qq");
      if (typeof qq?.resolveTrustedSessionScene !== "function") return false;
      const scene = qq.resolveTrustedSessionScene(sessionId);
      return scene?.platform === "qq"
        && scene?.kind === "private"
        && scene?.verified === true
        && scene?.admin === true;
    } catch {
      return false;
    }
  };
}

/**
 * Raw recent summaries obey the QQ Scene boundary independently of Workspace
 * membership. The QQ Host is consulted afresh for both exact Session IDs; a
 * malformed/throwing binding fails closed. Ordinary DSH Sessions may share
 * with each other, while a verified Owner private Scene may read all sources.
 */
export function createRecentActivityPairGate(ctx) {
  const resolveTrustedSession = createTrustedSessionResolver(ctx);
  return function allowRecentPair(sourceSessionId, targetSessionId) {
    try {
      if (typeof sourceSessionId !== "string" || typeof targetSessionId !== "string") return false;
      const qq = readOptionalHostService(ctx, "qq");
      if (qq === undefined || qq === null) return true;
      if (typeof qq.resolveTrustedSessionScene !== "function") return false;
      const resolve = (id) => {
        let raw = null;
        try {
          raw = qq.resolveTrustedSessionScene(id);
        } catch {
          // QQ throws for an unbound ordinary DSH Session. Its frozen Host
          // header must prove ordinary provenance; unknown/QQ presets deny.
        }
        if (raw !== null && raw !== undefined) return { scene: mintTrustedScene(raw) };
        const session = resolveTrustedSession(id);
        const preset = session?.header?.agentPreset;
        return typeof preset === "string" && ORDINARY_DSH_PRESETS.has(preset.trim())
          ? { ordinary: true }
          : null;
      };
      const source = resolve(sourceSessionId);
      const target = resolve(targetSessionId);
      if (!source || !target) return false;
      if (target.scene?.platform === "qq" && target.scene.kind === "private" && target.scene.admin === true) return true;
      if (source.ordinary && target.ordinary) return true;
      return Boolean(source.scene && target.scene && source.scene.sceneId === target.scene.sceneId);
    } catch {
      return false;
    }
  };
}

/**
 * Mount the standalone recent-activity core over an already-open selected
 * Workspace database and subscribe its trusted `session/event` bridge.
 *
 * The wrapper gates every event through the same `authorizeModelWork` closure
 * used by injection/tools, so a moved Session or a binding switch stops
 * recording immediately; the core rechecks the Session again before commit.
 * Only `turn/end` reaches the core, and every callback failure is swallowed so
 * recent activity can never block Mneme's own event chain. The returned
 * disposer removes the listener on unload.
 * @param {object} options
 * @param {object} [options.ctx] trusted DSH context with `on`
 * @param {import("node:sqlite").DatabaseSync} [options.db] selected store DB
 * @param {string} [options.workspaceId] selected stable Workspace ID
 * @param {(session: object) => object} [options.authorizeModelWork] runtime gate
 * @param {() => boolean} [options.isEnabled] live opt-in switch; false denies reads/writes immediately
 * @param {(sessionId: string) => (object|null)} [options.resolveTrustedSession] trusted
 *   Host Session lookup; defaults to the live `ctx.sessions` store
 * @param {(sourceSessionId: string, targetSessionId: string) => boolean} [options.allowCrossSession]
 *   optional test override; production defaults to the live QQ Host pair gate
 * @param {(session: object) => boolean} [options.isTrustedOwner] Host owner predicate
 * @param {object} [options.config] core TTL/item/token options
 * @param {object} [options.logger]
 * @param {() => number} [options.now]
 * @returns {{core: object|null, onSessionEvent: ((session: object, event: object) => void)|null, dispose: () => void}}
 */
export function createRecentActivityRuntime({
  ctx = null,
  db = null,
  workspaceId = null,
  authorizeModelWork = null,
  isEnabled = null,
  resolveTrustedSession = null,
  allowCrossSession = null,
  isTrustedOwner = null,
  config = {},
  logger = null,
  now = Date.now
} = {}) {
  // The opt-in flag is a live boundary, not a boot-only gate. A persisted
  // explicit false must deny the next event/read even though the listener and
  // core were mounted while the flag was on. A throwing switch fails closed.
  const allowSession = (session) => {
    try {
      if (typeof isEnabled === "function" && isEnabled() !== true) {
        return { allowed: false, reason: "recent-activity-disabled" };
      }
    } catch {
      return { allowed: false, reason: "recent-activity-disabled" };
    }
    return typeof authorizeModelWork === "function" ? authorizeModelWork(session) : null;
  };
  // Cross-Session grants must be authorized from the live Host Session behind
  // the stored ID, never from a caller's ID-only placeholder. The resolver is
  // read fresh on every check; a missing service or Session fails closed for
  // ID-derived checks while the actual Session passed by the Host still works.
  const trustedSessionLookup = typeof resolveTrustedSession === "function"
    ? resolveTrustedSession
    : createTrustedSessionResolver(ctx);
  const pairGate = typeof allowCrossSession === "function"
    ? allowCrossSession
    : createRecentActivityPairGate(ctx);
  let core = null;
  try {
    core = createRecentActivityCore({
      db,
      workspaceId,
      allowSession,
      resolveTrustedSession: trustedSessionLookup,
      allowCrossSession: pairGate,
      isTrustedOwner: typeof isTrustedOwner === "function" ? isTrustedOwner : null,
      config,
      logger,
      now
    });
  } catch {
    core = null;
  }
  if (!core || core.status?.().ok !== true) {
    return { core: null, onSessionEvent: null, dispose() {} };
  }

  let disposed = false;
  const onSessionEvent = (session, event) => {
    if (disposed) return;
    try {
      if (event?.type !== "turn/end") return;
      if (typeof isEnabled === "function" && isEnabled() !== true) return;
      if (typeof authorizeModelWork !== "function") return;
      const decision = authorizeModelWork(session);
      if (decision?.allowed !== true) return;
      core.onSessionEvent(session, event);
    } catch {
      // Recent activity must never block the host's session/event chain.
    }
  };

  let unsubscribe = null;
  if (typeof ctx?.on === "function") {
    try {
      unsubscribe = ctx.on("session/event", onSessionEvent);
    } catch {
      unsubscribe = null;
    }
  }

  return {
    core,
    onSessionEvent,
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        if (typeof unsubscribe === "function") unsubscribe();
      } catch {
        // Listener teardown is best effort; nothing else is owned here.
      }
    }
  };
}

/**
 * Background Dream/Sleep may use the original unscoped Mneme paths only while
 * Scene isolation is off and the database has no tagged rows. Any tagged row
 * (or an explicit isolation switch) keeps the per-Scene compatibility path, so
 * a legacy tagged row can never be derived into an unscoped memory.
 * @param {{sceneIsolationEnabled?: boolean, hasSceneScopedRows?: boolean}} options
 * @returns {boolean}
 */
export function needsSceneScopedBackgroundJobs({ sceneIsolationEnabled = false, hasSceneScopedRows = false } = {}) {
  return sceneIsolationEnabled === true || hasSceneScopedRows === true;
}

/**
 * Return a live view of the resolved config with runtime path overrides. A Proxy
 * (rather than a spread) keeps volatile panel settings live while ensuring every
 * Engine/API consumer that reads `memoryDir` or `documentDir` sees the active
 * Workspace runtime root, never the control root or a global absolute path.
 * @param {object} base resolved config (plain object or live-config Proxy)
 * @param {object} overrides path keys to override
 * @returns {object}
 */
export function createScopedRuntimeConfig(base, overrides = {}) {
  const own = { ...(overrides && typeof overrides === "object" ? overrides : {}) };
  // The old in-process Recent Context and Life trusted intake are retired from
  // the Workspace-bound runtime. Force them off even when a stale feature flag
  // or a legacy bundle config still carries true; their tables and API modules
  // stay in place, read/write gated by these effective values.
  for (const key of RETIRED_FEATURE_FLAGS) own[key] = false;
  return new Proxy(base ?? {}, {
    get(target, prop) {
      if (prop === "then") return undefined;
      if (Object.hasOwn(own, prop)) return own[prop];
      return Reflect.get(target, prop);
    },
    has(target, prop) {
      return Object.hasOwn(own, prop) || prop in target;
    },
    ownKeys(target) {
      return [...new Set([...Reflect.ownKeys(target), ...Object.keys(own)])];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (Object.hasOwn(own, prop)) {
        return { enumerable: true, configurable: true, get: () => own[prop] };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    }
  });
}

/**
 * Resolve the boot-time Workspace runtime from the single binding file.
 *
 * Selected mode: initialize/verify only the digest-derived isolated directory
 * and use `<workspace>/memory.db`. Unbound mode (absent or corrupt binding, or a
 * marker mismatch): use `<controlRoot>/unbound/memory.db` so the owner GUI can
 * still load, while every model boundary is denied. The legacy root
 * `<controlRoot>/memory.db` is never opened, created, restored or migrated; its
 * mere presence is reported as a diagnostic.
 *
 * This helper only prepares directories and returns paths. It does not open a
 * database; index.js opens the returned `runtimeDir` afterwards.
 * @param {object} options
 * @param {string} options.memoryDir configured control root
 * @param {object} [options.ctx] trusted DSH context (optional registry probe)
 * @param {object} [options.logger]
 * @returns {object} controlRoot/runtimeDir/mode/activeWorkspaceId + diagnostics
 */
export function resolveWorkspaceRuntime({ memoryDir, ctx = null, logger = null } = {}) {
  const controlRoot = resolve(memoryDir);
  mkdirSync(controlRoot, { recursive: true });

  const binding = readWorkspaceBinding(controlRoot);
  let mode = "unbound";
  let activeWorkspaceId = null;
  let runtimeDir = join(controlRoot, UNBOUND_CONTROL_DIR);
  let diagnostic = binding.bound ? null : (binding.diagnostic ?? "unbound");

  if (binding.bound) {
    const initialized = initializeWorkspaceDataDir(controlRoot, { expectedWorkspaceId: binding.workspaceId });
    const currentBinding = readWorkspaceBinding(controlRoot);
    if (initialized.ok && initialized.workspaceId === binding.workspaceId &&
        currentBinding.bound && currentBinding.workspaceId === binding.workspaceId) {
      mode = "selected";
      activeWorkspaceId = binding.workspaceId;
      runtimeDir = initialized.path;
      diagnostic = null;
    } else {
      diagnostic = initialized.ok
        ? "binding-changed-during-initialization"
        : (initialized.reason ?? binding.diagnostic ?? "workspace-data-unavailable");
    }
  }

  // The unbound control database is the one runtime directory created here for
  // an unbound state. Selected mode's directory/marker was created above.
  if (mode !== "selected") mkdirSync(runtimeDir, { recursive: true });

  let legacyRootDatabase = false;
  try {
    legacyRootDatabase = existsSync(join(controlRoot, "memory.db"));
  } catch {
    legacyRootDatabase = false;
  }

  // A registry probe is diagnostic only. The selected isolated store still opens
  // so the owner GUI can load; model operations are denied per request by the
  // access guard when the registry is missing/invalid or no longer lists it.
  let registryKnown = null;
  if (mode === "selected" && ctx) {
    try {
      registryKnown = listWorkspaces(ctx).some((workspace) => workspace.id === activeWorkspaceId);
    } catch {
      registryKnown = false;
    }
  }

  if (mode === "selected") {
    logger?.info?.("[dsh-mneme] workspace runtime: selected Workspace store is active (isolated database)");
    if (registryKnown === false) {
      logger?.warn?.("[dsh-mneme] workspace runtime: selected Workspace is not present in the trusted registry; model memory access will be denied");
    }
  } else {
    logger?.warn?.(`[dsh-mneme] workspace runtime: no valid selected Workspace (${diagnostic}); model memory access is denied until a Workspace is selected and the plugin is remounted`);
  }
  if (legacyRootDatabase) {
    logger?.warn?.("[dsh-mneme] workspace runtime: legacy control-root memory.db detected and ignored (not opened, created, restored or migrated)");
  }

  return {
    controlRoot,
    runtimeDir,
    mode,
    activeWorkspaceId,
    diagnostic,
    binding,
    legacyRootDatabase,
    registryKnown
  };
}

export const apply = (ctx, config) => {
  // Cordis/DSH may hand apply() an already-validated Config whose volatile
  // fields are stable references. Re-parsing that object through Config() would
  // feed `{}` into the union validator, so only parse a raw/plain config.
  const alreadyParsed = Boolean(config && typeof config === "object" &&
    Object.values(config).some(isVolatileRef));
  const rawCfg = alreadyParsed ? config : Config(config);

  // Resolve memoryDir: expand leading "~". memoryDir is the control root for the
  // single Workspace binding file; it is never the database root of this runtime.
  const memoryDir = rawCfg.memoryDir.startsWith("~")
    ? join(homedir(), rawCfg.memoryDir.slice(1))
    : rawCfg.memoryDir;

  // Workspace runtime selection happens before any SQLite handle is opened. The
  // binding file decides between the selected digest-derived isolated directory
  // and the separate unbound control database under <memoryDir>/unbound/. The
  // legacy <memoryDir>/memory.db is never opened, created, restored or migrated.
  const workspaceRuntime = resolveWorkspaceRuntime({ memoryDir, ctx, logger: ctx.logger });
  const runtimeDir = workspaceRuntime.runtimeDir;
  const activeWorkspaceId = workspaceRuntime.activeWorkspaceId;

  // #218 末楼的实际事故：profile 被清理，落在其中的记忆库连带丢失。命中
  // profile 作用域时给一条可操作的告警（只提示、不搬库、不加配置键），启发
  // 式的边界与取舍见 src/placement.js 文件头。
  const profileScope = findProfileScopeSegment(memoryDir);
  if (profileScope) {
    ctx.logger?.warn?.(
      `[dsh-mneme] memoryDir is inside a profile scope ("${profileScope}"): ${memoryDir} — the library may be lost when the host cleans or migrates profiles. Prefer a location outside profiles/ (default: ~/.dsh/memory; config key: memoryDir).`
    );
  }

  // A staged restore is applied before the SQLite handle is opened, but only
  // inside the selected isolated runtime. An unbound control database is left
  // untouched: it must stay a separate, empty owner-GUI control store.
  if (workspaceRuntime.mode === "selected") {
    const stagedRestore = applyStagedRestore(runtimeDir, { logger: ctx.logger });
    if (stagedRestore?.applied) {
      ctx.logger?.info?.(`[dsh-mneme] applied staged restore ${stagedRestore.backup}`);
    } else if (stagedRestore?.error) {
      ctx.logger?.warn?.(`[dsh-mneme] staged restore skipped: ${stagedRestore.error}`);
    }
  }

  const store = createStore(join(runtimeDir, "memory.db"));
  // Scene reads consult the persisted directional group ACL. Owner-private
  // read-all is a Host capability handled inside Scene policy, not a DB grant.
  setSceneReadAclReader((reader, source) => store.hasSceneReadGrant(reader, source));

  // User-configurable settings (profile, rules, panel mode, standalone API
  // token) share the same SQLite file in dedicated tables, isolated from
  // memories. Created before the config is finalized: the persisted
  // panel_mode participates in light-mode resolution below.
  const settings = createSettings(store.db);

  // Light mode (v0.7.12): the bundle config flag OR a persisted panel_mode of
  // "light" (the panel switch wins over the bundle config so it survives
  // config redeploys). applyLightModePreset turns every heavy background /
  // semantic feature off and keeps the core loop (autoInject, autoSummarize,
  // hot memory, quality filter).
  const lightMode = rawCfg.lightMode === true || settings.getPanelMode() === "light";
  // 功能开关合并顺序即优先级：用户显式开关（feature_flags kv，面板写入）>
  // 轻量预设（applyLightModePreset 批量置关的重型能力）> bundle 配置。预设必须
  // 先应用、用户开关后展开，否则 LIGHT_MODE_OFF 会把用户显式打开的开关再次
  // 压掉。合并结果只作用于本次启动：面板改开关后与 panel_mode 一样在下次
  // 启动生效。
  // 嵌套对象开关按首个点号拆开（kv 里平铺存的 "memoryQualityFilter.enabled" →
  // cfg.memoryQualityFilter.enabled），点号键不原样留在 cfg 顶层属性里。
  const flags = settings.getFeatureFlags();
  const flatFlags = {};
  const nestedFlags = {};
  for (const [key, value] of Object.entries(flags)) {
    const dot = key.indexOf(".");
    if (dot > 0) {
      const objKey = key.slice(0, dot);
      const subKey = key.slice(dot + 1);
      nestedFlags[objKey] = { ...(nestedFlags[objKey] ?? {}), [subKey]: value };
    } else {
      flatFlags[key] = value;
    }
  }
  const cfg = lightMode
    ? (() => {
        const base = applyLightModePreset({ ...plainConfigValue(rawCfg), lightMode });
        const merged = { ...base, ...flatFlags };
        for (const [objKey, sub] of Object.entries(nestedFlags)) {
          merged[objKey] = { ...(merged[objKey] ?? {}), ...sub };
        }
        return merged;
      })()
    : createLiveConfig(rawCfg, flatFlags, nestedFlags);

  // Runtime file state must live inside the active Workspace directory. The
  // configured documentDir is honored only as a relative path under that root;
  // an absolute/~ path is a global location and is deliberately not adopted in
  // this milestone. The proxy keeps panel updates live while overriding path
  // keys for every engine/API consumer.
  let scopedDocumentDir = "";
  const configuredDocumentDir = cfg.documentDir;
  if (typeof configuredDocumentDir === "string" && configuredDocumentDir.trim()) {
    const rawDocumentDir = configuredDocumentDir.trim();
    const relativeDocumentDir = relative(runtimeDir, resolve(runtimeDir, rawDocumentDir));
    if (isAbsolute(rawDocumentDir) || relativeDocumentDir === ".." ||
      relativeDocumentDir.startsWith(`..${sep}`) || isAbsolute(relativeDocumentDir) ||
      rawDocumentDir === "~" ||
      rawDocumentDir.startsWith("~/") || rawDocumentDir.startsWith("~\\")) {
      ctx.logger?.warn?.("[dsh-mneme] documentDir escapes the active Workspace; using its managed documents directory instead");
    } else {
      scopedDocumentDir = rawDocumentDir;
    }
  }
  const runtimeOverrides = {
    memoryDir: runtimeDir,
    documentDir: scopedDocumentDir
  };
  // No selected Workspace means no autonomous memory work: skip the semantic
  // boot backfill as well as the Dream/Sleep/entity/continuity/nudge paths.
  if (workspaceRuntime.mode !== "selected") runtimeOverrides.autoReindexOnBoot = false;
  if (cfg.unifiedSessionAclEnabled === true) {
    runtimeOverrides.continuityRescueEnabled = false;
    runtimeOverrides.actionNudgeEnabled = false;
  }
  const runtimeCfg = createScopedRuntimeConfig(cfg, runtimeOverrides);

  // The runtime authorization closure is created once per mount, before any
  // session/event hook is wired. It re-reads the binding file on every model
  // boundary, so a binding change denies the old store immediately; index.js
  // always supplies it (direct module tests may omit it and keep the legacy
  // allow behavior).
  //
  // The QQ boundary wraps that Workspace guard: Workspace membership alone must
  // not admit a QQ group/private Session into unscoped long-term memory. The
  // Host is consulted at execution time and only strict Scene mode can admit a
  // verified QQ binding. This single closure gates injection, tools,
  // autoSummarize and every event-derived writer below.
  const workspaceAccessGuard = createWorkspaceAccessGuard({
    memoryDir: workspaceRuntime.controlRoot,
    activeWorkspaceId,
    ctx,
    logger: ctx.logger
  });
  const unifiedRuntime = activeWorkspaceId && runtimeCfg.unifiedSessionAclEnabled === true
    ? createUnifiedRuntime({ ctx, db: store.db, workspaceId: activeWorkspaceId,
        authorizeWorkspace: workspaceAccessGuard.authorize,
        enabled: () => runtimeCfg.unifiedSessionAclEnabled === true }) : null;
  const authorizeModelWork = unifiedRuntime?.authorize ?? createQQModelAccessGate({
    ctx,
    config: runtimeCfg,
    authorizeWorkspace: workspaceAccessGuard.authorize,
    logger: ctx.logger
  });

  // Teardown effects are collected from every later registration. Declared here
  // because the command/recorder block below also registers a disposer.
  const disposers = [];
  if (unifiedRuntime) disposers.push(unifiedRuntime.dispose);

  // Mneme-lite Recent Activity is opt-in and only mounts for a selected
  // Workspace. It shares the already-open isolated store DB and the existing
  // runtime access guard; no second database is opened and the long-term
  // memory/Dream/Sleep/retrieval paths are untouched. Registering the trusted
  // listener here lets unload dispose it with the rest of the runtime.
  let recentActivity = null;
  // Owner policy management needs the same core while the feature is disabled,
  // but it must not inherit the model-side immediate-disable wrapper. This
  // second core is never subscribed to session/event; it only reads/writes the
  // isolated recent-activity tables for the owner API.
  let recentActivityAdmin = null;
  let recentActivityBootEnabled = false;
  if (activeWorkspaceId && runtimeCfg.recentActivityEnabled === true) {
    recentActivityBootEnabled = true;
    const persisted = settings.getRecentActivityConfig();
    const coreConfig = {
      ttlHours: persisted.ttl_hours,
      maxItems: persisted.max_items,
      maxTokens: persisted.max_tokens
    };
    const isTrustedOwner = createRecentActivityOwnerCheck(ctx);
    const resolveTrustedSession = createTrustedSessionResolver(ctx);
    const allowCrossSession = unifiedRuntime?.allowRecentPair ?? createRecentActivityPairGate(ctx);
    const mount = createRecentActivityRuntime({
      ctx,
      db: store.db,
      workspaceId: activeWorkspaceId,
      authorizeModelWork,
      isEnabled: () => settings.getFeatureFlags().recentActivityEnabled !== false,
      resolveTrustedSession,
      allowCrossSession,
      isTrustedOwner,
      config: coreConfig,
      logger: ctx.logger
    });
    recentActivity = mount.core;
    if (recentActivity) {
      disposers.push(mount.dispose);
      try {
        const adminCore = createRecentActivityCore({
          db: store.db,
          workspaceId: activeWorkspaceId,
          allowSession: authorizeModelWork,
          resolveTrustedSession,
          allowCrossSession,
          isTrustedOwner,
          config: coreConfig,
          logger: ctx.logger
        });
        if (adminCore.status?.().ok === true) recentActivityAdmin = adminCore;
      } catch {
        recentActivityAdmin = null;
      }
    } else {
      ctx.logger?.warn?.("[dsh-mneme] recentActivityEnabled=true but the recent-activity core is unavailable");
    }
  }

  // Scene isolation is off by default and has no production Host adapter in
  // this fork: hostContract stays false, so actual QQ cross-scene sharing is
  // disabled. Synthetic trusted events can exercise the contract without QQ.
  configureScene({
    enabled: runtimeCfg.sceneIsolationEnabled === true,
    strictQQ: runtimeCfg.sceneStrictQQ === true,
    hostContract: false
  });
  const disposeSceneAclHandshake = provideSceneAclRead(ctx, runtimeCfg, Boolean(unifiedRuntime));
  configureRecentContext({
    enabled: runtimeCfg.recentContextEnabled === true,
    ttlMs: runtimeCfg.recentContextTtlMs,
    maxEvents: runtimeCfg.recentContextMaxEvents,
    maxTokens: runtimeCfg.recentContextMaxTokens
  });

  // 失败表的启动期清理也放在装配之后（此前它在 createStore 之后、装配之前，写死
  // 90 天）。保留期现在是显式配置键 reflectionFailureRetentionDays；等它进面板
  // 白名单的那天，这里读的就是装配后的值，不用再改第二处。best-effort 语义不变：
  // 清理失败不挡启动，否则一次锁表就能让插件起不来——但「不挡启动」不等于「可以
  // 悄悄失败」：这一族的 recall_runs 清理当年就是静默蒸发，表涨到两万余行无人
  // 察觉，所以本处与 llm_audit / distill_records / recall_runs 三处一样出声。
  try {
    const failureRetentionDays = Number.isInteger(runtimeCfg.reflectionFailureRetentionDays)
      ? runtimeCfg.reflectionFailureRetentionDays
      : 90;
    store.deleteOldFailures(new Date(Date.now() - failureRetentionDays * 86400000).toISOString());
  } catch (err) {
    ctx.logger?.warn?.(`[dsh-mneme] failure-table retention purge failed: ${String(err)}`);
  }

  // Bug8 的启动期清理放在装配之后：面板把 llmAudit.* 写进 kv、经 nestedFlags 合进
  // cfg，而写入侧（dream / summarize / 写入准入）读的都是装配后的 cfg——清理若读
  // rawCfg，面板改了保留期它不认，更糟的是「开不开审计」与写入侧可能取到不同的值
  // （raw 说关 → 不清理，cfg 说开 → 照写，审计表就无保留期地长）。保留期默认 90 天、
  // 失败只 warn，与失败表清理同款：账本清理绝不许挡住插件启动。
  try {
    if (runtimeCfg.llmAudit?.enabled !== false) {
      const retentionMs = Number.isInteger(runtimeCfg.llmAudit?.retentionDays) ? runtimeCfg.llmAudit.retentionDays : 90;
      store.deleteOldLlmAudits(new Date(Date.now() - retentionMs * 86400000).toISOString());
    }
  } catch (err) {
    ctx.logger?.warn?.(`[dsh-mneme] llm_audit retention purge failed: ${String(err)}`);
  }

  // #399 的启动期裁剪：与上面同款（读装配后的 cfg，理由同上——面板写的保留期必须
  // 与写入侧取到同一个值）。不同的一点：蒸馏原文留存默认关，而「默认关」在写入侧
  // 的含义就是零写入，所以这里也只在 enabled === true 时才动手——否则一张空表被
  // 每次启动扫一遍，白付一次全表 DELETE 的代价。只裁 distill_records；链接
  // （memory_provenance）保留，指向空区间即为「来源已过期」。
  try {
    if (runtimeCfg.distillRecords?.enabled === true) {
      const retentionMs = Number.isInteger(runtimeCfg.distillRecords?.retentionDays)
        ? runtimeCfg.distillRecords.retentionDays
        : 90;
      store.clearDistillRecords(new Date(Date.now() - retentionMs * 86400000).toISOString());
    }
  } catch (err) {
    ctx.logger?.warn?.(`[dsh-mneme] distill_records retention purge failed: ${String(err)}`);
  }

  // recall_runs 的滚动清理（v0.7.0 原设计，2026-10-14 找回）：与 llm_audit 同策略，
  // 按 cfg.recallRetentionDays（默认 90 天）启动时清一次。读装配后的 cfg，理由与上面
  // 两处一致 —— 写入侧取的是 cfg，清理侧若取 rawCfg，面板改的保留期就不生效。
  // 这一对曾在 dd0ed78（v0.7.12 发布提交）里被整块弄丢，配置键与文档却一直留着，
  // 实测 2026-10-13 那天从 16,041 涨到 20,510 行（一天四千余行，只增不减；
  // 单给一个静态行数会随表腐坏，故带日期的区间才是可核对的说法）。注入行开始写真实 query 之后，这条从「表膨胀」
  // 升级为「原话无限期留存」，所以必须与那次改动同批交付。
  // 保留期语义是「天」（函数内部乘 86400000），清理失败只 warn，绝不挡插件启动。
  try {
    const recallRetentionDays = Number.isInteger(runtimeCfg.recallRetentionDays) ? runtimeCfg.recallRetentionDays : 90;
    store.purgeRecallRunsOlderThan(recallRetentionDays);
  } catch (err) {
    // 这里必须真的出声。这一对当初是**静默**蒸发的：函数与调用一起没了、没人发现，
    // 表就这么涨到两万余行。清理再失败一次而仍然不出声，同样的回归照样看不见——
    // 「只 warn」不是修辞，是这族清理唯一的事后线索。
    ctx.logger?.warn?.(`[dsh-mneme] recall_runs retention purge failed: ${String(err)}`);
  }

  // 记忆语言（memory.language）：本实例逐层传入 inject / summarize / dream /
  // sleep / mirror，多实例（如 agent preset 内挂载）互不影响。
  const mirror = createMirror(runtimeDir, langOf(runtimeCfg));

  // #296 第二批：managed 文档目录。Resolved under the active Workspace runtime
  // root; an absolute/global documentDir was discarded above.
  const documentDir = resolveDocumentDir(runtimeDir, scopedDocumentDir);
  const documentIndex = createDocumentIndex(documentDir, langOf(runtimeCfg));
  if (runtimeCfg.documentMemoryEnabled === true) {
    const ensured = documentIndex.ensure();
    if (!ensured.ok) {
      ctx.logger?.warn?.(`[dsh-mneme] documentDir is not writable: ${documentDir}: ${ensured.error}`);
    }
    // 启动即渲染一次：索引不该等到第一次业务写才存在（删掉它之后重启也能自愈）。
    const synced = documentIndex.sync(store.list({ type: "document", limit: null }));
    if (!synced.ok) ctx.logger?.warn?.(`[dsh-mneme] document index sync failed: ${synced.error}`);
  } else {
    documentIndex.remove();
  }

  // 写入准入实例（#254）。两个开关 writeAdmission.enabled / .enforce 都默认关；
  // 关时它的返回与只计量那一阶段逐字段一致，写入路径完全不碰。既有的
  // llmAudit.enabled 关掉时它同样既不判也不写（那个开关连审计行的启动期清理一起
  // 关掉，在无保留期的表里按写入频次增长是不能接受的）。
  //
  // sensitiveScan 是密钥 / PII 那一类判据的注入点。按 #254 验收第 4 条它是 #164 A2
  // 的判据来源，现在由 src/sensitive-scan.js 实现（维护者 09-28 把 A2 的认领转给
  // 本侧）。这里只做接线：判据开不开由它自己的键 sensitiveScanEnabled 决定，工厂在
  // 关时返回 null，闸门的行为就与 #332 合并时逐字段一致（那一版根本没有这个函数）；
  // 命中之后是仅告警还是真拦，仍是 writeAdmission.enforce 的事（#164 口径：
  // 默认仅告警、拦截 opt-in），判据不碰决策。
  const writeAdmission = createWriteAdmission({
    store,
    config: runtimeCfg,
    logger: ctx.logger,
    sensitiveScan: createSensitiveScan({ config: runtimeCfg })
  });
  const service = createService({ store, mirror, config: runtimeCfg, logger: ctx.logger, documentIndex, writeAdmission });

  // F-NEW-03: if the mirror sync failed last run (persisted dirty state), retry
  // a safe re-render at boot so a stale mirror converges without needing a
  // business write. Bounded: single attempt; on failure dirty stays for the
  // next boot. Never throws.
  service.recoverMirror();

  // Recall-layer receipt: when searchMemories runs with recordRecall=true, the
  // retrieval scene (query/mode/topK/threshold + candidates) is persisted to
  // recall_runs for audit/replay — the sibling of the dream_runs judgment trail.
  // Best-effort: a failed recall write must never break the search.
  service.setRecallRecorder((recall) => {
    try {
      store.saveRecallRun({
        query: recall.query,
        mode: recall.mode,
        topK: recall.topK,
        threshold: recall.threshold ?? null,
        candidates: recall.candidates ?? [],
        created_at: recall.createdAt
      });
    } catch { /* non-fatal: recall recording is bookkeeping */ }
  });

  // Semantic pipeline: a local/ollama embedder when configured, otherwise the
  // legacy OpenAI-compatible embedder (settings-driven). The vector index wraps
  // the store's embedding column and tracks the active model fingerprint. A
  // slow embedder init (model download) never blocks plugin boot — failures
  // degrade to keyword search.
  const vectorIndex = createVectorIndex({ store, logger: ctx.logger });
  service.setVectorIndex(vectorIndex);

  // Human edits in mirror files win on every sync; merge them back first.
  // TYPE_FILE maps each memory type to its mirror filename. Read every type's
  // edits up front: mergeHumanEdits re-renders ALL mirror files on success, so
  // a per-type read-then-merge loop would overwrite edits in files not yet read
  // (e.g. preferences.md merging would clobber unsynced projects.md edits).
  const humanEdits = new Map();
  for (const type of Object.keys(TYPE_FILE)) {
    humanEdits.set(type, mirror.readHumanEdits(type));
  }
  const applyHumanEdits = () => {
    for (const [type, edits] of humanEdits) {
      if (edits.length) service.mergeHumanEdits(type, edits);
    }
  };

  // embedder/reranker/boot 回填装配已整体搬至 src/semantic.js(纯搬移,宿主与 daemon
  // 共用):调用时序(applyHumanEdits 在各分支的触发点、#118 重试、autoReindexOnBoot)
  // 原样保留在 createSemantic 内部,这里只拿引用。init 全失败的 embedder 引用仍会进入
  // dream/sleep 的 semantic 面 —— 与搬移前一致:检索侧 setEmbedder(null) 降级关键词。
  const semantic = createSemantic({
    store, service, settings, cfg: runtimeCfg, logger: ctx.logger, vectorIndex, applyHumanEdits, lightMode
  });
  const { embedder, reranker } = semantic;

  // Custom commands: register persisted commands into the DSH command registry
  // on boot; add/remove re-register live through the API.
  let commands = null;
  // M.O. 执行记账器：默认 null（旗标关），开了才装配。
  let recorder = null;
  if (ctx.commands) {
    commands = createCommandManager({ ctx, settings, logger: ctx.logger, language: langOf(runtimeCfg) });
    commands.sync();
  }

  // M.O. 执行记账（v0.9.0 第二批）：`/mo-run` 显式开一次执行窗口，窗口内的命令执行
  // 才可能被记成一条 run。挂的是 `session/event`——本仓已有的消费者之一
  // （continuity / summarize / nudge / api），不是新引入的宿主依赖。
  //
  // 为什么必须显式开窗：工作流的 trigger 是人话，拿它去猜「用户这句话是不是要开始走
  // 某条流程」只能猜错，而猜错会把一条从没跑过的流程记成跑过。所以窗口边界由人的
  // 显式动作划，**没开窗时一个字都不记**。
  //
  // 门控：默认关（actionRunEnabled），并且它挂热路径，轻量档也关。
  if (runtimeCfg.actionRunEnabled === true) {
    // The recorder's own session/event hook only buffers tool events for an
    // already-open window, but the window belongs to a Session. Gate the event
    // subscription too, so a moved/unbound Session stops buffering as soon as
    // the guard notices. The wrapper keeps pipeline-runner.js free of Workspace
    // policy (its only ctx dependency is `on`).
    const recorderCtx = {
      on(name, fn) {
        if (typeof ctx.on !== "function") return null;
        if (name !== "session/event") return ctx.on(name, fn);
        return ctx.on(name, (session, event) => {
          let allowed = false;
          try {
            allowed = authorizeModelWork(session)?.allowed === true;
          } catch {
            allowed = false;
          }
          if (!allowed) return;
          return fn(session, event);
        });
      }
    };
    recorder = createExecutionRecorder({ ctx: recorderCtx, logger: ctx.logger });
    const disposeMoRun = registerMoRunCommand({
      ctx,
      recorder,
      enabled: true,
      language: () => langOf(runtimeCfg),
      authorizeModelWork
    });
    if (disposeMoRun) {
      disposers.push(disposeMoRun);
    } else {
      // 注册不上（宿主没有命令注册表）时别留一个只开着窗口却没人能操作的记录器。
      recorder.dispose();
      recorder = null;
      ctx.logger?.warn?.("[dsh-mneme] actionRunEnabled=true 但宿主没有命令注册表，M.O. 记账未启用");
    }
  }

  // Dream scheduler: automatic consolidation + summary runs, triggered by
  // store growth. Writes through the service fire the dream hook, which asks
  // the scheduler to (re)schedule a run once absolute and since-last-run
  // thresholds are both exceeded. onRun is deferred through `dream` so the
  // closure sees the assigned scheduler; the null guard keeps a run safe even
  // if the hook fires before assignment or after dispose.
  // Background derivation cannot safely propagate per-scene visibility. Gate it
  // whenever scene isolation is enabled OR the store already contains tagged
  // rows, even if the user turned the flags off afterwards. Runtime guards below
  // also cover tagged rows arriving after startup.
  const sceneUnsafeDerivation = () => needsSceneScopedBackgroundJobs({
    sceneIsolationEnabled: runtimeCfg.sceneIsolationEnabled,
    hasSceneScopedRows: store.hasSceneScopedRows()
  });

  // Background jobs are partitioned by persisted scene_scope only. The scope
  // list is internal store metadata, never model/HTTP input; pagination keeps
  // the enumeration bounded. "legacy" is its own isolated null bucket.
  function listBackgroundSceneScopes() {
    const out = [];
    const pageSize = 200;
    for (let offset = 0; ; offset += pageSize) {
      const batch = store.listSceneScopes({ limit: pageSize, offset });
      out.push(...batch.map((row) => (row.null_scope ? LEGACY_SCENE_JOB : row.scope)));
      if (batch.length < pageSize) break;
    }
    return out;
  }

  function globalDreamBaseline() {
    return store.activeSize();
  }

  async function runScopedDreams() {
    const scopes = listBackgroundSceneScopes();
    if (!scopes.length) return { ok: true, skipped: true, reason: "no-scenes", baseline: globalDreamBaseline() };
    let ok = true;
    let last = { ok: true, skipped: true };
    const results = [];
    for (const scope of scopes) {
      const result = await runWithSceneJob(scope, () => dream.runDream(ctx, service, runtimeCfg));
      last = result ?? last;
      results.push(result ?? { ok: false });
      if (!result?.ok) ok = false;
    }
    const recorded = ok ? recordScopedDreamBaseline(store, service, runtimeCfg, results) : null;
    return { ...last, ok, baseline: recorded ?? globalDreamBaseline() };
  }

  async function runScopedSleep(signal) {
    const scopes = listBackgroundSceneScopes();
    if (!scopes.length) return { ok: true, skipped: true, reason: "no-scenes" };
    let ok = true;
    let last = { ok: true, skipped: true };
    let processed = 0;
    for (const scope of scopes) {
      if (signal?.aborted) break;
      const result = await runWithSceneJob(scope, () => runSleep(ctx, service, runtimeCfg, ctx.logger, { embedder, vectorIndex }, signal));
      processed += 1;
      last = result ?? last;
      if (!result?.ok) ok = false;
    }
    const outcome = scopedSleepOutcome({
      last, ok, processed, total: scopes.length, aborted: Boolean(signal?.aborted)
    });
    return outcome;
  }

  // Common lite path: a fresh Workspace with no tagged rows and Scene isolation
  // off calls the original Mneme Dream/Sleep directly. Scene buckets are only
  // enumerated when the compatibility path is actually required. The decision is
  // re-evaluated per run so a tagged row arriving later switches to the safe
  // per-Scene path instead of being processed unscoped.
  async function runBackgroundDream() {
    if (unifiedRuntime) return unifiedRuntime.runSources(() => dream.runDream(ctx, service, runtimeCfg));
    if (!sceneUnsafeDerivation()) return dream.runDream(ctx, service, runtimeCfg);
    return runScopedDreams();
  }

  async function runBackgroundSleep(signal) {
    if (unifiedRuntime) return unifiedRuntime.runSources(() => runSleep(ctx, service, runtimeCfg, ctx.logger, { embedder, vectorIndex }, signal));
    if (!sceneUnsafeDerivation()) {
      return runSleep(ctx, service, runtimeCfg, ctx.logger, { embedder, vectorIndex }, signal);
    }
    return runScopedSleep(signal);
  }
  let dream = null;
  if (!activeWorkspaceId && runtimeCfg.autoDream) {
    ctx.logger?.warn?.("[dsh-mneme] autoDream requested but no Workspace is selected; autonomous memory writes are disabled in unbound mode");
  }
  if (activeWorkspaceId && runtimeCfg.autoDream) {
    dream = createDreamScheduler({
      thresholdCount: runtimeCfg.dreamThresholdCount,
      thresholdChars: runtimeCfg.dreamThresholdChars,
      delayMs: runtimeCfg.dreamDelayMs,
      minIntervalMs: (runtimeCfg.dreamMinIntervalMinutes ?? 0) * 60000,
      // Issue #292：连续失败指数退避（opt-in，默认关 = 行为不变）。
      failureBackoff: runtimeCfg.autoDreamFailureBackoff === true,
      logger: ctx.logger,
      semantic: { embedder, vectorIndex },
      lastRunAtSeed: store.lastDreamRunAt("auto"),
      // Issue #89（基线半边）：阈值基线同样跨重启恢复——只恢复 lastRunAt 的话，
      // 重启后的第一条写入仍会绕过阈值（库里记忆多于阈值时 overBase 恒成立）开跑
      // 整轮。种子取上次成功轮的库规模，口径与运行期刷新一致；读不到时调度器退回
      // 零基线（= 升级前行为）。
      baselineSeed: store.lastDreamBaseline("auto"),
      // Issue #239（第 4 项）镜像到巩固：高峰期不做梦，顺延到最近的高峰结束时刻。
      peakHours: runtimeCfg.dreamPeakHours ?? "",
      peakMaxDeferMinutes: runtimeCfg.dreamPeakMaxDeferMinutes ?? 120,
      // 跳过时的审计行在这里落地（调度器只拿到 service，拿不到 config 的
      // llmAudit 开关与巩固模型路由）。口径与 runAuditedLlm 一致：审计关掉就
      // 不写；写失败只 warn，绝不反噬调度（CONTRIBUTING 的 fail-safe 硬约定）。
      auditPeakSkip: ({ count, chars }) => {
        if (runtimeCfg?.llmAudit?.enabled === false || typeof service?.saveLlmAudit !== "function") return;
        const modelId = runtimeCfg.dreamProvider && runtimeCfg.dreamModel ? `${runtimeCfg.dreamProvider}:${runtimeCfg.dreamModel}` : "";
        service.saveLlmAudit({
          timestamp: new Date().toISOString(),
          trigger_source: "autoDream",
          operation_type: "dream_consolidate",
          model_id: modelId,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          cost_usd: 0,
          duration_ms: 0,
          status: "skipped",
          error_message: "peak-hours",
          related_memory_ids: [],
          // 观测用：跳过时窗口里积了多少（阈值继续累积，不是丢弃）。
          metadata: JSON.stringify({ count, chars })
        });
      },
      onRun: () => (dream ? runBackgroundDream() : Promise.resolve({ ok: true, skipped: true, reason: "dream-disposed" }))
    });
    service.setDreamHook(() => dream.maybeSchedule(service));
  }

  // Sleep scheduler (v0.4.0): idle-triggered deep maintenance. Fires when the
  // store has been quiet for sleepIdleMinutes and re-arms on every write via
  // noteWrite (hooked to the service's write path). Runs go through
  // service.enqueue so they serialize with autoDream — the two never overlap.
  // Abortable on user activity; audited into dream_runs with run_type='sleep'.
  let sleep = null;
  if (!activeWorkspaceId && runtimeCfg.sleepModeEnabled) {
    ctx.logger?.warn?.("[dsh-mneme] sleepMode requested but no Workspace is selected; autonomous memory writes are disabled in unbound mode");
  }
  if (activeWorkspaceId && runtimeCfg.sleepModeEnabled) {
    sleep = createSleepScheduler({
      service,
      config: runtimeCfg,
      logger: ctx.logger,
      lastRunAtSeed: store.lastDreamRunAt("sleep"),
      onRun: (signal) => (sleep ? runBackgroundSleep(signal) : Promise.resolve({ ok: true, skipped: true, reason: "sleep-disposed" }))
    });
    service.setSleepHook(() => sleep.noteWrite());
  }

  // Entity gene extraction (v0.3.0): wire the extractor into the service as a
  // hook so saveWithDedupe can fire-and-forget an extraction pass on fresh
  // writes. The service never sees ctx.llm — index.js adapts it here into the
  // callLLM(messages, options) => Promise<string> contract the extractor
  // expects, reusing the same ctx.llm.stream consumption pattern as dream.js.
  // Explicit opt-in only (entityExtractionEnabled defaults to false); any LLM
  // failure degrades inside the extractor to { ok:false }, never a write error.
  if (!activeWorkspaceId && runtimeCfg.entityExtractionEnabled) {
    ctx.logger?.warn?.("[dsh-mneme] entityExtraction requested but no Workspace is selected; autonomous extraction is disabled in unbound mode");
  }
  if (activeWorkspaceId && runtimeCfg.entityExtractionEnabled) {
    if (!ctx.llm) {
      // Issue #108: an enabled-but-unwired extractor failed silently before —
      // zero entities, zero llm_audit_logs, no log line anywhere. Make the
      // missing dependency visible so a user can tell "extractor not installed"
      // from "extraction failed".
      ctx.logger?.warn?.("[dsh-mneme] entityExtractionEnabled=true but ctx.llm unavailable — entity extractor NOT installed");
    } else {
      const streamEntityText = createEntityStreamAdapter({
        llm: ctx.llm,
        agentDefaultModel: ctx.agentDefaultModel,
        logger: ctx.logger,
        // Issue #250: the adapter needs service to write its llm_audit_logs row
        // (it never had it) and config for the shared llmAudit.enabled gate.
        service,
        config: runtimeCfg
      });
      service.setEntityExtractor((memory) =>
        extractEntities(memory, { store, config: runtimeCfg, callLLM: streamEntityText, logger: ctx.logger, identity: service.identity })
          .catch((err) => {
            ctx.logger?.warn?.(`[dsh-mneme] entity extraction failed: ${String(err)}`);
            return { ok: false, error: String(err) };
          })
      );
    }
  }

  // Issue #380：注入前判定闸门。判定 LLM 走 entity adapter 同款装配（ctx.llm +
  // agentDefaultModel 回退），gate 自持 enabled/usable 判定（未启用/llm 缺席/
  // llmAudit 关闭时内部恒 off，注入行为与现状逐字节一致）。
  const preInjectGate = createPreInjectGate({
    llm: ctx.llm,
    agentDefaultModel: ctx.agentDefaultModel,
    service,
    config: runtimeCfg,
    logger: ctx.logger
  });
  disposers.push(() => preInjectGate.clear());

  // #118: never let a pending embedder init retry fire after unload and touch
  // a torn-down context.
  disposers.push(() => semantic.dispose());   // #118 重试计时器 + boot 回填计时器(搬入 semantic.js 后由它自持)

  ctx.inject(["systemPrompt"], (promptCtx) => {
    if (runtimeCfg.autoInject) {
      disposers.push(createInjector(
        promptCtx,
        service,
        settings,
        runtimeCfg,
        preInjectGate,
        authorizeModelWork,
        recentActivity,
        () => settings.getRecentActivityConfig()
      ));
    }
  });

  // #249 N3：压缩边缘双落点。触发靠宿主自己落的压缩事件（订阅 + pre-step 追加），
  // 不需要 systemPrompt / tools 的任何能力，所以不塞进上面的 inject 回调；父／子
  // 闸门在挂载点判一次，与 inject.js 共用同一个 injectChildEnabled 判据。
  // Unbound mode has no selected Workspace, so this autonomous store writer is
  // not mounted at all.
  if (activeWorkspaceId && runtimeCfg.autoInject && injectChildEnabled(runtimeCfg, "continuityRescueEnabled")) {
    disposers.push(createContinuityRescue(ctx, store, authorizeModelWork));
  }

  ctx.inject(["tools"], (toolsCtx) => {
    disposers.push(createTools(toolsCtx, service, runtimeCfg, embedder, authorizeModelWork, recentActivity));
  });

  const strictQQScene = runtimeCfg.sceneIsolationEnabled === true && runtimeCfg.sceneStrictQQ === true;
  const summarizer = (!unifiedRuntime && !strictQQScene && sceneUnsafeDerivation())
    ? { dispose() {} }
    : createSummarizer(ctx, service, runtimeCfg, { authorizeModelWork });
  disposers.push(summarizer.dispose);

  // #275 存储生命周期第一批：无损回收的手动入口。刻意不挂启动路径、不接定时器——
  // 这一步是不可逆的内容丢弃，只由人显式触发（面板的维护卡、`dsh-mneme reclaim`）。
  // 实例建在插件进程内，是为了让 CLI 也能走这条路：VACUUM 要排他锁，跟宿主抢锁的
  // 那条路走不通。
  // 位置在 webServer 块之前：面板的 in-process API（createApi）与 standalone 数据面
  // 都要用它，而 webServer 是可选的——headless 宿主不注册面板路由，构造点若留在块后
  // 就永远晚于 createApi（#386 第 4 条）。构造期无副作用（只返回 { reclaim }），前移安全。
  const maintenance = createMaintenance({ store, config: runtimeCfg, logger: ctx.logger });

  // webServer 可选依赖：cordis 4 的 ctx 是 Proxy，直接访问未在 inject 声明的
  // 属性会抛 "cannot get property without inject"（不会返回 undefined），所以
  // 不能用 if (ctx.webServer) 守卫。ctx.reflect.get 是 cordis 提供的免 inject
  // 读取（未提供时返回 undefined）；对象字面量 mock ctx（测试）没有 reflect，
  // 退回直接属性访问。headless/无 UI 宿主无 webServer 时跳过 API 注册，其余
  // 功能（工具/注入/dream）照常。
  const webServer = typeof ctx.reflect?.get === "function" ? ctx.reflect.get("webServer") : ctx.webServer;
  if (webServer) {
    // 画像提取草稿（#497）：装配与开关无关——闸在路由那一侧（关着回 409 disabled，
    // 本模块一次都不会被调用）。这样「没启用」与「没装配」在 HTTP 面上是两个可区分的
    // 答案（503 unavailable 只该出现在旧宿主/装配缺失上，不该被读成「用户没开」）。
    const extractProfileDraft = createProfileExtractor({ ctx, service, config: runtimeCfg, logger: ctx.logger });
    const api = createApi(ctx, service, settings, commands ?? {
      add: () => { throw new Error("commands unavailable"); },
      remove: () => false,
      list: () => []
    }, embedder, { vectorIndex, reranker }, runtimeCfg.apiToken, runtimeCfg, maintenance, extractProfileDraft);
    disposers.push(api.dispose);
    // Native settings page data plane: owner-authenticated and deliberately
    // smaller than the token API. No API key, memory body or SQLite path is
    // returned. Kept separate from the token-gated panel routes so an ordinary
    // user does not need to copy a token into the browser. Backups and staged
    // restores are scoped to the active Workspace runtime.
    mountAdminApi(ctx, {
      service, settings, store, config: runtimeCfg, embedder, vectorIndex, reranker,
      memoryDir: runtimeDir,
      // Workspace selection is stored at the control root, never under the
      // active Workspace runtime (the backup/restore endpoints keep memoryDir).
      controlRoot: workspaceRuntime.controlRoot,
      activeWorkspaceId,
      initialSelectedWorkspaceId: workspaceRuntime.binding?.workspaceId ?? null,
      recentActivity,
      recentActivityAdmin,
      recentActivityBootEnabled,
      unifiedRuntime
    });
  }

  // M.O. 自动沉淀（v0.9.3）：项目里重复走的那套动作，自动变成 memoryDir 里的一条
  // 「提议」，等人确认后才可能进仓库。默认关（actionNudgeEnabled）。
  //
  // 为什么位置在这里而不是和 M.O. 记账同段：`disposers` 声明在 :532，而记账块在它
  // 之前（TDZ）——照抄过去会在插件加载时直接抛 ReferenceError。这里已在其后。
  //
  // 为什么挂 session/event 却又要进轻量档黑名单：它读的是 zstd 会话日志（同步解压），
  // 是本插件里最重的一条后台路径；且它只产「提议」，关掉不影响记忆本身的正确性。
  if (!activeWorkspaceId && runtimeCfg.actionNudgeEnabled === true) {
    ctx.logger?.warn?.("[dsh-mneme] actionNudge requested but no Workspace is selected; autonomous proposal writes are disabled in unbound mode");
  }
  if (activeWorkspaceId && runtimeCfg.actionNudgeEnabled === true) {
    // Proposals are runtime state: they live under the active Workspace root, not
    // under the control root.
    disposers.push(createNudgeAutoRun({ ctx, memoryDir: runtimeDir, logger: ctx.logger, authorizeModelWork }));
  }

  // Standalone external API (v0.7.12): plain node:http server for ecosystem
  // integrations outside the DSH host. In this milestone it cannot assert a DSH
  // Session, so its model memory data plane cannot be authorized. The owner
  // panel/API stays available; the standalone listener is disabled entirely and
  // the reason is logged, rather than exposing an unauthenticated-by-Session
  // memory plane. Enabling it again requires a Host-backed authorization design.
  if ((settings.getExternalApi?.()?.enabled ?? runtimeCfg.externalApiEnabled) === true) {
    ctx.logger?.warn?.("[dsh-mneme] standalone external API is disabled in the Workspace-bound runtime: it cannot assert a trusted DSH Session, so its model memory data plane is unavailable; use the owner panel/API");
  }

  // Async disposer: cordis awaits the returned promise on unload (runDisposable),
  // so an in-flight dream run is allowed to finish before the SQLite store is
  // closed — dream.dispose() resolves only after its current run settles.
  return async () => {
    for (const dispose of disposers) {
      if (typeof dispose === "function") dispose();
    }
    commands?.dispose();
    recorder?.dispose();
    if (dream) await dream.dispose();
    if (sleep) sleep.dispose();
    await disposeSceneAclHandshake();
    store.close();
  };
};
