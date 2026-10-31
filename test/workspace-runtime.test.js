import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import * as mneme from "../src/index.js";
import { createTools } from "../src/tools.js";
import { createInjector } from "../src/inject.js";
import { createSummarizer } from "../src/summarize.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { initializeWorkspaceDataDir, setWorkspaceBinding, workspaceDataDirFor } from "../src/workspace-binding.js";

const tempDirs = [];

function tempMemoryDir() {
  const dir = mkdtempSync(join(tmpdir(), "mneme-workspace-runtime-"));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function registryCtx(workspaces) {
  return { workspaceRegistry: { list: () => workspaces } };
}

function select(dir, workspaceId, ctx) {
  const result = setWorkspaceBinding({ memoryDir: dir, workspaceId, ctx });
  assert.equal(result.ok, true);
  const initialized = initializeWorkspaceDataDir(dir);
  assert.equal(initialized.ok, true);
  return result;
}

function rootDb(path) {
  return { path: join(path, "memory.db") };
}

function assertRootUntouched(dir, bytes) {
  const db = rootDb(dir);
  assert.deepEqual(readFileSync(db.path), bytes);
  assert.equal(existsSync(`${db.path}-wal`), false);
  assert.equal(existsSync(`${db.path}-shm`), false);
}

function session(id, events = []) {
  return {
    id,
    events,
    snapshotEvents() { return this.events; }
  };
}

function userMessage(text, seq = 1) {
  return {
    seq,
    type: "user/message",
    data: { source: { kind: "user" }, content: [{ type: "text", text }] }
  };
}

test("workspace-runtime: unbound boot uses a separate control database and never touches the root DB", async () => {
  const dir = tempMemoryDir();
  const bytes = Buffer.from("root-database-sentinel");
  writeFileSync(join(dir, "memory.db"), bytes);

  const runtime = mneme.resolveWorkspaceRuntime({ memoryDir: dir });
  assert.equal(runtime.mode, "unbound");
  assert.equal(runtime.activeWorkspaceId, null);
  assert.equal(runtime.runtimeDir, join(dir, "unbound"));
  assert.equal(runtime.legacyRootDatabase, true);
  assert.equal(existsSync(join(dir, "workspaces")), false, "unbound boot must not create workspace data");

  const store = createStore(join(runtime.runtimeDir, "memory.db"));
  assert.equal(store.count(), 0, "the unbound control database starts empty");
  store.close();
  assertRootUntouched(dir, bytes);

  const { createWorkspaceAccessGuard } = await import("../src/workspace-binding.js");
  const guard = createWorkspaceAccessGuard({
    memoryDir: dir,
    activeWorkspaceId: null,
    ctx: registryCtx([{ id: "ws-a", title: "A", sessionIds: ["s1"] }])
  });
  assert.deepEqual(guard.authorize({ id: "s1" }), {
    allowed: false,
    reason: "binding-unbound",
    workspaceId: null
  });
});

test("workspace-runtime: selected boot opens only the isolated store and leaves the root DB byte-identical", () => {
  const dir = tempMemoryDir();
  const bytes = Buffer.from("root-database-sentinel");
  writeFileSync(join(dir, "memory.db"), bytes);
  const ctx = registryCtx([{ id: "ws-a", title: "A", sessionIds: ["s1"] }]);
  select(dir, "ws-a", ctx);

  const runtime = mneme.resolveWorkspaceRuntime({ memoryDir: dir, ctx });
  assert.equal(runtime.mode, "selected");
  assert.equal(runtime.activeWorkspaceId, "ws-a");
  assert.equal(runtime.runtimeDir, workspaceDataDirFor(dir, "ws-a"));
  assert.notEqual(runtime.runtimeDir, dir);
  assert.equal(runtime.registryKnown, true);

  const store = createStore(join(runtime.runtimeDir, "memory.db"));
  store.save({ type: "project", title: "isolated", content: "only here" });
  assert.equal(store.count(), 1);
  store.close();

  assertRootUntouched(dir, bytes);

  // A later boot resolves the same isolated directory and sees the same data.
  const again = mneme.resolveWorkspaceRuntime({ memoryDir: dir, ctx });
  const reopened = createStore(join(again.runtimeDir, "memory.db"));
  assert.equal(reopened.count(), 1);
  reopened.close();
});

test("workspace-runtime: absent root DB is never created by boot or isolated store use", () => {
  const dir = tempMemoryDir();
  const ctx = registryCtx([{ id: "ws-a", title: "A", sessionIds: ["s1"] }]);
  select(dir, "ws-a", ctx);
  const runtime = mneme.resolveWorkspaceRuntime({ memoryDir: dir, ctx });
  const store = createStore(join(runtime.runtimeDir, "memory.db"));
  store.save({ type: "history", title: "t", content: "c" });
  store.close();

  assert.equal(existsSync(join(dir, "memory.db")), false);
  assert.equal(existsSync(`${join(dir, "memory.db")}-wal`), false);
});

test("workspace-runtime: corrupt binding falls back to unbound with a diagnostic", () => {
  const dir = tempMemoryDir();
  const bytes = Buffer.from("root-database-sentinel");
  writeFileSync(join(dir, "memory.db"), bytes);
  writeFileSync(join(dir, "workspace-binding.json"), "{broken", "utf8");

  const runtime = mneme.resolveWorkspaceRuntime({ memoryDir: dir });
  assert.equal(runtime.mode, "unbound");
  assert.equal(runtime.activeWorkspaceId, null);
  assert.equal(runtime.diagnostic, "binding-corrupt");
  assert.equal(runtime.runtimeDir, join(dir, "unbound"));
  assertRootUntouched(dir, bytes);
});

test("workspace-runtime: marker mismatch falls back to unbound without adopting or changing workspace data", () => {
  const dir = tempMemoryDir();
  const ctx = registryCtx([{ id: "ws-a", title: "A", sessionIds: ["s1"] }]);
  select(dir, "ws-a", ctx);
  const dataPath = workspaceDataDirFor(dir, "ws-a");
  writeFileSync(join(dataPath, ".mneme-workspace.json"), JSON.stringify({ version: 1, workspaceId: "ws-b" }));

  const runtime = mneme.resolveWorkspaceRuntime({ memoryDir: dir, ctx });
  assert.equal(runtime.mode, "unbound");
  assert.equal(runtime.activeWorkspaceId, null);
  assert.equal(runtime.diagnostic, "marker-mismatch");
  assert.equal(runtime.runtimeDir, join(dir, "unbound"));
  assert.equal(
    JSON.parse(readFileSync(join(dataPath, ".mneme-workspace.json"), "utf8")).workspaceId,
    "ws-b",
    "a mismatched marker is not rewritten or migrated"
  );
});

test("workspace-runtime: guard allows the selected session and denies a moved session", async () => {
  const dir = tempMemoryDir();
  const workspaces = [
    { id: "ws-a", title: "A", sessionIds: ["s1"] },
    { id: "ws-b", title: "B", sessionIds: [] }
  ];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const { createWorkspaceAccessGuard } = await import("../src/workspace-binding.js");
  const guard = createWorkspaceAccessGuard({ memoryDir: dir, activeWorkspaceId: "ws-a", ctx });

  assert.deepEqual(guard.authorize({ id: "s1" }), { allowed: true, reason: "ok", workspaceId: "ws-a" });

  workspaces[0].sessionIds = [];
  workspaces[1].sessionIds = ["s1"];
  assert.deepEqual(guard.authorize({ id: "s1" }), { allowed: false, reason: "workspace-mismatch", workspaceId: null });
});

test("workspace-runtime: binding change denies the old runtime immediately and stays denied until remount", async () => {
  const dir = tempMemoryDir();
  const workspaces = [
    { id: "ws-a", title: "A", sessionIds: ["s1"] },
    { id: "ws-b", title: "B", sessionIds: [] }
  ];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const { createWorkspaceAccessGuard } = await import("../src/workspace-binding.js");
  const guard = createWorkspaceAccessGuard({ memoryDir: dir, activeWorkspaceId: "ws-a", ctx });
  assert.equal(guard.authorize({ id: "s1" }).allowed, true);

  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-b", ctx }).ok, true);
  assert.deepEqual(guard.authorize({ id: "s1" }), {
    allowed: false,
    reason: "binding-changed-pending-remount",
    workspaceId: null
  });

  // Changing the file back does not revive the already-mounted store.
  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-a", ctx }).ok, true);
  assert.equal(guard.authorize({ id: "s1" }).reason, "binding-changed-pending-remount");
});

test("workspace-runtime: every registered tool is denied before touching the service", async () => {
  const dir = tempMemoryDir();
  const ctx = registryCtx([{ id: "ws-a", title: "A", sessionIds: ["s1"] }]);
  select(dir, "ws-a", ctx);
  const { createWorkspaceAccessGuard } = await import("../src/workspace-binding.js");
  const guard = createWorkspaceAccessGuard({ memoryDir: dir, activeWorkspaceId: "ws-a", ctx });

  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const registered = [];
  const toolCtx = {
    tools: { register(def) { registered.push(def); return () => {}; } },
    logger: { warn() {}, info() {} }
  };
  createTools(toolCtx, service, {}, undefined, guard.authorize);

  const list = registered.find((tool) => tool.name === "memory_list");
  const get = registered.find((tool) => tool.name === "memory_get");
  assert.ok(list && get);

  await assert.rejects(
    list.execute({ limit: 5 }, { agent: { session: { id: "s2" } } }),
    /WORKSPACE_ACCESS_DENIED: session-not-found/
  );
  await assert.rejects(
    get.execute({ id: "missing" }, { agent: { session: { id: "s2" } } }),
    /WORKSPACE_ACCESS_DENIED/
  );
  assert.equal(service.count(), 0);

  const authorized = await list.execute({ limit: 5 }, { agent: { session: { id: "s1" } } });
  assert.equal(authorized.items.length, 0);
  store.close();
});

test("workspace-runtime: unauthorized injection returns nothing and performs no retrieval", async () => {
  const dir = tempMemoryDir();
  const workspaces = [
    { id: "ws-a", title: "A", sessionIds: ["s1"] },
    { id: "ws-b", title: "B", sessionIds: [] }
  ];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const { createWorkspaceAccessGuard } = await import("../src/workspace-binding.js");
  const guard = createWorkspaceAccessGuard({ memoryDir: dir, activeWorkspaceId: "ws-a", ctx });

  let retrievals = 0;
  const service = {
    injectCandidates() { retrievals += 1; return []; },
    embedQuery: async () => null,
    hasSceneScopedRows: () => false
  };
  const contexts = {};
  const injectorCtx = {
    ...ctx,
    logger: { warn() {} },
    systemPrompt: {
      context(spec) { contexts[spec.name] = spec.text; return () => {}; }
    }
  };
  const config = {
    hotMemoryEnabled: false,
    maxInjectedItems: 5,
    importanceThreshold: 3,
    injectRotationTurns: 0
  };
  const dispose = createInjector(injectorCtx, service, {}, config, null, guard.authorize);
  try {
    assert.equal(contexts.memory({ agent: { session: { id: "s2" } } }), "");
    assert.equal(retrievals, 0, "an unauthorized session must not reach retrieval or Hot Memory");

    assert.equal(contexts.memory({ agent: { session: { id: "s1" } } }), "");
    assert.equal(retrievals, 1, "an authorized session runs the injector path");

    workspaces[0].sessionIds = [];
    workspaces[1].sessionIds = ["s1"];
    assert.equal(contexts.memory({ agent: { session: { id: "s1" } } }), "");
    assert.equal(retrievals, 1, "a moved session performs no further retrieval");
  } finally {
    dispose();
  }
});

function summaryService() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return { store, service };
}

function summaryConfig() {
  return {
    autoSummarize: true,
    summarizeProvider: "provider",
    summarizeModel: "model",
    summarizeMinIntervalMinutes: 0,
    summarizeMaxRunsPerSession: 0,
    summarizePeakHours: "",
    summarizeMinWindowChars: 0,
    distillRateLimitIntervalMs: 0,
    llmAudit: { enabled: false }
  };
}

function summarySession(id = "s1") {
  const events = [userMessage("this window should produce one decision", 1), { seq: 2, type: "turn/end" }];
  return session(id, events);
}

test("workspace-runtime: autoSummarize event is denied for an unauthorized session", async () => {
  const dir = tempMemoryDir();
  const ctx = registryCtx([{ id: "ws-a", title: "A", sessionIds: ["s1"] }]);
  select(dir, "ws-a", ctx);
  const { createWorkspaceAccessGuard } = await import("../src/workspace-binding.js");
  const guard = createWorkspaceAccessGuard({ memoryDir: dir, activeWorkspaceId: "ws-a", ctx });

  const { store, service } = summaryService();
  let llmCalls = 0;
  const listeners = {};
  const summarizerCtx = {
    logger: { warn() {} },
    on(name, fn) { listeners[name] = fn; return () => {}; },
    llm: {
      stream() {
        llmCalls += 1;
        return (async function* () {
          yield { type: "text-delta", delta: "[]" };
          yield { type: "finish", kind: "ok" };
        })();
      }
    }
  };
  const summarizer = createSummarizer(summarizerCtx, service, summaryConfig(), { authorizeModelWork: guard.authorize });
  try {
    await listeners["session/event"](summarySession("s2"), { seq: 2, type: "turn/end" });
    assert.equal(llmCalls, 0);
    assert.equal(service.count(), 0);
  } finally {
    summarizer.dispose();
    store.close();
  }
});

test("workspace-runtime: mid-flight binding switch blocks the summary transaction after async LLM work", async () => {
  const dir = tempMemoryDir();
  const workspaces = [
    { id: "ws-a", title: "A", sessionIds: ["s1"] },
    { id: "ws-b", title: "B", sessionIds: [] }
  ];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const { createWorkspaceAccessGuard } = await import("../src/workspace-binding.js");
  const guard = createWorkspaceAccessGuard({ memoryDir: dir, activeWorkspaceId: "ws-a", ctx });

  const { store, service } = summaryService();
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  let llmCalls = 0;
  const listeners = {};
  const summarizerCtx = {
    logger: { warn() {} },
    on(name, fn) { listeners[name] = fn; return () => {}; },
    llm: {
      stream() {
        llmCalls += 1;
        return (async function* () {
          started();
          await hold;
          yield { type: "text-delta", delta: JSON.stringify([{ type: "decision", title: "t", content: "c", importance: 4 }]) };
          yield { type: "finish", kind: "ok" };
        })();
      }
    }
  };
  const summarizer = createSummarizer(summarizerCtx, service, summaryConfig(), { authorizeModelWork: guard.authorize });
  try {
    const run = listeners["session/event"](summarySession(), { seq: 2, type: "turn/end" });
    await startedPromise;

    // The LLM is still running; the operator selects another Workspace. The old
    // runtime must not commit the window it already collected.
    assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-b", ctx }).ok, true);
    release();
    await run;

    assert.equal(llmCalls, 1, "the LLM work did start before the switch");
    assert.equal(service.count(), 0, "no memory may be written after a mid-flight binding switch");
    assert.equal(service.getDistillCursor?.("s1"), undefined, "the cursor must not advance");
  } finally {
    summarizer.dispose();
    store.close();
  }
});

test("workspace-runtime: scoped config overrides memoryDir and rejects a global documentDir value", () => {
  const scoped = mneme.createScopedRuntimeConfig(
    { memoryDir: "control", documentDir: "C:\\global\\documents", keep: 7 },
    { memoryDir: "C:\\runtime\\workspaces\\digest", documentDir: "" }
  );
  assert.equal(scoped.memoryDir, "C:\\runtime\\workspaces\\digest");
  assert.equal(scoped.documentDir, "");
  assert.equal(scoped.keep, 7);
});

test("workspace-runtime: full plugin boot opens the selected isolated DB and wires the access guard", async () => {
  const dir = tempMemoryDir();
  const workspaces = [
    { id: "ws-a", title: "A", sessionIds: ["s1"] },
    { id: "ws-b", title: "B", sessionIds: [] }
  ];
  const registry = { list: () => workspaces };
  const plainCtx = { workspaceRegistry: registry };
  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-a", ctx: plainCtx }).ok, true);

  const registered = [];
  const ctx = new Context();
  ctx.provide("tools", { register(def) { registered.push(def); return () => {}; } });
  ctx.provide("commands", { register() { return () => {}; } });
  ctx.provide("systemPrompt", { context() { return () => {}; }, section() { return () => {}; } });
  ctx.provide("agentDefaultModel", { currentSelection() { return { provider: "mock", model: "mock" }; } });
  ctx.provide("llm", { async *stream() { yield { type: "finish", reason: { kind: "stop" } }; } });
  ctx.provide("webServer", { register() { return () => {}; } });
  ctx.provide("workspaceRegistry", registry);
  ctx.provide("connection", { admit() { return { peer: { principal: { kind: "owner" } } }; } });

  const fiber = ctx.plugin(mneme, { memoryDir: dir, lightMode: true });
  await fiber;
  try {
    assert.equal(existsSync(join(dir, "memory.db")), false, "full boot must not create the control-root DB");
    assert.equal(existsSync(join(dir, "unbound")), false, "a selected binding must not use unbound storage");
    assert.equal(existsSync(join(workspaceDataDirFor(dir, "ws-a"), "memory.db")), true);

    const list = registered.find((tool) => tool.name === "memory_list");
    assert.ok(list, "full boot registered memory_list");
    await assert.rejects(
      list.execute({ limit: 5 }, { agent: { session: { id: "s2" } } }),
      /WORKSPACE_ACCESS_DENIED/
    );
    const authorized = await list.execute({ limit: 5 }, { agent: { session: { id: "s1" } } });
    assert.equal(authorized.items.length, 0);

    // A binding change while the old runtime is mounted denies the same tool
    // immediately; it does not need a new Workspace to already contain s1.
    workspaces[1].sessionIds = ["s1"];
    assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-b", ctx: plainCtx }).ok, true);
    await assert.rejects(
      list.execute({ limit: 5 }, { agent: { session: { id: "s1" } } }),
      /binding-changed-pending-remount/
    );
  } finally {
    await fiber.dispose();
  }
});
