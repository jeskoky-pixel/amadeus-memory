import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWorkspaceAccess } from "../src/workspace-gate.js";
import { createWorkspaceAccessGuard, setWorkspaceBinding } from "../src/workspace-binding.js";
import {
  createQQModelAccessGate,
  evaluateQQModelBoundary,
  ORDINARY_DSH_PRESETS
} from "../src/qq-model-boundary.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createInjector } from "../src/inject.js";
import { createTools } from "../src/tools.js";
import { createSummarizer } from "../src/summarize.js";

const QQ_GROUP = Object.freeze({
  platform: "qq",
  kind: "group",
  id: "bot:group",
  verified: true
});

function makeContext({ qq = undefined, sessions = ["s1"], workspaceId = "ws-1" } = {}) {
  const state = { qq };
  const workspaces = [{ id: workspaceId, title: "Workspace", sessionIds: [...sessions] }];
  const registry = { list: () => workspaces };
  const ctx = { workspaceRegistry: registry };
  Object.defineProperty(ctx, "qq", {
    configurable: true,
    get: () => state.qq
  });
  return {
    ctx,
    registry,
    workspaces,
    setQQ(value) { state.qq = value; }
  };
}

function session(id = "s1", preset = "standard") {
  return { id, header: { agentPreset: preset } };
}

function gateFor(ctx, config, selectedWorkspaceId = "ws-1") {
  return createQQModelAccessGate({
    ctx,
    config,
    authorizeWorkspace: (trustedSession) =>
      checkWorkspaceAccess(trustedSession, selectedWorkspaceId, ctx)
  });
}

test("known amadeus-qq presets fail closed without a Host in default Scene mode", () => {
  const { ctx } = makeContext();
  const gate = gateFor(ctx, { sceneIsolationEnabled: false, sceneStrictQQ: false });

  for (const preset of [
    "amadeus-qq",
    "amadeus-qq-search",
    "amadeus-qq-media",
    "amadeus-qq-media-search",
    "amadeus-qq-owner",
    "amadeus-qq-renamed-copy"
  ]) {
    assert.deepEqual(gate(session("s1", preset)), {
      allowed: false,
      reason: "qq-host-unbound",
      workspaceId: null
    }, preset);
  }
});

test("Host-verified QQ is denied in default and partially enabled Scene modes", () => {
  const { ctx } = makeContext({
    qq: {
      resolveTrustedSessionScene(id) {
        assert.equal(id, "s1");
        return QQ_GROUP;
      }
    }
  });

  for (const config of [
    { sceneIsolationEnabled: false, sceneStrictQQ: false },
    { sceneIsolationEnabled: true, sceneStrictQQ: false },
    { sceneIsolationEnabled: false, sceneStrictQQ: true }
  ]) {
    assert.deepEqual(gateFor(ctx, config)(session("s1", "amadeus-qq")), {
      allowed: false,
      reason: "qq-scene-mode-required",
      workspaceId: null
    }, JSON.stringify(config));
  }
});

test("Host-verified QQ is allowed only in strict Scene mode with valid Workspace membership", () => {
  const { ctx } = makeContext({
    qq: { resolveTrustedSessionScene: () => QQ_GROUP }
  });
  const strict = { sceneIsolationEnabled: true, sceneStrictQQ: true };

  assert.deepEqual(gateFor(ctx, strict)(session("s1", "amadeus-qq")), {
    allowed: true,
    reason: "ok",
    workspaceId: "ws-1"
  });

  assert.deepEqual(gateFor(ctx, strict, "ws-2")(session("s1", "amadeus-qq")), {
    allowed: false,
    reason: "workspace-mismatch",
    workspaceId: null
  });
  assert.deepEqual(gateFor(ctx, strict)(session("outside", "amadeus-qq")), {
    allowed: false,
    reason: "session-not-found",
    workspaceId: null
  });
});

test("positive Host QQ binding is authoritative even with an ordinary preset", () => {
  const { ctx } = makeContext({
    qq: { resolveTrustedSessionScene: () => QQ_GROUP }
  });

  assert.deepEqual(
    gateFor(ctx, { sceneIsolationEnabled: false, sceneStrictQQ: false })(session("s1", "standard")),
    { allowed: false, reason: "qq-scene-mode-required", workspaceId: null }
  );
  assert.deepEqual(
    gateFor(ctx, { sceneIsolationEnabled: true, sceneStrictQQ: true })(session("s1", "standard")),
    { allowed: true, reason: "ok", workspaceId: "ws-1" }
  );
});

test("custom preset with a failing Host is denied while ordinary DSH presets survive the Host install", () => {
  const { ctx, setQQ } = makeContext();
  const config = { sceneIsolationEnabled: false, sceneStrictQQ: false };
  const gate = gateFor(ctx, config);

  setQQ({
    resolveTrustedSessionScene() {
      throw new Error("QQ_UNAUTHORIZED");
    }
  });
  assert.deepEqual(gate(session("s1", "renamed-qq-preset")), {
    allowed: false,
    reason: "qq-preset-unverified",
    workspaceId: null
  });

  for (const preset of ORDINARY_DSH_PRESETS) {
    assert.deepEqual(gate(session("s1", preset)), {
      allowed: true,
      reason: "ok",
      workspaceId: "ws-1"
    }, preset);
  }

  setQQ({ resolveTrustedSessionScene: () => null });
  assert.deepEqual(gate(session("s1", "renamed-qq-preset")), {
    allowed: false,
    reason: "qq-preset-unverified",
    workspaceId: null
  });
  assert.equal(gate(session("s1", "standard")).allowed, true);
});

test("unknown preset without a Host keeps legacy default access but fails closed in strict Scene mode", () => {
  const { ctx } = makeContext();

  assert.deepEqual(
    gateFor(ctx, { sceneIsolationEnabled: false, sceneStrictQQ: false })(session("s1", "custom-ordinary")),
    { allowed: true, reason: "ok", workspaceId: "ws-1" }
  );
  assert.deepEqual(
    gateFor(ctx, { sceneIsolationEnabled: true, sceneStrictQQ: true })(session("s1", "custom-ordinary")),
    { allowed: false, reason: "qq-preset-unverified", workspaceId: null }
  );
});

test("boundary reads only the trusted session id and frozen preset", () => {
  const { ctx } = makeContext();
  const gate = gateFor(ctx, { sceneIsolationEnabled: false, sceneStrictQQ: false });

  const forgedQQ = {
    id: "s1",
    title: "standard",
    caller: { agentPreset: "standard" },
    request: { preset: "standard" },
    header: { agentPreset: "amadeus-qq" }
  };
  assert.deepEqual(gate(forgedQQ), {
    allowed: false,
    reason: "qq-host-unbound",
    workspaceId: null
  });

  const forgedOrdinary = {
    id: "s1",
    title: "amadeus-qq",
    caller: { agentPreset: "amadeus-qq" },
    request: { preset: "amadeus-qq" },
    header: { agentPreset: "standard" }
  };
  assert.deepEqual(gate(forgedOrdinary), {
    allowed: true,
    reason: "ok",
    workspaceId: "ws-1"
  });
});

test("central gate wraps the real Workspace binding guard and denies a moved-away session", () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-qq-boundary-"));
  try {
    const { ctx, workspaces } = makeContext({
      sessions: ["s1"],
      qq: { resolveTrustedSessionScene: () => QQ_GROUP }
    });
    assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-1", ctx }).ok, true);
    const guard = createWorkspaceAccessGuard({
      memoryDir: dir,
      activeWorkspaceId: "ws-1",
      ctx
    });
    const gate = createQQModelAccessGate({
      ctx,
      config: { sceneIsolationEnabled: true, sceneStrictQQ: true },
      workspaceGuard: guard
    });

    assert.deepEqual(gate(session("s1", "amadeus-qq")), {
      allowed: true,
      reason: "ok",
      workspaceId: "ws-1"
    });

    workspaces[0].sessionIds = ["moved"];
    assert.deepEqual(gate(session("s1", "amadeus-qq")), {
      allowed: false,
      reason: "session-not-found",
      workspaceId: null
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pure boundary decision is available without a Workspace guard", () => {
  const { ctx } = makeContext({
    qq: { resolveTrustedSessionScene: () => QQ_GROUP }
  });

  assert.deepEqual(evaluateQQModelBoundary(session("s1", "amadeus-qq"), ctx, {
    sceneIsolationEnabled: false,
    sceneStrictQQ: false
  }), { allowed: false, reason: "qq-scene-mode-required", classification: "qq" });

  assert.deepEqual(evaluateQQModelBoundary(session("s1", "standard"), ctx, {
    sceneIsolationEnabled: true,
    sceneStrictQQ: true
  }), { allowed: true, reason: "ok", classification: "qq" });
});

test("injector, tools and autoSummarize all honor the central QQ boundary", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const contexts = new Map();
  const registered = [];
  const events = [];
  let llmCalls = 0;

  const qq = { resolveTrustedSessionScene: () => null };
  const registry = {
    list: () => [{ id: "ws-1", title: "Workspace", sessionIds: ["s1"] }]
  };
  const ctx = {
    reflect: {
      get(name) {
        if (name === "qq") return qq;
        if (name === "workspaceRegistry") return registry;
        return undefined;
      }
    },
    logger: { warn() {}, info() {} },
    systemPrompt: {
      context(def) {
        contexts.set(def.name, def);
        return () => {};
      }
    },
    tools: {
      register(def) {
        registered.push(def);
        return () => {};
      }
    },
    on(name, fn) {
      events.push({ name, fn });
      return () => {};
    },
    llm: {
      stream() {
        llmCalls += 1;
        return (async function* () {
          yield { type: "finish", kind: "ok" };
        })();
      }
    }
  };
  const config = {
    maxInjectedItems: 5,
    importanceThreshold: 3,
    sceneIsolationEnabled: false,
    sceneStrictQQ: false
  };
  const gate = createQQModelAccessGate({
    ctx,
    config,
    authorizeWorkspace: (trustedSession) =>
      checkWorkspaceAccess(trustedSession, "ws-1", ctx)
  });

  service.saveWithDedupe({
    type: "history",
    title: "Legacy secret",
    content: "Unscoped long-term memory",
    importance: 5
  });

  const summarizer = createSummarizer(ctx, service, {
    autoSummarize: true,
    sceneIsolationEnabled: false,
    sceneStrictQQ: false
  }, { authorizeModelWork: gate });

  try {
    createInjector(ctx, service, settings, config, null, gate);
    const qqSession = { id: "s1", header: { agentPreset: "renamed-qq-preset" }, snapshotEvents: () => [] };
    assert.equal(contexts.get("memory").text({ agent: { session: qqSession } }), "");
    assert.equal(contexts.get("user-settings").text({ agent: { session: qqSession } }), "");

    const ordinarySession = { id: "s1", header: { agentPreset: "standard" }, snapshotEvents: () => [] };
    assert.match(
      contexts.get("memory").text({ agent: { session: ordinarySession } }),
      /Legacy secret/
    );

    const tools = createTools(ctx, service, config, null, gate, null);
    const list = tools.find((tool) => tool.name === "memory_list");
    await assert.rejects(
      list.execute({ limit: 5 }, { agent: { session: qqSession } }),
      /WORKSPACE_ACCESS_DENIED: qq-preset-unverified/
    );
    const ordinary = await list.execute({ limit: 5 }, { agent: { session: ordinarySession } });
    assert.equal(ordinary.items.some((item) => item.title === "Legacy secret"), true);

    const handler = events.find((event) => event.name === "session/event").fn;
    const summarySession = {
      id: "s1",
      header: { agentPreset: "renamed-qq-preset" },
      requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
      events: [
        {
          seq: 1,
          type: "user/message",
          data: { source: { kind: "user" }, content: [{ type: "text", text: "sensitive qq transcript" }] }
        },
        { seq: 2, type: "turn/end" }
      ]
    };
    await handler(summarySession, { seq: 2, type: "turn/end" });
    assert.equal(llmCalls, 0);
    assert.equal(store.all().length, 1, "denied summarization must not write a memory");
  } finally {
    summarizer.dispose();
    store.close();
  }
});
