import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import * as mneme from "../src/index.js";
import { createTools } from "../src/tools.js";
import { createInjector } from "../src/inject.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import {
  createWorkspaceAccessGuard,
  initializeWorkspaceDataDir,
  setWorkspaceBinding,
  workspaceDataDirFor
} from "../src/workspace-binding.js";
import { createQQModelAccessGate } from "../src/qq-model-boundary.js";

// Runtime wiring for the reviewed standalone recent-activity core. These tests
// use an isolated temporary store and a fake `session/event` bus; no live DSH
// Desktop host, installed package, profile or production database is touched.

const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;
const tempDirs = [];

function tempMemoryDir() {
  const dir = mkdtempSync(join(tmpdir(), "mneme-recent-runtime-"));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function baseWorkspaces() {
  return [
    { id: "ws-a", title: "A", sessionIds: ["s1", "s2", "s3", "owner-1"] },
    { id: "ws-b", title: "B", sessionIds: ["b1"] }
  ];
}

function registryCtx(workspaces) {
  return {
    workspaceRegistry: { list: () => workspaces },
    logger: { warn() {}, info() {} }
  };
}

function selectedFixture({ workspaces = baseWorkspaces(), workspaceId = "ws-a" } = {}) {
  const dir = tempMemoryDir();
  const ctx = registryCtx(workspaces);
  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId, ctx }).ok, true);
  assert.equal(initializeWorkspaceDataDir(dir).ok, true);
  const store = createStore(join(workspaceDataDirFor(dir, workspaceId), "memory.db"));
  const guard = createWorkspaceAccessGuard({
    memoryDir: dir,
    activeWorkspaceId: workspaceId,
    ctx
  });
  return { dir, ctx, workspaces, store, guard };
}

function fakeHost() {
  const listeners = new Set();
  // Synthetic live Session Store. Tests may replace an entry by emitting a
  // richer Session; the default identities stand in for the Host-owned header.
  const presets = { q1: "amadeus-qq" };
  const liveSessions = new Map(
    ["s1", "s2", "s3", "owner-1", "b1", "q1"].map((id) => [
      id,
      {
        id,
        header: { agentPreset: presets[id] ?? "standard" },
        events: [],
        snapshotEvents() { return []; }
      }
    ])
  );
  return {
    logger: { warn() {}, info() {} },
    sessions: {
      get(id) { return liveSessions.get(id) ?? null; }
    },
    on(name, fn) {
      if (name !== "session/event") throw new Error(`unexpected event: ${name}`);
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(session, event) {
      if (session?.id) liveSessions.set(session.id, session);
      for (const fn of [...listeners]) fn(session, event);
    },
    async emitParallel(session, event) {
      await Promise.all([...listeners].map((fn) => fn(session, event)));
    },
    listenerCount() {
      return listeners.size;
    }
  };
}

function hostSession(id, events = []) {
  return {
    id,
    events,
    snapshotEvents() { return this.events; }
  };
}

function userMessage(seq, text) {
  return {
    seq,
    type: "user/message",
    data: { source: { kind: "user" }, content: [{ type: "text", text }] }
  };
}

function assistantMessage(seq, text) {
  return {
    seq,
    type: "assistant/message",
    data: { message: { role: "assistant", content: [{ type: "text", text }] } }
  };
}

function turnEnd(seq) {
  return { seq, type: "turn/end", data: {} };
}

function turnBlock(startSeq, topic) {
  return [
    userMessage(startSeq, `${topic} user request`),
    assistantMessage(startSeq + 1, `${topic} assistant reply`),
    turnEnd(startSeq + 2)
  ];
}

function countEvents(db, workspaceId = "ws-a") {
  return Number(db.prepare(
    "SELECT COUNT(*) AS count FROM recent_activity_events WHERE workspace_id = ?"
  ).get(workspaceId)?.count ?? 0);
}

function injectionHarness(core, guard, config = {}) {
  const contexts = {};
  const ctx = {
    logger: { warn() {} },
    systemPrompt: {
      context(spec) {
        contexts[spec.name] = spec.text;
        return () => {};
      },
      section() { return () => {}; }
    }
  };
  const service = {
    injectCandidates: () => [],
    embedQuery: async () => null,
    hasSceneScopedRows: () => false
  };
  const dispose = createInjector(ctx, service, {}, {
    hotMemoryEnabled: false,
    maxInjectedItems: 5,
    importanceThreshold: 3,
    injectRotationTurns: 0,
    recentActivityEnabled: true,
    ...config
  }, null, guard.authorize, core);
  return { contexts, dispose };
}

function toolHarness(core, guard, store, config = { recentActivityEnabled: true }) {
  const registered = [];
  const toolCtx = {
    tools: { register(def) { registered.push(def); return () => {}; } },
    logger: { warn() {}, info() {} }
  };
  const service = createService({ store, mirror: null, config: {} });
  createTools(toolCtx, service, config, undefined, guard.authorize, core);
  return {
    registered,
    service,
    tool: registered.find((tool) => tool.name === "memory_recent_activity")
  };
}

function requireTool(harness) {
  assert.ok(harness.tool, "memory_recent_activity is registered when the core is mounted");
  return harness.tool;
}

function qqCtx(resolve) {
  return {
    reflect: {
      get(name) {
        if (name !== "qq") return undefined;
        return { resolveTrustedSessionScene: resolve };
      }
    }
  };
}

test("recent-runtime: selected Session records only trusted turn/end and the listener is disposed", () => {
  const fixture = selectedFixture();
  const host = fakeHost();
  const runtime = mneme.createRecentActivityRuntime({
    ctx: host,
    db: fixture.store.db,
    workspaceId: "ws-a",
    authorizeModelWork: fixture.guard.authorize,
    now: () => T0
  });
  try {
    assert.ok(runtime.core, "the core mounts over the selected store DB");
    assert.equal(host.listenerCount(), 1, "one trusted session/event listener is registered");

    const s1 = hostSession("s1", turnBlock(1, "alpha"));
    host.emit(s1, turnEnd(3));
    assert.equal(countEvents(fixture.store.db), 1);

    // Only turn/end reaches the core; other events must not create rows.
    host.emit(s1, { seq: 4, type: "turn/start", data: {} });
    host.emit(s1, userMessage(5, "not a turn end"));
    assert.equal(countEvents(fixture.store.db), 1);

    // A throwing authorization callback must never escape into Mneme's chain.
    const throwing = mneme.createRecentActivityRuntime({
      ctx: fakeHost(),
      db: fixture.store.db,
      workspaceId: "ws-a",
      authorizeModelWork: () => { throw new Error("guard boom"); },
      now: () => T0
    });
    assert.doesNotThrow(() => throwing.onSessionEvent(s1, turnEnd(3)));
    throwing.dispose();

    runtime.dispose();
    assert.equal(host.listenerCount(), 0, "unload removes the listener");
    host.emit(hostSession("s1", turnBlock(6, "beta")), turnEnd(9));
    assert.equal(countEvents(fixture.store.db), 1, "no recording after dispose");
  } finally {
    runtime.dispose();
    fixture.store.close();
  }
});

test("recent-runtime: injection/tool reveal another Session only after an explicit shared policy", async () => {
  const fixture = selectedFixture();
  const host = fakeHost();
  const runtime = mneme.createRecentActivityRuntime({
    ctx: host,
    db: fixture.store.db,
    workspaceId: "ws-a",
    authorizeModelWork: fixture.guard.authorize,
    now: () => T0
  });
  const injection = injectionHarness(runtime.core, fixture.guard, {});
  const tools = toolHarness(runtime.core, fixture.guard, fixture.store);
  try {
    const tool = requireTool(tools);
    const s1 = hostSession("s1", turnBlock(1, "shared project"));
    host.emit(s1, turnEnd(3));
    assert.equal(countEvents(fixture.store.db), 1);

    const s2 = hostSession("s2");
    // Default `self` policy: no cross-Session content, but the target itself is
    // still a valid query and returns an empty safe DTO rather than an error.
    assert.equal(injection.contexts["recent-activity"]({ agent: { session: s2 } }), "");
    const hidden = await tool.execute({}, { agent: { session: s2 } });
    assert.equal(hidden.ok, true);
    assert.equal(hidden.count, 0);
    assert.deepEqual(hidden.items, []);

    // Explicit sharing: both the separate prompt block and the tool see it.
    const policy = runtime.core.setSourcePolicy(s1, { mode: "shared", sharedSessionIds: ["s2"] }, { now: T0 });
    assert.equal(policy.ok, true);
    const block = injection.contexts["recent-activity"]({ agent: { session: s2 } });
    assert.match(block, /Past workspace activity/);
    assert.match(block, /untrusted observations/);
    assert.match(block, /shared project user request/);
    const visible = await tool.execute({ sources: ["s1"] }, { agent: { session: s2 } });
    assert.equal(visible.ok, true);
    assert.equal(visible.count, 1);
    assert.equal(visible.items[0].sourceSessionId, "s1");
    assert.deepEqual(
      Object.keys(visible).sort(),
      ["count", "estimatedTokens", "items", "ok", "reason", "truncated"]
    );
    assert.deepEqual(
      Object.keys(visible.items[0]).sort(),
      ["estimatedTokens", "kind", "occurredAt", "sourceSessionId", "summary"]
    );

    // A Session in another Workspace is denied before reading anything.
    const b1 = hostSession("b1");
    assert.equal(injection.contexts["recent-activity"]({ agent: { session: b1 } }), "");
    await assert.rejects(
      tool.execute({ sources: ["s1"] }, { agent: { session: b1 } }),
      /WORKSPACE_ACCESS_DENIED/
    );

    // Model-supplied source IDs only narrow; they never become the target.
    const narrowedAway = await tool.execute({ sources: ["b1"] }, { agent: { session: s2 } });
    assert.equal(narrowedAway.ok, true);
    assert.equal(narrowedAway.count, 0, "a non-visible source cannot be selected");
  } finally {
    injection.dispose();
    runtime.dispose();
    fixture.store.close();
  }
});

test("recent-runtime: live Session Store supplies full identity while QQ remains isolated", () => {
  const fixture = selectedFixture();
  const host = fakeHost();
  host.qq = {
    resolveTrustedSessionScene(id) {
      return id === "q1"
        ? { platform: "qq", botId: "10001", kind: "group", peerId: "20001" }
        : null;
    }
  };
  const allowSession = createQQModelAccessGate({
    ctx: host,
    config: { sceneIsolationEnabled: false, sceneStrictQQ: false },
    authorizeWorkspace: fixture.guard.authorize
  });
  const runtime = mneme.createRecentActivityRuntime({
    ctx: host,
    db: fixture.store.db,
    workspaceId: "ws-a",
    authorizeModelWork: allowSession,
    now: () => T0
  });
  try {
    const s1 = { ...hostSession("s1", turnBlock(1, "runtime sharing")), header: { agentPreset: "standard" } };
    host.emit(s1, turnEnd(3));
    assert.equal(countEvents(fixture.store.db), 1);

    // The runtime derived resolveTrustedSession from ctx.sessions, so the
    // ordinary target's frozen header reaches the QQ boundary even though the
    // stored grant is written by ID.
    assert.equal(
      runtime.core.setSourcePolicy(s1, { mode: "shared", sharedSessionIds: ["s2"] }, { now: T0 }).ok,
      true
    );
    const visible = runtime.core.readRecentActivity({ id: "s2" }, { now: T0 + 1 });
    assert.equal(visible.ok, true);
    assert.equal(visible.count, 1);

    assert.equal(
      runtime.core.setSourcePolicy(s1, { mode: "shared", sharedSessionIds: ["q1"] }, { now: T0 }).ok,
      false,
      "the same runtime denies a QQ target in default Scene mode"
    );
  } finally {
    runtime.dispose();
    fixture.store.close();
  }
});

test("recent-runtime: model tool ignores now/owner/workspaceId/policy fields", async () => {
  const fixture = selectedFixture();
  const host = fakeHost();
  const runtime = mneme.createRecentActivityRuntime({
    ctx: host,
    db: fixture.store.db,
    workspaceId: "ws-a",
    authorizeModelWork: fixture.guard.authorize,
    now: () => T0
  });
  const tools = toolHarness(runtime.core, fixture.guard, fixture.store);
  try {
    const tool = requireTool(tools);
    const s1 = hostSession("s1", turnBlock(1, "field filtering"));
    host.emit(s1, turnEnd(3));
    assert.equal(
      runtime.core.setSourcePolicy(s1, { mode: "shared", sharedSessionIds: ["s2"] }, { now: T0 }).ok,
      true
    );

    const result = await tool.execute({
      sources: ["s1"],
      now: T0 + 100 * HOUR,
      owner: true,
      workspaceId: "ws-b",
      mode: "shared",
      policy: { mode: "owner" }
    }, { agent: { session: hostSession("s2") } });
    assert.equal(result.ok, true);
    assert.equal(result.count, 1, "a future `now` and forged policy fields are ignored");
    assert.match(result.items[0].summary, /field filtering/);
  } finally {
    runtime.dispose();
    fixture.store.close();
  }
});

test("recent-runtime: injection uses the core item/token limits and never duplicates self", () => {
  const fixture = selectedFixture();
  const host = fakeHost();
  const runtime = mneme.createRecentActivityRuntime({
    ctx: host,
    db: fixture.store.db,
    workspaceId: "ws-a",
    authorizeModelWork: fixture.guard.authorize,
    config: { maxItems: 1, maxTokens: 300 },
    now: () => T0
  });
  const injection = injectionHarness(runtime.core, fixture.guard, {});
  try {
    const s1 = hostSession("s1", [...turnBlock(1, "first"), ...turnBlock(4, "second")]);
    host.emit(s1, turnEnd(3));
    host.emit(s1, turnEnd(6));
    assert.equal(countEvents(fixture.store.db), 2);
    assert.equal(
      runtime.core.setSourcePolicy(s1, { mode: "shared", sharedSessionIds: ["s2"] }, { now: T0 }).ok,
      true
    );

    const block = injection.contexts["recent-activity"]({ agent: { session: s2Session() } });
    assert.match(block, /second user request/);
    assert.doesNotMatch(block, /first user request/, "maxItems from the core is respected");
    assert.equal(
      injection.contexts["recent-activity"]({ agent: { session: s1 } }),
      "",
      "includeSelf:false keeps the original Hot Memory from being duplicated"
    );
  } finally {
    injection.dispose();
    runtime.dispose();
    fixture.store.close();
  }
});

function s2Session() {
  return hostSession("s2");
}

test("recent-runtime: moved Session and binding switch deny recording, injection and tool data immediately", async () => {
  const fixture = selectedFixture();
  const host = fakeHost();
  const runtime = mneme.createRecentActivityRuntime({
    ctx: host,
    db: fixture.store.db,
    workspaceId: "ws-a",
    authorizeModelWork: fixture.guard.authorize,
    now: () => T0
  });
  const injection = injectionHarness(runtime.core, fixture.guard, {});
  const tools = toolHarness(runtime.core, fixture.guard, fixture.store);
  try {
    const tool = requireTool(tools);
    const s1 = hostSession("s1", [...turnBlock(1, "before move"), ...turnBlock(4, "after move")]);
    host.emit(s1, turnEnd(3));
    assert.equal(countEvents(fixture.store.db), 1);

    // Move s1 out of the selected Workspace: the listener and both surfaces deny.
    fixture.workspaces[0].sessionIds = fixture.workspaces[0].sessionIds.filter((id) => id !== "s1");
    fixture.workspaces[1].sessionIds.push("s1");
    host.emit(s1, turnEnd(6));
    assert.equal(countEvents(fixture.store.db), 1, "a moved Session records nothing");
    assert.equal(injection.contexts["recent-activity"]({ agent: { session: s1 } }), "");
    await assert.rejects(
      tool.execute({ sources: ["s1"] }, { agent: { session: s1 } }),
      /WORKSPACE_ACCESS_DENIED/
    );

    // Move back, then switch the binding: the mounted runtime is stale at once.
    fixture.workspaces[0].sessionIds.push("s1");
    fixture.workspaces[1].sessionIds = fixture.workspaces[1].sessionIds.filter((id) => id !== "s1");
    assert.equal(
      setWorkspaceBinding({ memoryDir: fixture.dir, workspaceId: "ws-b", ctx: fixture.ctx }).ok,
      true
    );
    host.emit(s1, turnEnd(6));
    assert.equal(countEvents(fixture.store.db), 1, "a binding switch records nothing");
    assert.equal(injection.contexts["recent-activity"]({ agent: { session: s1 } }), "");
    await assert.rejects(
      tool.execute({ sources: ["s1"] }, { agent: { session: s1 } }),
      /binding-changed-pending-remount/
    );
  } finally {
    injection.dispose();
    runtime.dispose();
    fixture.store.close();
  }
});

test("recent-runtime: owner predicate accepts only the exact optional QQ Host scene", () => {
  const scenes = new Map([
    ["owner-1", { platform: "qq", kind: "private", verified: true, admin: true }],
    ["s2", { platform: "qq", kind: "private", verified: true, admin: true }],
    ["s3", { platform: "qq", kind: "group", verified: true, admin: true }]
  ]);
  const genuine = mneme.createRecentActivityOwnerCheck(qqCtx((id) => scenes.get(id) ?? null));
  assert.equal(mneme.createRecentActivityOwnerCheck(qqCtx(() => ({
    platform: "qq", kind: "private", admin: true
  })))({ id: "owner-1" }), false, "Host scene must explicitly be verified");
  assert.equal(genuine({ id: "owner-1" }), true);
  assert.equal(genuine({ id: "s2" }), true);
  assert.equal(genuine({ id: "s3" }), false, "a non-private scene is not owner");
  assert.equal(genuine({ id: "unknown" }), false);

  const forged = mneme.createRecentActivityOwnerCheck(qqCtx(() => null));
  assert.equal(forged({
    id: "s2",
    name: "Owner",
    title: "Owner private",
    header: { agentPreset: "amadeus-qq-owner" }
  }), false, "titles/presets/names are never owner evidence");

  const wrongAdmin = mneme.createRecentActivityOwnerCheck(qqCtx(() => ({
    platform: "qq", kind: "private", admin: false
  })));
  assert.equal(wrongAdmin({ id: "s2" }), false);

  const wrongPlatform = mneme.createRecentActivityOwnerCheck(qqCtx(() => ({
    platform: "discord", kind: "private", admin: true
  })));
  assert.equal(wrongPlatform({ id: "s2" }), false);

  assert.equal(mneme.createRecentActivityOwnerCheck({})({ id: "s2" }), false, "QQ is optional");
  const throwing = mneme.createRecentActivityOwnerCheck({
    reflect: { get() { throw new Error("no such service"); } }
  });
  assert.equal(throwing({ id: "s2" }), false, "service failures default false");
  const throwingResolve = mneme.createRecentActivityOwnerCheck(qqCtx(() => {
    throw new Error("host failure");
  }));
  assert.equal(throwingResolve({ id: "s2" }), false);
});

test("recent-runtime: owner policy reads only Sessions the Host confirms as owner", () => {
  const fixture = selectedFixture();
  const host = fakeHost();
  const scenes = new Map([
    ["owner-1", { platform: "qq", kind: "private", verified: true, admin: true }],
    ["s2", { platform: "qq", kind: "private", verified: true, admin: true }]
  ]);
  const runtime = mneme.createRecentActivityRuntime({
    ctx: host,
    db: fixture.store.db,
    workspaceId: "ws-a",
    authorizeModelWork: fixture.guard.authorize,
    isTrustedOwner: mneme.createRecentActivityOwnerCheck(qqCtx((id) => scenes.get(id) ?? null)),
    now: () => T0
  });
  try {
    const owner = hostSession("owner-1", turnBlock(1, "owner private work"));
    host.emit(owner, turnEnd(3));
    assert.equal(
      runtime.core.setSourcePolicy(owner, { mode: "owner" }, { now: T0 }).ok,
      true
    );

    const trustedTarget = runtime.core.readRecentActivity(hostSession("s2"), { now: T0 + 1 });
    assert.equal(trustedTarget.ok, true);
    assert.equal(trustedTarget.count, 1);
    assert.match(trustedTarget.items[0].summary, /owner private work/);

    const untrustedTarget = runtime.core.readRecentActivity(hostSession("s3"), { now: T0 + 1 });
    assert.equal(untrustedTarget.ok, true);
    assert.equal(untrustedTarget.count, 0, "a Session without the Host owner scene sees nothing");
  } finally {
    runtime.dispose();
    fixture.store.close();
  }
});

test("recent-runtime: disabled flag has no extra hook, injection block or tool", () => {
  const fixture = selectedFixture();
  try {
    const tools = toolHarness(null, fixture.guard, fixture.store);
    assert.equal(
      tools.registered.some((tool) => tool.name === "memory_recent_activity"),
      false,
      "no tool without the core"
    );
    const injection = injectionHarness(null, fixture.guard, {});
    assert.equal(injection.contexts["recent-activity"], undefined, "no block without the core");
    injection.dispose();

    // A mounted core is still not enough by itself: the opt-in flag must be on.
    const host = fakeHost();
    const runtime = mneme.createRecentActivityRuntime({
      ctx: host,
      db: fixture.store.db,
      workspaceId: "ws-a",
      authorizeModelWork: fixture.guard.authorize
    });
    try {
      assert.equal(runtime.core.status().ok, true);
      const coreButDisabled = toolHarness(runtime.core, fixture.guard, fixture.store, {
        recentActivityEnabled: false
      });
      assert.equal(
        coreButDisabled.registered.some((tool) => tool.name === "memory_recent_activity"),
        false,
        "the flag is required even if a core is passed"
      );
    } finally {
      runtime.dispose();
    }

    const indexSource = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
    assert.match(indexSource, /activeWorkspaceId && runtimeCfg\.recentActivityEnabled === true/);
    assert.match(indexSource, /createRecentActivityRuntime\(\{/);
  } finally {
    fixture.store.close();
  }
});

test("recent-runtime: original Hot Memory block is unchanged when the recent block is separate", () => {
  const fixture = selectedFixture();
  const s1 = hostSession("s1", [...turnBlock(1, "hot memory topic")]);
  const config = {
    hotMemoryEnabled: true,
    hotMemoryRounds: 5,
    hotMemoryMaxTokens: 2000,
    maxInjectedItems: 5,
    importanceThreshold: 3,
    injectRotationTurns: 0,
    recentActivityEnabled: true
  };
  const without = injectionHarness(null, fixture.guard, config);
  const host = fakeHost();
  const runtime = mneme.createRecentActivityRuntime({
    ctx: host,
    db: fixture.store.db,
    workspaceId: "ws-a",
    authorizeModelWork: fixture.guard.authorize,
    now: () => T0
  });
  const withRecent = injectionHarness(runtime.core, fixture.guard, config);
  try {
    const baseline = without.contexts.memory({ agent: { session: s1 } });
    const current = withRecent.contexts.memory({ agent: { session: s1 } });
    assert.equal(current, baseline, "the memory block is byte-identical with/without the core");
    assert.match(current, /hot memory topic user request/);
    assert.doesNotMatch(current, /Past workspace activity/);
  } finally {
    without.dispose();
    withRecent.dispose();
    runtime.dispose();
    fixture.store.close();
  }
});

test("recent-runtime: the recent-activity module has no QQ dependency", () => {
  const source = readFileSync(new URL("../src/recent-activity.js", import.meta.url), "utf8");
  assert.equal(/resolveTrustedSessionScene/.test(source), false);
  assert.equal(/\bqq\b/i.test(source), false);
  assert.equal(typeof mneme.createRecentActivityRuntime, "function");
  assert.equal(typeof mneme.createRecentActivityOwnerCheck, "function");
});

test("recent-runtime: full boot registers the surfaces only when the opt-in flag is on", async () => {
  const dir = tempMemoryDir();
  const workspaces = [{ id: "ws-a", title: "A", sessionIds: ["s1", "s2"] }];
  const registry = { list: () => workspaces };
  assert.equal(
    setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-a", ctx: { workspaceRegistry: registry } }).ok,
    true
  );

  async function boot(flag) {
    const registered = [];
    const contexts = {};
    const ctx = new Context();
    ctx.provide("tools", { register(def) { registered.push(def); return () => {}; } });
    ctx.provide("commands", { register() { return () => {}; } });
    // The Host Session Store is the trusted identity source for recent
    // activity's cross-Session reauthorization.
    ctx.provide("sessions", {
      get(id) {
        return typeof id === "string" && id !== ""
          ? { id, header: { agentPreset: "standard" }, events: [], snapshotEvents() { return []; } }
          : null;
      }
    });
    ctx.provide("systemPrompt", {
      context(spec) { contexts[spec.name] = spec.text; return () => {}; },
      section() { return () => {}; }
    });
    ctx.provide("agentDefaultModel", { currentSelection() { return { provider: "mock", model: "mock" }; } });
    ctx.provide("llm", { async *stream() { yield { type: "finish", reason: { kind: "stop" } }; } });
    ctx.provide("webServer", { register() { return () => {}; } });
    ctx.provide("workspaceRegistry", registry);
    ctx.provide("connection", { admit() { return { peer: { principal: { kind: "owner" } } }; } });
    const fiber = ctx.plugin(mneme, {
      memoryDir: dir,
      recentActivityEnabled: flag,
      autoDream: false,
      autoSummarize: false,
      sleepModeEnabled: false,
      entityExtractionEnabled: false,
      autoReindexOnBoot: false,
      actionRunEnabled: false,
      actionNudgeEnabled: false,
      continuityRescueEnabled: false,
      autoInject: true
    });
    await fiber;
    return { ctx, registered, contexts, fiber };
  }

  const off = await boot(false);
  try {
    assert.equal(off.registered.some((tool) => tool.name === "memory_recent_activity"), false);
    assert.equal(off.contexts["recent-activity"], undefined);
  } finally {
    await off.fiber.dispose();
  }

  const on = await boot(true);
  try {
    const tool = on.registered.find((entry) => entry.name === "memory_recent_activity");
    assert.ok(tool, "the full runtime registers the read-only tool when enabled");
    assert.equal(typeof on.contexts["recent-activity"], "function");

    const s1 = hostSession("s1", turnBlock(1, "full boot topic"));
    await on.ctx.parallel("session/event", s1, turnEnd(3));

    const result = await tool.execute({ limit: 5 }, { agent: { session: s1 } });
    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    assert.match(result.items[0].summary, /full boot topic/);

    // No explicit sharing policy: another Session gets no block content.
    assert.equal(on.contexts["recent-activity"]({ agent: { session: hostSession("s2") } }), "");
  } finally {
    await on.fiber.dispose();
  }
});
