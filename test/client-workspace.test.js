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
    createElement(type) { return { type }; },
    useState(value) { return [value, () => {}]; },
    useRef(value) { return { current: value }; },
    useEffect() {},
    useCallback(fn) { return fn; },
    useMemo(fn) { return fn(); }
  };
}

function loadClient(react = fakeReact()) {
  let loaded;
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
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) })
  };
  vm.runInNewContext(clientSource, sandbox, { filename: join(root, "lib/client.js") });
  assert.ok(loaded, "client bundle must register through __ModuleLoader__");
  return loaded.factory(() => react);
}

function cardSource() {
  const start = clientSource.indexOf("function AmadeusWorkspaceCard(");
  const end = clientSource.indexOf("function AmadeusMemorySettings(", start);
  assert.ok(start >= 0 && end > start, "workspace card component must exist before the settings component");
  return clientSource.slice(start, end);
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

function renderCard(overrides = {}) {
  const values = [
    overrides.data ?? null,
    overrides.draft ?? "",
    overrides.confirming ?? false,
    overrides.saving ?? false,
    overrides.notice ?? "",
    overrides.error ?? "",
    overrides.loading ?? false
  ];
  let slot = 0;
  const setters = [];
  const react = {
    Fragment: Symbol("Fragment"),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(initial) {
      const index = slot++;
      return [values[index], (next) => { setters[index] = next; }];
    },
    useRef(value) { return { current: value }; },
    useEffect() {},
    useCallback(fn) { return fn; },
    useMemo(fn) { return fn(); }
  };
  const module = loadClient(react);
  const tree = module.__test.AmadeusWorkspaceCard({ t: (key) => key });
  return { tree, setters };
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

function button(tree, key) {
  return nodes(tree).find((node) => node.type === "button" && hasText(node, key)) || null;
}

const registry = [
  { id: "w-alpha", title: "Alpha Workspace", session_count: 3 },
  { id: "w-beta", title: "Beta Workspace", session_count: 0 },
  { id: "w-alpha", title: "Duplicate Alpha", session_count: 9 }
];

const loadedData = {
  workspaces: registry,
  selected_workspace_id: null,
  active_workspace_id: null,
  runtime_mode: "unbound",
  pending_remount: false,
  restart_required: false,
  registry_available: true
};

test("workspace card is a bilingual, keyboard-accessible single select in the Memory view", () => {
  const keys = [
    "memory.am.workspace.title",
    "memory.am.workspace.hint",
    "memory.am.workspace.selectLabel",
    "memory.am.workspace.choose",
    "memory.am.workspace.none",
    "memory.am.workspace.untitled",
    "memory.am.workspace.sessions",
    "memory.am.workspace.selected",
    "memory.am.workspace.active",
    "memory.am.workspace.activeNone",
    "memory.am.workspace.selectedUnknown",
    "memory.am.workspace.pendingBadge",
    "memory.am.workspace.pending",
    "memory.am.workspace.save",
    "memory.am.workspace.saving",
    "memory.am.workspace.cancel",
    "memory.am.workspace.sameSelection",
    "memory.am.workspace.invalidSelection",
    "memory.am.workspace.registryUnavailable",
    "memory.am.workspace.registryEmpty",
    "memory.am.workspace.reason",
    "memory.am.workspace.loadFailed",
    "memory.am.workspace.saveFailed",
    "memory.am.workspace.savedPending",
    "memory.am.workspace.savedNoChange",
    "memory.am.workspace.confirmTitle",
    "memory.am.workspace.confirmTarget",
    "memory.am.workspace.confirmStop",
    "memory.am.workspace.confirmRetained",
    "memory.am.workspace.confirmRestart",
    "memory.am.workspace.confirmAction"
  ];
  for (const key of keys) {
    assert.ok((clientSource.split(`"${key}"`).length - 1) >= 2, `bilingual key ${key} must exist in zh and en`);
  }
  assert.ok(clientSource.includes('"memory.am.workspace.none": "尚未选择工作区"'),
    "first install must show the exact required Chinese no-binding copy");

  const placement = '!settingsOnly && panelTab === "memory" && h(AmadeusWorkspaceCard, { t })';
  const cardAt = clientSource.indexOf(placement);
  const tabsAt = clientSource.indexOf('!settingsOnly && panelTab === "memory" && renderTabs(memoryTabs');
  assert.ok(cardAt > 0, "the Memory view must mount the workspace card");
  assert.ok(cardAt < tabsAt, "the card must sit at the top of the Memory/Recent view");

  const source = cardSource();
  assert.ok(source.includes('h("select"'), "the control must be a native select");
  assert.ok(source.includes('className: "mneme-set-input"'), "the select must reuse the existing input style");
  assert.ok(source.includes("disabled: !view.available || view.items.length === 0 || saving"),
    "registry/validity state must disable the native select");
  assert.ok(source.includes("onChange: (event) => {") && source.includes("setDraft(event.target.value)"),
    "selection must flow through the native select value");
  assert.ok(source.includes("h(\"label\""), "the control must have a real label");
  assert.equal(source.includes('h("input"'), false, "there must be no free-text ID input");
  assert.equal(source.includes("multiple"), false, "there must be no multi-select");
  assert.ok(source.includes('t("memory.am.workspace.sessions")') && source.includes("session_count"),
    "the display must include the session count");
  assert.ok(source.includes('t("memory.am.workspace.selected")') && source.includes('t("memory.am.workspace.active")'),
    "the card must distinguish selected from active state");
});

test("workspace model keeps first-install, same-ID and invalid selections honest", () => {
  const { __test } = loadClient();

  const first = __test.workspaceCardModel(loadedData, "");
  assert.equal(first.available, true);
  assert.equal(first.selectedId, null);
  assert.equal(first.selectedItem, null);
  assert.equal(first.activeId, null);
  assert.equal(first.items.length, 2, "duplicate Registry rows must be collapsed by exact ID");
  assert.equal(first.items[0].title, "Alpha Workspace");
  assert.equal(first.items[0].session_count, 3);
  assert.equal(first.canSave, false, "nothing can be saved before a Workspace is chosen");
  assert.equal(first.same, false);

  const chosen = __test.workspaceCardModel(loadedData, "w-beta");
  assert.equal(chosen.valid, true);
  assert.equal(chosen.canSave, true, "first install must allow choosing a Workspace from the GUI");
  assert.equal(chosen.draftItem.title, "Beta Workspace");
  assert.equal(chosen.draftItem.session_count, 0);

  const selected = { ...loadedData, selected_workspace_id: "w-alpha", active_workspace_id: "w-alpha", runtime_mode: "selected" };
  const same = __test.workspaceCardModel(selected, "w-alpha");
  assert.equal(same.same, true);
  assert.equal(same.canSave, false, "same-ID selection is a no-op");

  const invalid = __test.workspaceCardModel(selected, "w-missing");
  assert.equal(invalid.valid, false);
  assert.equal(invalid.canSave, false, "an ID outside the Registry can never be saved");

  const blank = __test.workspaceCardModel(selected, "");
  assert.equal(blank.valid, false);
  assert.equal(blank.canSave, false);
});

test("workspace model exposes pending restart, unavailable Registry and safe reasons", () => {
  const { __test } = loadClient();

  const pending = __test.workspaceCardModel({
    workspaces: registry,
    selected_workspace_id: "w-beta",
    active_workspace_id: "w-alpha",
    runtime_mode: "selected",
    pending_remount: true,
    restart_required: true,
    registry_available: true
  }, "w-beta");
  assert.equal(pending.pending, true);
  assert.equal(pending.selectedItem.title, "Beta Workspace");
  assert.equal(pending.activeItem.title, "Alpha Workspace");
  assert.equal(pending.canSave, false);

  const mismatchOnly = __test.workspaceCardModel({
    workspaces: registry,
    selected_workspace_id: "w-beta",
    active_workspace_id: "w-alpha",
    pending_remount: false,
    restart_required: false,
    registry_available: true
  }, "w-beta");
  assert.equal(mismatchOnly.pending, true, "selected != active must still be shown as restart pending");

  const unavailable = __test.workspaceCardModel({
    workspaces: [],
    selected_workspace_id: null,
    active_workspace_id: null,
    pending_remount: false,
    restart_required: false,
    registry_available: false,
    registry_error: "registry-unavailable"
  }, "");
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.items.length, 0);
  assert.equal(unavailable.canSave, false);
  assert.equal(unavailable.diagnostic, "registry-unavailable");

  assert.equal(__test.workspaceSafeReason("registry-unavailable"), "registry-unavailable");
  assert.equal(__test.workspaceSafeReason("C:\\private\\registry\\secret.json"), "",
    "Windows paths must never be rendered");
  assert.equal(__test.workspaceSafeReason("/var/lib/private/secret-registry.json"), "",
    "POSIX paths must never be rendered");
  assert.equal(__test.workspaceSafeReason("token=super-secret"), "",
    "free-form secrets must never be rendered");
  assert.equal(__test.workspaceSafeReason({ reason: "registry-unavailable" }), "");

  const pathReason = __test.workspaceCardModel({
    workspaces: [],
    selected_workspace_id: null,
    active_workspace_id: null,
    registry_available: false,
    registry_error: "/var/lib/private/secret-registry.json"
  }, "");
  assert.equal(pathReason.diagnostic, "", "a path-like registry_error must be suppressed");
  assert.equal(__test.workspaceList({ registry_available: false, workspaces: registry }).length, 0,
    "an unavailable Registry must not be presented as an empty valid list");
});

test("save requires the explicit confirmation step and POSTs the exact ID shape", () => {
  const source = cardSource();

  const askAt = source.indexOf("const askConfirm");
  const saveAt = source.indexOf("const save = async");
  assert.ok(askAt >= 0 && saveAt > askAt, "askConfirm and save must both exist");
  const askSource = source.slice(askAt, saveAt);
  assert.ok(askSource.includes("setConfirming(true)"));
  assert.equal(askSource.includes("adminJson("), false, "the first click must not POST");

  assert.ok(askSource.includes("if (!view.canSave || saving) return;"));
  assert.ok(source.slice(saveAt).includes("if (!view.canSave || saving) return;"),
    "the confirmed save must re-check validity and same-ID no-op");

  assert.match(source, /adminJson\("\/workspace",\s*\{\s*method: "POST",\s*body: JSON\.stringify\(\{ workspace_id: view\.draftId, confirm: true \}\)\s*\}\)/,
    "POST must use adminJson, the native workspaces route and the exact draft ID + confirm:true");

  const postAt = source.indexOf('method: "POST"');
  const refreshAt = source.indexOf('const fresh = await adminJson("/workspace")');
  assert.ok(postAt > 0 && refreshAt > postAt, "a successful save must refresh through GET");

  const confirmAt = source.indexOf("memory.am.workspace.confirmAction");
  assert.ok(confirmAt > 0 && source.slice(Math.max(0, confirmAt - 320), confirmAt).includes("onClick: save"),
    "the POST must only be reachable from the confirmation action");
  assert.ok(source.includes('t("memory.am.workspace.confirmStop")')
    && source.includes('t("memory.am.workspace.confirmRetained")')
    && source.includes('t("memory.am.workspace.confirmRestart")'),
    "the confirmation must describe immediate stop, retained data and plugin restart");
  assert.ok(source.includes('className: "mneme-pending"') && source.includes("mneme-badge--pending"),
    "pending restart must be prominent");
  assert.equal(/active_workspace_id\s*:/.test(source), false,
    "the client must never claim the newly selected Workspace is active");

  assert.ok(clientSource.includes('t("memory.am.recent.hotHint")') && clientSource.includes('t("memory.am.recent.trustedHint")'),
    "the original Hot Memory/Recent panel must stay untouched");
  assert.equal((clientSource.match(/onClick: clearRecent/g) || []).length, 1);
});

test("workspace renderer shows pending restart without claiming the new Workspace is active", () => {
  const data = {
    workspaces: registry,
    selected_workspace_id: "w-beta",
    active_workspace_id: "w-alpha",
    runtime_mode: "selected",
    pending_remount: true,
    restart_required: true,
    registry_available: true
  };
  const { tree } = renderCard({ data, draft: "w-beta" });
  assert.ok(hasText(tree, "memory.am.workspace.pending"), "the pending restart banner must render");
  assert.ok(hasText(tree, "memory.am.workspace.pendingBadge"), "the pending badge must render");
  assert.ok(hasText(tree, "Alpha Workspace"), "the still-active Workspace must be shown");
  assert.ok(hasText(tree, "Beta Workspace"), "the selected Workspace must be shown");
  assert.ok(hasText(tree, "memory.am.workspace.sessions"));
  const select = nodes(tree).find((node) => node.type === "select");
  assert.ok(select, "the native select must render");
  assert.equal(select.props.value, "w-beta");
  assert.equal(select.props.disabled, false);
  assert.equal(select.props.multiple, undefined, "the control must be a single select");
  const save = button(tree, "memory.am.workspace.save");
  assert.equal(save.props.disabled, true, "same-ID save must be disabled");
});

test("workspace renderer handles missing Registry, invalid IDs and first install", () => {
  const unavailable = renderCard({
    data: {
      workspaces: [],
      selected_workspace_id: null,
      active_workspace_id: null,
      pending_remount: false,
      restart_required: false,
      registry_available: false,
      registry_error: "registry-unavailable"
    },
    draft: ""
  }).tree;
  assert.ok(hasText(unavailable, "memory.am.workspace.registryUnavailable"));
  assert.ok(hasText(unavailable, "registry-unavailable"));
  const unavailableSelect = nodes(unavailable).find((node) => node.type === "select");
  assert.equal(unavailableSelect.props.disabled, true);
  assert.equal(button(unavailable, "memory.am.workspace.save").props.disabled, true);

  const firstInstall = renderCard({ data: loadedData, draft: "" }).tree;
  assert.ok(hasText(firstInstall, "memory.am.workspace.none"), "first install must render the no-binding copy");
  assert.equal(button(firstInstall, "memory.am.workspace.save").props.disabled, true);

  const invalid = renderCard({
    data: { ...loadedData, selected_workspace_id: "w-alpha", active_workspace_id: "w-alpha" },
    draft: "w-gone"
  }).tree;
  assert.ok(hasText(invalid, "memory.am.workspace.invalidSelection"));
  assert.equal(button(invalid, "memory.am.workspace.save").props.disabled, true);
});

test("workspace renderer opens confirmation without saving, then renders the consequences", () => {
  const data = { ...loadedData };
  const { tree, setters } = renderCard({ data, draft: "w-alpha" });
  const save = button(tree, "memory.am.workspace.save");
  assert.equal(save.props.disabled, false, "a changed valid selection can open confirmation");
  save.props.onClick();
  assert.equal(setters[2], true, "the first action only opens the confirmation step");

  const confirming = renderCard({ data, draft: "w-alpha", confirming: true }).tree;
  for (const key of [
    "memory.am.workspace.confirmTitle",
    "memory.am.workspace.confirmStop",
    "memory.am.workspace.confirmRetained",
    "memory.am.workspace.confirmRestart"
  ]) {
    assert.ok(hasText(confirming, key), `confirmation must render ${key}`);
  }
  assert.ok(hasText(confirming, "Alpha Workspace"));
  const confirm = button(confirming, "memory.am.workspace.confirmAction");
  assert.ok(confirm, "the confirmation action must exist");
  assert.equal(typeof confirm.props.onClick, "function");
  assert.ok(button(confirming, "memory.am.workspace.cancel"), "the confirmation must be cancellable");
});
