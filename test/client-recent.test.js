import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientSource = readFileSync(join(root, "lib/client.js"), "utf8");

function fakeReact() {
  return {
    Fragment: Symbol("Fragment"),
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useState(value) { return [value, () => {}]; },
    useRef(value) { return { current: value }; },
    useEffect() {},
    useCallback(fn) { return fn; },
    useMemo(fn) { return fn(); }
  };
}

function loadClient(react = fakeReact(), fetchImpl = null) {
  let loaded;
  const calls = [];
  const sandbox = {
    __DSH_MNEME_TEST__: true,
    window: {
      __ModuleLoader__: { load(spec) { loaded = spec; } },
      addEventListener() {},
      removeEventListener() {}
    },
    document: {
      hidden: false,
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null; },
      createElement() { return { dataset: {}, style: {}, textContent: "" }; },
      head: { appendChild() {} }
    },
    navigator: { language: "zh-CN" },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    fetch: async (url, opts = {}) => {
      const call = { url: String(url), method: opts.method || "GET", body: opts.body };
      calls.push(call);
      if (fetchImpl) return fetchImpl(call);
      return { ok: false, status: 503, json: async () => ({}) };
    }
  };
  vm.runInNewContext(clientSource, sandbox, { filename: join(root, "lib/client.js") });
  assert.ok(loaded, "client bundle must register through __ModuleLoader__");
  return { module: loaded.factory(() => react), calls, sandbox };
}

function renderRecent(overrides = {}, fetchImpl = null) {
  const values = [
    overrides.state ?? null,
    overrides.loading ?? false,
    overrides.loadError ?? "",
    overrides.notice ?? "",
    overrides.configDraft ?? null,
    overrides.configBusy ?? false,
    overrides.configError ?? "",
    overrides.query ?? "",
    overrides.selectedId ?? "",
    overrides.policyDraft ?? null,
    overrides.policyBusy ?? false,
    overrides.policyError ?? "",
    overrides.policyNotice ?? "",
    overrides.previewTarget ?? "",
    overrides.preview ?? null,
    overrides.previewBusy ?? false,
    overrides.previewError ?? "",
    overrides.pendingRestart ?? false
  ];
  let slot = 0;
  const setters = [];
  const react = {
    Fragment: Symbol("Fragment"),
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useState(initial) {
      const index = slot++;
      return [index < values.length ? values[index] : initial, (next) => { setters[index] = next; }];
    },
    useRef(value) { return { current: value }; },
    useEffect() {},
    useCallback(fn) { return fn; },
    useMemo(fn) { return fn(); }
  };
  const { module, calls } = loadClient(react, fetchImpl);
  const tree = module.__test.AmadeusRecentActivityCard({ t: (key) => key });
  return { tree, setters, calls, module };
}

function flatten(node, out = []) {
  if (node == null || node === false || node === true) return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (typeof node === "object") {
    out.push(node);
    for (const child of node.children || []) flatten(child, out);
  }
  return out;
}

function nodes(tree) {
  return flatten(tree).filter((node) => node && typeof node === "object");
}

function texts(tree) {
  return flatten(tree).filter((node) => typeof node === "string");
}

function hasText(tree, text) {
  return texts(tree).some((value) => value.includes(text));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function button(tree, key) {
  return nodes(tree).find((node) => node.type === "button" && hasText(node, key)) || null;
}

function response(data) {
  return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
}

const sessions = [
  {
    id: "session-alpha", title: "Alpha planning", last_active_at: 1700000000000,
    enabled: true, mode: "self", shared_session_ids: []
  },
  {
    id: "session-beta", title: null, last_active_at: "2023-11-15T01:00:00.000Z",
    enabled: false, mode: "shared", shared_session_ids: ["session-alpha"]
  },
  {
    id: "session-gamma", title: "Gamma review", last_active_at: null,
    enabled: true, mode: "owner", shared_session_ids: []
  }
];

const state = {
  active_workspace_id: "ws-active",
  selected_workspace_id: "ws-selected",
  enabled: false,
  configured_enabled: true,
  pending_restart: true,
  config: { ttl_hours: 6, auto_inject: true, max_items: 4, max_tokens: 250 },
  stats: {
    event_count: 7,
    source_counts: [
      { source_session_id: "session-alpha", count: 5 },
      { source_session_id: "session-beta", count: 2 }
    ],
    last_updated: 1700000000000,
    summary_bytes: 2048,
    policy_count: 2
  },
  sessions
};

const preview = {
  ok: true,
  reason: "ok",
  items: [{
    sourceSessionId: "session-beta",
    kind: "conversation",
    summary: "Beta completed a deterministic turn summary.",
    occurredAt: 1700000000000,
    estimatedTokens: 42
  }],
  count: 1,
  estimatedTokens: 42,
  truncated: true
};

test("recent activity page is bilingual, nested under Memory > Recent, and preserves the original GUI", () => {
  for (const key of [
    "memory.am.recentActivity.title",
    "memory.am.recentActivity.hint",
    "memory.am.recentActivity.summaryTitle",
    "memory.am.recentActivity.workspaceSelected",
    "memory.am.recentActivity.workspaceActive",
    "memory.am.recentActivity.pendingBadge",
    "memory.am.recentActivity.pending",
    "memory.am.recentActivity.participating",
    "memory.am.recentActivity.summaries",
    "memory.am.recentActivity.lastUpdated",
    "memory.am.recentActivity.storage",
    "memory.am.recentActivity.previewTokens",
    "memory.am.recentActivity.sessionsTitle",
    "memory.am.recentActivity.searchLabel",
    "memory.am.recentActivity.modeSelf",
    "memory.am.recentActivity.modeOwner",
    "memory.am.recentActivity.modeShared",
    "memory.am.recentActivity.ownerDegraded",
    "memory.am.recentActivity.sharedLabel",
    "memory.am.recentActivity.savePolicy",
    "memory.am.recentActivity.previewTitle",
    "memory.am.recentActivity.previewTarget",
    "memory.am.recentActivity.previewDenied",
    "memory.am.recentActivity.configTitle",
    "memory.am.recentActivity.featureEnabled",
    "memory.am.recentActivity.ttl1",
    "memory.am.recentActivity.ttl6",
    "memory.am.recentActivity.ttl24",
    "memory.am.recentActivity.ttl72",
    "memory.am.recentActivity.autoInject",
    "memory.am.recentActivity.maxItems",
    "memory.am.recentActivity.maxTokens",
    "memory.am.recentActivity.strategyTitle",
    "memory.am.recentActivity.strategy",
    "memory.am.recentActivity.validationTtl",
    "memory.am.recentActivity.saveConfig",
    "memory.am.recentActivity.loadFailed",
    "memory.am.recentActivity.saveFailed"
  ]) {
    assert.ok((clientSource.split(`"${key}"`).length - 1) >= 2,
      `bilingual key ${key} must exist in zh and en`);
  }
  assert.ok(clientSource.includes('"memory.am.recentActivity.title": "跨会话近期动态"'),
    "the page title must be Chinese-first");
  assert.ok(clientSource.includes('"memory.am.memoryView.recent": "跨会话近期动态"'),
    "the Recent subtab must use the activity wording in Chinese");
  assert.ok(clientSource.includes('"memory.am.memoryView.recent": "Cross-Session recent activity"'),
    "the Recent subtab must use the activity wording in English");
  assert.equal(clientSource.includes('"memory.am.memoryView.recent": "近期上下文"'), false,
    "the obsolete Recent subtab label must be gone");
  assert.ok(clientSource.includes('"memory.am.memory.tagsHint": "普通标签可手工编辑；受保护的事件标签无法通过普通管理伪造。"'),
    "the Chinese tag hint must describe ordinary editing and protected event tags");
  assert.ok(clientSource.includes('"memory.am.memory.tagsHint": "Ordinary tags can be edited; protected event tags cannot be forged through ordinary management."'),
    "the English tag hint must describe ordinary editing and protected event tags");
  assert.ok(clientSource.includes("recentActivityHasState(recentStatus)")
    && clientSource.includes("h(AmadeusRecentActivityCard, { t })"),
    "the new card must replace the obsolete trusted card when the new state shape is present");
  assert.ok(clientSource.includes('memoryView === "recent" && recentPanel()'),
    "the page must stay nested under Memory > Recent");

  assert.ok(clientSource.includes('t("memory.am.recent.hotTitle")')
    && clientSource.includes('t("memory.am.recent.hotHint")')
    && clientSource.includes('t("memory.am.recent.hotState")')
    && clientSource.includes('flagOn("hotMemoryEnabled")'),
    "the original Hot Memory card must be preserved");
  assert.equal((clientSource.match(/onClick: clearRecent/g) || []).length, 1,
    "only the legacy-shape fallback may keep the old clear action");
  for (const token of [
    "memoryManagementCard()",
    "graphCard()",
    "sceneCard()",
    "backupCard()",
    "AM_CONFIG_FIELDS.map(configField)",
    "h(AmadeusWorkspaceCard, { t })"
  ]) {
    assert.ok(clientSource.includes(token), `original GUI surface ${token} must remain reachable`);
  }
});

test("recent activity uses only adminJson owner routes and never fetches raw transcripts", () => {
  const start = clientSource.indexOf("function AmadeusRecentActivityCard(");
  const end = clientSource.indexOf("exports.apply = apply;", start);
  assert.ok(start > 0 && end > start, "recent activity component must exist");
  const cardSource = clientSource.slice(start, end);

  assert.ok(clientSource.includes('adminJson("/recent")'),
    "GET state must use the owner admin helper");
  assert.ok(clientSource.includes('adminJson("/recent/config", {')
    && clientSource.includes("body: JSON.stringify(configCheck.values)"),
    "config POST must use adminJson and the validated body");
  assert.ok(cardSource.includes('adminJson("/recent/policy", {')
    && cardSource.includes("source_session_id: selected.id")
    && cardSource.includes("enabled: policyCheck.values.enabled")
    && cardSource.includes("mode: policyCheck.values.mode")
    && cardSource.includes("shared_session_ids: policyCheck.values.shared_session_ids"),
    "policy POST must submit the exact stable Session ID and shared ID array");
  assert.ok(cardSource.includes("adminJson(`/recent/preview?target_session_id=${encodeURIComponent(targetId)}&include_self=false`)"),
    "preview must be requested as the target Session with include_self=false");
  assert.equal(cardSource.includes("fetch("), false,
    "the component must not bypass adminJson with a direct fetch");
  assert.equal(cardSource.includes("dangerouslySetInnerHTML"), false,
    "summaries must render as text, never as HTML");
  assert.equal(cardSource.includes("transcript"), false,
    "the UI must not request or render raw transcripts");
  assert.equal(/item\.(content|text|messages|role)\b/.test(cardSource), false,
    "only the safe preview summary DTO may be rendered");
});

test("recent activity model normalizes nullable metadata, defaults, filters and pending state", () => {
  const { module } = loadClient();
  const { __test } = module;

  const normalized = __test.recentActivitySessions({
    sessions: [
      { id: "session-a", title: null, enabled: true, mode: "self", shared_session_ids: ["session-b", "session-b", "session-a"] },
      { id: "session-a", title: "duplicate", enabled: false, mode: "owner" },
      { id: "session-b", title: "Beta", enabled: false, mode: "shared", shared_session_ids: [] },
      { id: "", title: "missing id" },
      { id: "session-c", title: "Gamma", enabled: true, mode: "invalid" }
    ]
  });
  assert.deepEqual(plain(normalized.map((session) => session.id)), ["session-a", "session-b", "session-c"]);
  assert.equal(normalized[0].title, "");
  assert.equal(normalized[0].shared_session_ids.join(","), "session-b",
    "the source Session must not be its own shared target and duplicates must collapse");
  assert.equal(normalized[2].mode, "self", "an unknown mode must fail safe to self");
  assert.equal(__test.recentActivitySessionLabel(normalized[0]), "session-a",
    "a missing title must fall back to the stable ID");
  assert.equal(__test.recentActivitySessionLabel(normalized[1]), "Beta");

  const emptySummary = __test.recentActivitySummary(null);
  assert.equal(emptySummary.selected_workspace_id, null);
  assert.equal(emptySummary.active_workspace_id, null);
  assert.equal(emptySummary.enabled, false);
  assert.equal(emptySummary.pending_restart, false);
  assert.deepEqual(plain(emptySummary.config), { ttl_hours: 24, auto_inject: false, max_items: 3, max_tokens: 300 });
  assert.equal(emptySummary.session_count, 0);

  const summary = __test.recentActivitySummary(state);
  assert.equal(summary.participating_count, 2);
  assert.equal(summary.session_count, 3);
  assert.equal(summary.stats.event_count, 7);
  assert.equal(summary.stats.source_counts.length, 2);
  assert.equal(summary.stats.summary_bytes, 2048);
  assert.equal(summary.pending_restart, true);

  assert.equal(__test.recentActivityPendingRestart({ pending_restart: true }), true);
  assert.equal(__test.recentActivityPendingRestart({ enabled: true, configured_enabled: false }), true);
  assert.equal(__test.recentActivityPendingRestart({ enabled: true, configured_enabled: true }), false);
  assert.equal(__test.recentActivityOwnerAvailable({}), false);
  assert.equal(__test.recentActivityOwnerAvailable({ owner_binding_available: true }), true);

  assert.deepEqual(plain(__test.recentActivityFilterSessions(normalized, "beta").map((session) => session.id)), ["session-b"]);
  assert.deepEqual(plain(__test.recentActivityFilterSessions(normalized, "SESSION-C").map((session) => session.id)), ["session-c"]);
  assert.deepEqual(plain(__test.recentActivityFilterSessions(normalized, "Gamma").map((session) => session.id)), ["session-c"]);
  assert.equal(__test.recentActivityFilterSessions(normalized, "  ").length, 3);

  assert.equal(__test.recentActivityTimestamp(1700000000000), "2023-11-14 22:13 UTC");
  assert.equal(__test.recentActivityTimestamp(null), "");
  assert.equal(__test.recentActivityBytes(512), "512 B");
  assert.equal(__test.recentActivityBytes(2048), "2.0 KiB");
});

test("config and policy validation rejects out-of-range values before any POST", () => {
  const { module } = loadClient();
  const { __test } = module;

  const validConfig = __test.recentActivityValidateConfig({
    enabled: true, ttl_hours: "24", auto_inject: false, max_items: "5", max_tokens: "200"
  });
  assert.equal(validConfig.ok, true);
  assert.deepEqual(plain(validConfig.values), {
    enabled: true, ttl_hours: 24, auto_inject: false, max_items: 5, max_tokens: 200
  });

  for (const [draft, field] of [
    [{ enabled: true, ttl_hours: 12, auto_inject: false, max_items: 5, max_tokens: 200 }, "ttl_hours"],
    [{ enabled: true, ttl_hours: 24, auto_inject: "yes", max_items: 5, max_tokens: 200 }, "auto_inject"],
    [{ enabled: true, ttl_hours: 24, auto_inject: false, max_items: 0, max_tokens: 200 }, "max_items"],
    [{ enabled: true, ttl_hours: 24, auto_inject: false, max_items: 11, max_tokens: 200 }, "max_items"],
    [{ enabled: true, ttl_hours: 24, auto_inject: false, max_items: 5, max_tokens: 99 }, "max_tokens"],
    [{ enabled: true, ttl_hours: 24, auto_inject: false, max_items: 5, max_tokens: 801 }, "max_tokens"],
    [{ enabled: "yes", ttl_hours: 24, auto_inject: false, max_items: 5, max_tokens: 200 }, "enabled"]
  ]) {
    const checked = __test.recentActivityValidateConfig(draft);
    assert.equal(checked.ok, false, `invalid ${field} must be rejected locally`);
    assert.ok(checked.errors[field], `the ${field} error must be reported`);
  }

  const deduped = __test.recentActivityValidatePolicy({
    enabled: true,
    mode: "shared",
    shared_session_ids: ["session-b", "session-b", "session-c", "session-a"]
  }, "session-a");
  assert.equal(deduped.ok, true);
  assert.deepEqual(plain(deduped.values.shared_session_ids), ["session-b", "session-c"],
    "duplicates and the source Session must not be submitted as shared targets");

  const badMode = __test.recentActivityValidatePolicy({ enabled: true, mode: "public", shared_session_ids: [] }, "session-a");
  assert.equal(badMode.ok, false);
  assert.ok(badMode.errors.mode);

  const badShared = __test.recentActivityValidatePolicy({
    enabled: true, mode: "shared", shared_session_ids: [42]
  }, "session-a");
  assert.equal(badShared.ok, false);
  assert.ok(badShared.errors.shared_session_ids);

  const owner = __test.recentActivityValidatePolicy({
    enabled: true, mode: "owner", shared_session_ids: ["session-b"]
  }, "session-a");
  assert.deepEqual(plain(owner.values.shared_session_ids), [], "non-shared modes must clear the allowlist");
});

test("preview DTO is normalized and denied/error text stays safe", () => {
  const { module } = loadClient();
  const { __test } = module;

  const good = __test.recentActivityPreview(preview);
  assert.equal(good.ok, true);
  assert.equal(good.count, 1);
  assert.equal(good.estimatedTokens, 42);
  assert.equal(good.truncated, true);
  assert.equal(good.items[0].sourceSessionId, "session-beta");
  assert.equal(good.items[0].kind, "conversation");
  assert.match(good.items[0].summary, /deterministic turn summary/);

  const denied = __test.recentActivityPreview({
    ok: false, reason: "source-disabled",
    items: [{ sourceSessionId: "session-beta", summary: "must not render" }]
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "source-disabled");
  assert.deepEqual(plain(denied.items), [], "a denied preview must not expose items");

  assert.deepEqual(plain(__test.recentActivityPreview(null).items), []);
  assert.equal(__test.recentActivityPreview({ ok: true, items: [{ sourceSessionId: "" }] }).items.length, 0);

  assert.equal(__test.recentActivitySafeReason("source-disabled"), "source-disabled");
  assert.equal(__test.recentActivitySafeReason("C:\\private\\db.sqlite"), "");
  assert.equal(__test.recentActivitySafeReason("/var/lib/private/db.sqlite"), "");
  assert.equal(__test.recentActivitySafeError(new Error("HTTP 400")), "HTTP 400");
  assert.equal(__test.recentActivitySafeError("policy-write-failed"), "policy-write-failed");
  assert.equal(__test.recentActivitySafeError("C:\\private\\db.sqlite"), "");
  assert.equal(__test.recentActivitySafeError("token=super-secret"), "");
});

test("renderer shows workspace, pending state, counts, storage and the safe token estimate", () => {
  const { tree } = renderRecent({
    state,
    selectedId: "session-alpha",
    policyDraft: { enabled: true, mode: "shared", shared_session_ids: ["session-beta"] },
    previewTarget: "session-alpha",
    preview
  });

  assert.ok(hasText(tree, "memory.am.recentActivity.title"));
  assert.ok(hasText(tree, "ws-selected"), "the selected Workspace must render");
  assert.ok(hasText(tree, "ws-active"), "the active Workspace must render");
  assert.ok(hasText(tree, "memory.am.recentActivity.pendingBadge"));
  assert.ok(hasText(tree, "memory.am.recentActivity.pending"));
  assert.ok(hasText(tree, "2 / 3"), "participating Sessions must be visible");
  assert.ok(hasText(tree, "7"), "summary count must be visible");
  assert.ok(hasText(tree, "2.0 KiB"), "approximate storage must be visible");
  assert.ok(hasText(tree, "250"), "the injection budget must be visible");
  assert.ok(hasText(tree, "42"), "the preview token estimate must be visible");
  assert.ok(hasText(tree, "2023-11-14 22:13 UTC"), "timestamps must render");
});

test("renderer exposes a searchable Session list, detail modes and an exact-ID shared checklist", () => {
  const { tree } = renderRecent({
    state,
    selectedId: "session-alpha",
    policyDraft: { enabled: true, mode: "shared", shared_session_ids: ["session-beta"] }
  });

  assert.ok(hasText(tree, "Alpha planning"));
  assert.ok(hasText(tree, "session-beta"), "a missing title must fall back to the stable ID");
  assert.ok(hasText(tree, "Gamma review"));
  const search = nodes(tree).find((node) => node.type === "input" && node.props.type === "search");
  assert.ok(search, "the Session list must be filterable");
  assert.equal(search.props.value, "");

  const modeSelect = nodes(tree).find((node) => node.type === "select" && node.props.value === "shared");
  assert.ok(modeSelect, "the detail card must expose the sharing mode select");
  for (const option of nodes(modeSelect)) {
    if (option.type !== "option") continue;
    assert.ok(["self", "owner", "shared"].includes(option.props.value));
  }

  const sharedBeta = nodes(tree).find((node) => node.type === "input"
    && node.props.type === "checkbox" && node.props.value === "session-beta");
  const sharedGamma = nodes(tree).find((node) => node.type === "input"
    && node.props.type === "checkbox" && node.props.value === "session-gamma");
  assert.ok(sharedBeta && sharedGamma, "the checklist must use exact Session ID values");
  assert.equal(sharedBeta.props.checked, true);
  assert.equal(sharedGamma.props.checked, false);
  assert.ok(hasText(tree, "memory.am.recentActivity.sharedSelected"));
  assert.ok(hasText(tree, "memory.am.recentActivity.ownerDegraded"),
    "Owner mode must show the safe-degradation note when no trusted binding is declared");
  assert.ok(hasText(tree, "memory.am.recentActivity.modeOwnerGated"));
});

test("renderer shows the server-filtered preview with source labels, timestamps and token estimates", () => {
  const { tree } = renderRecent({
    state,
    previewTarget: "session-alpha",
    preview
  });
  assert.ok(hasText(tree, "Beta completed a deterministic turn summary."));
  assert.ok(hasText(tree, "memory.am.recentActivity.previewSource"));
  assert.ok(hasText(tree, "session-beta"));
  assert.ok(hasText(tree, "memory.am.recentActivity.previewEstimated"));
  assert.ok(hasText(tree, "2023-11-14 22:13 UTC"));
  assert.ok(hasText(tree, "42"));
  assert.ok(hasText(tree, "memory.am.recentActivity.previewTruncated"));
});

test("renderer handles loading, empty, denied and error states honestly", () => {
  const loading = renderRecent({ state: null, loading: true }).tree;
  assert.ok(hasText(loading, "memory.am.loading"));

  const loadError = renderRecent({ state: null, loading: false, loadError: "load failed" }).tree;
  assert.ok(hasText(loadError, "load failed"));
  assert.ok(nodes(loadError).some((node) => node.props.role === "alert"));

  const emptyState = {
    ...state,
    sessions: [],
    stats: { event_count: 0, source_counts: [], last_updated: null, summary_bytes: 0, policy_count: 0 }
  };
  const empty = renderRecent({ state: emptyState }).tree;
  assert.ok(hasText(empty, "memory.am.recentActivity.sessionsEmpty"));
  assert.ok(hasText(empty, "memory.am.recentActivity.selectSession"));
  assert.ok(hasText(empty, "memory.am.recentActivity.never"));

  const emptyPreview = renderRecent({
    state,
    previewTarget: "session-alpha",
    preview: { ok: true, reason: "ok", items: [], count: 0, estimatedTokens: 0, truncated: false }
  }).tree;
  assert.ok(hasText(emptyPreview, "memory.am.recentActivity.previewEmpty"));

  const denied = renderRecent({
    state,
    previewTarget: "session-alpha",
    preview: { ok: false, reason: "source-disabled", items: [], count: 0, estimatedTokens: 0, truncated: false }
  }).tree;
  assert.ok(hasText(denied, "memory.am.recentActivity.previewDenied"));
  assert.ok(hasText(denied, "memory.am.recentActivity.reasonSourceDisabled"));
});

test("policy save posts exact IDs, re-reads state and refreshes the server preview", async () => {
  const freshState = { ...state, pending_restart: false, enabled: true, configured_enabled: true };
  let policyBody = null;
  const fetchImpl = (call) => {
    if (call.url.endsWith("/recent/policy")) {
      policyBody = JSON.parse(call.body);
      return response({ pending_restart: false });
    }
    if (call.url.includes("/recent/preview?")) return response(preview);
    if (call.url.endsWith("/recent")) return response(freshState);
    throw new Error(`unexpected URL ${call.url}`);
  };
  const { tree, calls } = renderRecent({
    state,
    selectedId: "session-alpha",
    policyDraft: { enabled: true, mode: "shared", shared_session_ids: ["session-beta"] },
    previewTarget: "session-alpha"
  }, fetchImpl);

  const save = button(tree, "memory.am.recentActivity.savePolicy");
  assert.ok(save, "the policy save action must render");
  assert.equal(save.props.disabled, false);
  await save.props.onClick();

  assert.deepEqual(policyBody, {
    source_session_id: "session-alpha",
    enabled: true,
    mode: "shared",
    shared_session_ids: ["session-beta"]
  });
  assert.equal(calls.length, 3, "saving must POST the policy, re-read state and refresh preview");
  assert.ok(calls[0].url.endsWith("/recent/policy") && calls[0].method === "POST");
  assert.ok(calls[1].url.endsWith("/recent") && calls[1].method === "GET");
  assert.ok(calls[2].url.includes("/recent/preview?target_session_id=session-alpha&include_self=false"));
});

test("config save posts the validated shape, re-reads state and refreshes preview", async () => {
  let configBody = null;
  const fetchImpl = (call) => {
    if (call.url.endsWith("/recent/config")) {
      configBody = JSON.parse(call.body);
      return response({ pending_restart: true });
    }
    if (call.url.includes("/recent/preview?")) return response(preview);
    if (call.url.endsWith("/recent")) return response({ ...state, pending_restart: true });
    throw new Error(`unexpected URL ${call.url}`);
  };
  const { tree, calls } = renderRecent({
    state,
    configDraft: { enabled: true, ttl_hours: 24, auto_inject: false, max_items: 5, max_tokens: 200 },
    previewTarget: "session-alpha"
  }, fetchImpl);

  const save = button(tree, "memory.am.recentActivity.saveConfig");
  assert.ok(save);
  await save.props.onClick();

  assert.deepEqual(configBody, {
    enabled: true, ttl_hours: 24, auto_inject: false, max_items: 5, max_tokens: 200
  });
  assert.equal(calls.length, 3, "saving must POST config, re-read state and refresh preview");
  assert.ok(calls[0].url.endsWith("/recent/config") && calls[0].method === "POST");
  assert.ok(calls[1].url.endsWith("/recent") && calls[1].method === "GET");
  assert.ok(calls[2].url.includes("/recent/preview?target_session_id=session-alpha&include_self=false"));
});

test("invalid drafts are rejected locally and never reach the network", async () => {
  const { tree, calls, setters } = renderRecent({
    state,
    configDraft: { enabled: true, ttl_hours: 24, auto_inject: false, max_items: 5, max_tokens: 50 }
  });
  await button(tree, "memory.am.recentActivity.saveConfig").props.onClick();
  assert.equal(calls.length, 0, "an invalid token budget must not be POSTed");
  assert.equal(setters[6], "memory.am.recentActivity.validationMaxTokens");

  const policy = renderRecent({
    state,
    selectedId: "session-alpha",
    policyDraft: { enabled: true, mode: "shared", shared_session_ids: [42] }
  });
  await button(policy.tree, "memory.am.recentActivity.savePolicy").props.onClick();
  assert.equal(policy.calls.length, 0, "an invalid shared ID must not be POSTed");
  assert.equal(policy.setters[11], "memory.am.recentActivity.policySharedInvalid");
});
