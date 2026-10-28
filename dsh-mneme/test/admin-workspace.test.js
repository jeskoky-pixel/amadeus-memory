// Owner-only Workspace selection API. Synthetic registry, temp memory root only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { mountAdminApi } from "../src/admin-api.js";
import * as mneme from "../src/index.js";
import {
  createWorkspaceAccessGuard,
  readWorkspaceBinding,
  workspaceDataDirFor
} from "../src/workspace-binding.js";

const WORKSPACE_URL = "/api/amadeus-memory/admin/workspace";
const tempDirs = [];

function tempMemoryDir() {
  const dir = mkdtempSync(join(tmpdir(), "mneme-admin-workspace-"));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function writeBinding(dir, workspaceId) {
  writeFileSync(
    join(dir, "workspace-binding.json"),
    `${JSON.stringify({ version: 1, workspaceId }, null, 2)}\n`,
    "utf8"
  );
}

function baseWorkspaces() {
  return [
    { id: "ws-a", title: "Alpha", sessionIds: ["s1", "s2"] },
    { id: "ws-b", title: "Beta", sessionIds: ["s3"] }
  ];
}

function setup({
  controlRoot = tempMemoryDir(),
  workspaces = baseWorkspaces(),
  owner = true,
  activeWorkspaceId = null,
  registryMode = "ok",
  seedBinding = null
} = {}) {
  if (seedBinding !== null) writeBinding(controlRoot, seedBinding);

  const store = createStore(":memory:");
  const config = { language: "zh", autoInject: true, autoSummarize: true };
  const service = createService({ store, mirror: null, config });
  const settings = createSettings(store.db);
  const routes = [];
  const registry = registryMode === "throwing"
    ? { list() { throw new Error("registry unavailable"); } }
    : registryMode === "malformed"
      ? { list() { return "not-a-list"; } }
      : registryMode === "missing"
        ? null
        : { list: () => workspaces };

  const ctx = {
    ...(registry ? { workspaceRegistry: registry } : {}),
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      }
    },
    connection: {
      admit(req) {
        if (req.headers?.["x-test-unauthenticated"] === "1") return { rejection: 401 };
        return { peer: { principal: { kind: owner ? "owner" : "guest" } } };
      }
    },
    inject(names, apply) { apply(ctx); },
    effect(fn) { return fn(); }
  };

  mountAdminApi(ctx, {
    service, settings, store, config,
    controlRoot,
    activeWorkspaceId,
    runtimeMode: activeWorkspaceId ? "selected" : "unbound"
  });
  assert.equal(routes.length, 1);

  return {
    dir: controlRoot,
    workspaces,
    store,
    route: routes[0],
    ctx,
    close: () => store.close()
  };
}

function makeRes() {
  return {
    status: 0,
    body: "",
    headers: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = String(body ?? ""); }
  };
}

function req({ method = "GET", url = "/", headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    headers: { host: "127.0.0.1:5119", origin: "http://127.0.0.1:5119", ...headers },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; }
  };
}

async function callRoute(route, options) {
  const res = makeRes();
  await route.handler(req(options), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* non-JSON */ }
  return { status: res.status, json, body: res.body };
}

function call(h, options) {
  return callRoute(h.route, options);
}

function post(body, headers = {}) {
  return {
    method: "POST",
    url: WORKSPACE_URL,
    headers: { "content-type": "application/json", "x-amadeus-memory": "1", ...headers },
    body
  };
}

test("admin workspace: GET lists live trusted IDs, titles and counts without paths or session IDs", async () => {
  const workspaces = baseWorkspaces();
  const h = setup({ workspaces, activeWorkspaceId: "ws-a", seedBinding: "ws-a" });
  try {
    const first = await call(h, { url: WORKSPACE_URL });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.data.workspaces, [
      { id: "ws-a", title: "Alpha", session_count: 2 },
      { id: "ws-b", title: "Beta", session_count: 1 }
    ]);
    assert.equal(first.json.data.selected_workspace_id, "ws-a");
    assert.equal(first.json.data.active_workspace_id, "ws-a");
    assert.equal(first.json.data.runtime_mode, "selected");
    assert.equal(first.json.data.pending_remount, false);
    assert.equal(first.json.data.restart_required, false);
    assert.equal(first.json.data.registry_available, true);
    assert.equal(first.json.data.remount.supported, false);
    assert.equal(first.body.includes(h.dir), false, "the control root path must not be exposed");
    assert.equal(first.body.includes("memory.db"), false, "database paths must not be exposed");
    assert.equal(first.body.includes("s1"), false, "session IDs must not be exposed");
    assert.equal(first.body.includes("s2"), false, "session IDs must not be exposed");

    // The Registry is read per request; a title or membership edit is visible.
    workspaces[0].sessionIds = ["s1", "s2", "s4"];
    workspaces[1].title = "Beta updated";
    const second = await call(h, { url: WORKSPACE_URL });
    assert.equal(second.status, 200);
    assert.equal(second.json.data.workspaces[0].session_count, 3);
    assert.equal(second.json.data.workspaces[1].title, "Beta updated");
  } finally {
    h.close();
  }
});

test("admin workspace: first install exposes the API, requires confirmation, and never claims activation", async () => {
  const h = setup();
  try {
    const before = await call(h, { url: WORKSPACE_URL });
    assert.equal(before.status, 200);
    assert.equal(before.json.data.selected_workspace_id, null);
    assert.equal(before.json.data.active_workspace_id, null);
    assert.equal(before.json.data.runtime_mode, "unbound");
    assert.equal(before.json.data.pending_remount, false);
    assert.equal(before.json.data.workspaces.length, 2);

    const unconfirmed = await call(h, post({ workspace_id: "ws-b" }));
    assert.equal(unconfirmed.status, 400);
    assert.equal(unconfirmed.json.reason, "confirmation-required");
    assert.equal(existsSync(join(h.dir, "workspace-binding.json")), false, "a rejected change must not write a binding");

    const selected = await call(h, post({ workspace_id: "ws-b", confirm: true }));
    assert.equal(selected.status, 200);
    assert.equal(selected.json.data.changed, true);
    assert.equal(selected.json.data.selected_workspace_id, "ws-b");
    assert.equal(selected.json.data.active_workspace_id, null, "the old runtime must not be reported as active");
    assert.equal(selected.json.data.pending_remount, true);
    assert.equal(selected.json.data.restart_required, true);
    assert.match(selected.json.data.message, /restart or reload/i);
    assert.equal(readWorkspaceBinding(h.dir).workspaceId, "ws-b");

    assert.equal(existsSync(join(h.dir, "workspace-binding.json")), true, "binding is stored at the control root");
    assert.equal(existsSync(workspaceDataDirFor(h.dir, "ws-b")), false, "selection must not initialize or migrate workspace data");
  } finally {
    h.close();
  }
});

test("admin workspace: invalid or unavailable Registry fails without mutating the binding", async () => {
  const h = setup({ activeWorkspaceId: "ws-a", seedBinding: "ws-a" });
  try {
    const byTitle = await call(h, post({ workspace_id: "Alpha", confirm: true }));
    assert.equal(byTitle.status, 400);
    assert.equal(byTitle.json.reason, "unknown-workspace-id");
    assert.equal(readWorkspaceBinding(h.dir).workspaceId, "ws-a", "title must never select a Workspace");

    const unknown = await call(h, post({ workspace_id: "ws-missing", confirm: true }));
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.reason, "unknown-workspace-id");
    assert.equal(readWorkspaceBinding(h.dir).workspaceId, "ws-a");

    h.ctx.workspaceRegistry = { list() { throw new Error("registry unavailable"); } };
    const unavailable = await call(h, post({ workspace_id: "ws-b", confirm: true }));
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.json.reason, "registry-unavailable");
    assert.equal(readWorkspaceBinding(h.dir).workspaceId, "ws-a", "an unavailable Registry must not change the binding");

    const read = await call(h, { url: WORKSPACE_URL });
    assert.equal(read.status, 200);
    assert.equal(read.json.data.registry_available, false);
    assert.deepEqual(read.json.data.workspaces, []);
    assert.equal(read.json.data.registry_error, "registry-unavailable");
    assert.equal(read.json.data.selected_workspace_id, "ws-a");
    assert.equal(read.body.includes(h.dir), false);
  } finally {
    h.close();
  }
});

test("admin workspace: owner authentication, same-origin and request marker apply", async () => {
  const h = setup();
  try {
    const unauthenticated = await call(h, {
      url: WORKSPACE_URL,
      headers: { "x-test-unauthenticated": "1" }
    });
    assert.equal(unauthenticated.status, 401);

    const crossOrigin = await call(h, { url: WORKSPACE_URL, headers: { origin: "https://evil.example" } });
    assert.equal(crossOrigin.status, 403);

    const missingMarker = await call(h, {
      method: "POST",
      url: WORKSPACE_URL,
      headers: { "content-type": "application/json" },
      body: { workspace_id: "ws-b", confirm: true }
    });
    assert.equal(missingMarker.status, 403);
    assert.equal(existsSync(join(h.dir, "workspace-binding.json")), false);

    const guest = setup({ owner: false });
    try {
      const denied = await call(guest, { url: WORKSPACE_URL });
      assert.equal(denied.status, 403);
      assert.equal((await call(guest, post({ workspace_id: "ws-b", confirm: true }))).status, 403);
    } finally {
      guest.close();
    }
  } finally {
    h.close();
  }
});

test("admin workspace: same-ID selection is a confirmation-free no-op", async () => {
  const h = setup({ activeWorkspaceId: "ws-a", seedBinding: "ws-a" });
  try {
    const same = await call(h, post({ workspace_id: "ws-a" }));
    assert.equal(same.status, 200);
    assert.equal(same.json.data.changed, false);
    assert.equal(same.json.data.old_workspace_id, "ws-a");
    assert.equal(same.json.data.selected_workspace_id, "ws-a");
    assert.equal(same.json.data.active_workspace_id, "ws-a");
    assert.equal(same.json.data.pending_remount, false);
    assert.equal(readWorkspaceBinding(h.dir).workspaceId, "ws-a");

    const confirmed = await call(h, post({ workspace_id: "ws-a", confirm: true }));
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.json.data.changed, false);
  } finally {
    h.close();
  }
});

test("admin workspace: selecting another ID immediately denies the old runtime guard and retains the old database", async () => {
  const dir = tempMemoryDir();
  const legacy = Buffer.from("legacy-control-root-database");
  writeFileSync(join(dir, "memory.db"), legacy);
  const oldDataDir = workspaceDataDirFor(dir, "ws-a");
  mkdirSync(oldDataDir, { recursive: true });
  writeFileSync(
    join(oldDataDir, ".mneme-workspace.json"),
    `${JSON.stringify({ version: 1, workspaceId: "ws-a" })}\n`,
    "utf8"
  );
  const oldWorkspaceDb = Buffer.from("old-workspace-a-database");
  writeFileSync(join(oldDataDir, "memory.db"), oldWorkspaceDb);
  const h = setup({ controlRoot: dir, activeWorkspaceId: "ws-a", seedBinding: "ws-a" });
  try {
    const guard = createWorkspaceAccessGuard({
      memoryDir: dir,
      activeWorkspaceId: "ws-a",
      ctx: h.ctx
    });
    assert.deepEqual(guard.authorize({ id: "s1" }), {
      allowed: true,
      reason: "ok",
      workspaceId: "ws-a"
    });

    const selected = await call(h, post({ workspace_id: "ws-b", confirm: true }));
    assert.equal(selected.status, 200);
    assert.equal(selected.json.data.selected_workspace_id, "ws-b");
    assert.equal(selected.json.data.active_workspace_id, "ws-a");
    assert.equal(selected.json.data.pending_remount, true);

    assert.deepEqual(guard.authorize({ id: "s1" }), {
      allowed: false,
      reason: "binding-changed-pending-remount",
      workspaceId: null
    });

    // Selecting the original ID back is still a change for this mount: the old
    // runtime latched on the first mismatch and still needs a remount.
    const back = await call(h, post({ workspace_id: "ws-a", confirm: true }));
    assert.equal(back.status, 200);
    assert.equal(back.json.data.selected_workspace_id, "ws-a");
    assert.equal(back.json.data.active_workspace_id, "ws-a");
    assert.equal(back.json.data.pending_remount, true);
    assert.equal(back.json.data.restart_required, true);
    assert.equal(guard.authorize({ id: "s1" }).reason, "binding-changed-pending-remount");

    assert.deepEqual(readFileSync(join(dir, "memory.db")), legacy, "the legacy control-root database must be retained");
    assert.deepEqual(readFileSync(join(oldDataDir, "memory.db")), oldWorkspaceDb,
      "the old Workspace database must be retained");
    assert.equal(JSON.parse(readFileSync(join(oldDataDir, ".mneme-workspace.json"), "utf8")).workspaceId, "ws-a");
    assert.equal(existsSync(workspaceDataDirFor(dir, "ws-b")), false,
      "the API must not initialize or migrate the newly selected Workspace");
  } finally {
    h.close();
  }
});

test("admin workspace: selection persists across a new plugin mount as pending remount", async () => {
  const dir = tempMemoryDir();
  const first = setup({ controlRoot: dir });
  try {
    const selected = await call(first, post({ workspace_id: "ws-b", confirm: true }));
    assert.equal(selected.status, 200);
    assert.equal(selected.json.data.changed, true);
  } finally {
    first.close();
  }

  const second = setup({ controlRoot: dir });
  try {
    const read = await call(second, { url: WORKSPACE_URL });
    assert.equal(read.status, 200);
    assert.equal(read.json.data.selected_workspace_id, "ws-b");
    assert.equal(read.json.data.active_workspace_id, null);
    assert.equal(read.json.data.pending_remount, true);
    assert.equal(read.json.data.restart_required, true);
    assert.equal(read.json.data.workspaces.some((workspace) => workspace.id === "ws-b"), true);
  } finally {
    second.close();
  }
});

test("admin workspace: malformed Registry reports unavailable and cannot select", async () => {
  const h = setup({ registryMode: "malformed" });
  try {
    const read = await call(h, { url: WORKSPACE_URL });
    assert.equal(read.status, 200);
    assert.equal(read.json.data.registry_available, false);
    assert.equal(read.json.data.registry_error, "malformed-registry");

    const select = await call(h, post({ workspace_id: "ws-a", confirm: true }));
    assert.equal(select.status, 503);
    assert.equal(existsSync(join(h.dir, "workspace-binding.json")), false);
  } finally {
    h.close();
  }
});

test("admin workspace: first-install full boot exposes the route and writes only to the control root", async () => {
  const dir = tempMemoryDir();
  const routes = [];
  const ctx = new Context();
  ctx.provide("tools", { register() { return () => {}; } });
  ctx.provide("commands", { register() { return () => {}; } });
  ctx.provide("systemPrompt", {
    context() { return () => {}; },
    section() { return () => {}; }
  });
  ctx.provide("agentDefaultModel", {
    currentSelection() { return { provider: "mock", model: "mock" }; }
  });
  ctx.provide("llm", {
    async *stream() { yield { type: "finish", reason: { kind: "stop" } }; }
  });
  ctx.provide("webServer", {
    register(route) { routes.push(route); return () => {}; }
  });
  ctx.provide("workspaceRegistry", { list: () => baseWorkspaces() });
  ctx.provide("connection", {
    admit() { return { peer: { principal: { kind: "owner" } } }; }
  });

  const fiber = ctx.plugin(mneme, { memoryDir: dir, lightMode: true });
  await fiber;
  try {
    const route = routes.find((candidate) =>
      candidate.path === "/api/amadeus-memory/admin" && candidate.kind === "prefix");
    assert.ok(route, "the owner admin route is mounted even with no binding");

    const read = await callRoute(route, { url: WORKSPACE_URL });
    assert.equal(read.status, 200);
    assert.equal(read.json.data.selected_workspace_id, null);
    assert.equal(read.json.data.active_workspace_id, null);
    assert.equal(read.json.data.pending_remount, false);
    assert.equal(read.json.data.workspaces.length, 2);

    const selected = await callRoute(route, post({ workspace_id: "ws-b", confirm: true }));
    assert.equal(selected.status, 200);
    assert.equal(selected.json.data.changed, true);
    assert.equal(selected.json.data.pending_remount, true);
    assert.equal(existsSync(join(dir, "workspace-binding.json")), true);
    assert.equal(existsSync(join(dir, "unbound", "workspace-binding.json")), false,
      "the API must not use the unbound runtime directory as the control root");
    assert.equal(existsSync(join(dir, "memory.db")), false,
      "the legacy control-root database must not be created");
  } finally {
    await fiber.dispose();
  }
});
