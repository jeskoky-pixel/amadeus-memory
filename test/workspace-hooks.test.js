import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import * as mneme from "../src/index.js";
import { createStore } from "../src/store.js";
import { createInjector } from "../src/inject.js";
import { createNudgeAutoRun } from "../src/pipeline-nudge-auto.js";
import { createMoRunHandler } from "../src/pipeline-command.js";
import {
  CONTINUITY_KIND,
  createContinuityRescue
} from "../src/continuity.js";
import { MEMORY_GUIDE_SECTION } from "../src/guide.js";
import {
  createWorkspaceAccessGuard,
  initializeWorkspaceDataDir,
  setWorkspaceBinding
} from "../src/workspace-binding.js";

// Workspace hook gate follow-up: continuity, deferred nudge, /mo-run and the
// original guidance section must all deny a moved or unbound Session before
// they read a transcript, scan a project, touch the recorder or render text.

const tempDirs = [];

function tempMemoryDir() {
  const dir = mkdtempSync(join(tmpdir(), "mneme-workspace-hooks-"));
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
  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId, ctx }).ok, true);
  const initialized = initializeWorkspaceDataDir(dir);
  assert.equal(initialized.ok, true);
}

function guardFor(dir, ctx) {
  return createWorkspaceAccessGuard({ memoryDir: dir, activeWorkspaceId: "ws-a", ctx });
}

function moveTo(workspaces, sessionId, workspaceIndex) {
  workspaces[0].sessionIds = workspaces[0].sessionIds.filter((id) => id !== sessionId);
  workspaces[1].sessionIds = workspaces[1].sessionIds.filter((id) => id !== sessionId);
  workspaces[workspaceIndex].sessionIds.push(sessionId);
}

function userEvent(seq, text) {
  return {
    type: "user/message",
    seq,
    data: { source: { kind: "user" }, content: [{ type: "text", text }] }
  };
}

function continuitySession(id, events) {
  let snapshots = 0;
  return {
    id,
    events,
    snapshotEvents() {
      snapshots += 1;
      return events;
    },
    get snapshotCount() {
      return snapshots;
    }
  };
}

function continuityCtx() {
  const handlers = new Map();
  const warnings = [];
  return {
    logger: { warn: (message) => warnings.push(String(message)) },
    warnings,
    on(name, fn) {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
    fire(name, ...args) {
      return handlers.get(name)?.(...args);
    }
  };
}

const ENTER = async () => ({ kind: "enter", messages: [] });

test("workspace-hooks: compaction events from an unauthorized Session never queue an edge", async () => {
  const dir = tempMemoryDir();
  const workspaces = [{ id: "ws-a", title: "A", sessionIds: ["s1"] }];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const guard = guardFor(dir, ctx);
  const store = createStore(":memory:");
  const handlerCtx = continuityCtx();
  const rescue = createContinuityRescue(handlerCtx, store, guard.authorize);
  const foreign = continuitySession("s2", [userEvent(1, "not mine")]);
  try {
    handlerCtx.fire("session/event", foreign, { type: "compaction/end", seq: 9 });
    const decision = await handlerCtx.fire("agent/pre-step", { agent: { session: foreign } }, ENTER);
    assert.deepEqual(decision.messages, [], "no notice may be injected for another Workspace");
    assert.equal(store.countContinuityProposals(), 0);
    assert.equal(foreign.snapshotCount, 0, "the transcript must not even be read");
  } finally {
    rescue.dispose();
    store.close();
  }
});

test("workspace-hooks: a Session moved after an edge queued is denied in pre-step and the edge is dropped", async () => {
  const dir = tempMemoryDir();
  const workspaces = [
    { id: "ws-a", title: "A", sessionIds: ["s1"] },
    { id: "ws-b", title: "B", sessionIds: [] }
  ];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const guard = guardFor(dir, ctx);
  const store = createStore(":memory:");
  const handlerCtx = continuityCtx();
  const rescue = createContinuityRescue(handlerCtx, store, guard.authorize);
  const session = continuitySession("s1", [userEvent(1, "do the work")]);
  const step = () => handlerCtx.fire("agent/pre-step", { agent: { session } }, ENTER);
  try {
    handlerCtx.fire("session/event", session, { type: "compaction/end", seq: 9 });
    moveTo(workspaces, "s1", 1);

    const decision = await step();
    assert.deepEqual(decision.messages, [], "a moved Session gets no continuity notice");
    assert.equal(store.countContinuityProposals(), 0, "a moved Session gets no proposal");
    assert.equal(session.snapshotCount, 0, "authorization runs before snapshotEvents");

    // Moving back does not revive the stale edge: it was dropped, so a later
    // genuinely authorized pre-step still must not rescue the old moment.
    moveTo(workspaces, "s1", 0);
    assert.deepEqual((await step()).messages, []);
    assert.equal(store.countContinuityProposals(), 0);
  } finally {
    rescue.dispose();
    store.close();
  }
});

test("workspace-hooks: a binding change after an edge queued stops continuity immediately", async () => {
  const dir = tempMemoryDir();
  const workspaces = [
    { id: "ws-a", title: "A", sessionIds: ["s1"] },
    { id: "ws-b", title: "B", sessionIds: [] }
  ];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const guard = guardFor(dir, ctx);
  const store = createStore(":memory:");
  const handlerCtx = continuityCtx();
  const rescue = createContinuityRescue(handlerCtx, store, guard.authorize);
  const session = continuitySession("s1", [userEvent(1, "do the work")]);
  try {
    handlerCtx.fire("session/event", session, { type: "compaction/end", seq: 9 });
    assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-b", ctx }).ok, true);

    const decision = await handlerCtx.fire("agent/pre-step", { agent: { session } }, ENTER);
    assert.deepEqual(decision.messages, []);
    assert.equal(store.countContinuityProposals(), 0);
    assert.equal(session.snapshotCount, 0);
  } finally {
    rescue.dispose();
    store.close();
  }
});

test("workspace-hooks: continuity still rescues an authorized Session (regression)", async () => {
  const dir = tempMemoryDir();
  const workspaces = [{ id: "ws-a", title: "A", sessionIds: ["s1"] }];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const guard = guardFor(dir, ctx);
  const store = createStore(":memory:");
  const handlerCtx = continuityCtx();
  const rescue = createContinuityRescue(handlerCtx, store, guard.authorize);
  const session = continuitySession("s1", [userEvent(1, "do the work")]);
  try {
    handlerCtx.fire("session/event", session, { type: "compaction/end", seq: 9 });
    const decision = await handlerCtx.fire("agent/pre-step", { agent: { session } }, ENTER);
    assert.equal(decision.messages.length, 1);
    assert.equal(store.getContinuityProposal("s1", CONTINUITY_KIND).current_work, "do the work");
  } finally {
    rescue.dispose();
    store.close();
  }
});

function nudgeCtx() {
  const listeners = [];
  return {
    logger: { info() {}, warn() {} },
    on(name, fn) {
      if (name !== "session/event") throw new Error("unexpected event: " + name);
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    emit(session, event) {
      for (const fn of listeners.slice()) fn(session, event);
    }
  };
}

function nudgeSession(id, cwd = "D:/proj") {
  return { id, header: { cwd } };
}

function tick(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("workspace-hooks: an unauthorized turn/end is rejected before nudge queues any work", async () => {
  const dir = tempMemoryDir();
  const workspaces = [{ id: "ws-a", title: "A", sessionIds: ["s1"] }];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const guard = guardFor(dir, ctx);
  const calls = [];
  const host = nudgeCtx();
  const auto = createNudgeAutoRun({
    ctx: host,
    runNudge: (args) => {
      calls.push(args);
      return { counts: { savedProposals: 0 } };
    },
    authorizeModelWork: guard.authorize,
    now: () => 1_000_000
  });
  try {
    host.emit(nudgeSession("s2"), { type: "turn/end" });
    await tick();
    assert.deepEqual(calls, [], "another Workspace's turn/end must not scan a project");
    assert.equal(auto.pendingCount(), 0, "nothing may be left queued");
  } finally {
    auto();
  }
});

test("workspace-hooks: a Session moved while a nudge job is queued is rechecked and never scanned", async () => {
  const dir = tempMemoryDir();
  const workspaces = [
    { id: "ws-a", title: "A", sessionIds: ["s1"] },
    { id: "ws-b", title: "B", sessionIds: [] }
  ];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const guard = guardFor(dir, ctx);
  const calls = [];
  const host = nudgeCtx();
  const auto = createNudgeAutoRun({
    ctx: host,
    runNudge: (args) => {
      calls.push(args);
      return { counts: { savedProposals: 0 } };
    },
    authorizeModelWork: guard.authorize,
    now: () => 1_000_000
  });
  try {
    host.emit(nudgeSession("s1"), { type: "turn/end" });
    // The job is still deferred; move the Session before the macrotask runs.
    moveTo(workspaces, "s1", 1);
    await tick();
    assert.deepEqual(calls, [], "the deferred job must recheck the actual Session");
    assert.equal(auto.pendingCount(), 0);
  } finally {
    auto();
  }
});

test("workspace-hooks: a binding change while a nudge job is queued is rechecked and never scanned", async () => {
  const dir = tempMemoryDir();
  const workspaces = [
    { id: "ws-a", title: "A", sessionIds: ["s1"] },
    { id: "ws-b", title: "B", sessionIds: [] }
  ];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const guard = guardFor(dir, ctx);
  const calls = [];
  const host = nudgeCtx();
  const auto = createNudgeAutoRun({
    ctx: host,
    runNudge: (args) => {
      calls.push(args);
      return { counts: { savedProposals: 0 } };
    },
    authorizeModelWork: guard.authorize,
    now: () => 1_000_000
  });
  try {
    host.emit(nudgeSession("s1"), { type: "turn/end" });
    assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-b", ctx }).ok, true);
    await tick();
    assert.deepEqual(calls, [], "a stale binding must not scan or save proposals");
    assert.equal(auto.pendingCount(), 0);
  } finally {
    auto();
  }
});

test("workspace-hooks: nudge still runs for an authorized Session (regression)", async () => {
  const dir = tempMemoryDir();
  const workspaces = [{ id: "ws-a", title: "A", sessionIds: ["s1"] }];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const guard = guardFor(dir, ctx);
  const calls = [];
  const host = nudgeCtx();
  const auto = createNudgeAutoRun({
    ctx: host,
    runNudge: (args) => {
      calls.push(args);
      return { counts: { savedProposals: 0 } };
    },
    authorizeModelWork: guard.authorize,
    now: () => 1_000_000
  });
  try {
    host.emit(nudgeSession("s1"), { type: "turn/end" });
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(auto.pendingCount(), 0);
  } finally {
    auto();
  }
});

function recordingRecorder() {
  const calls = [];
  return {
    calls,
    start(args) {
      calls.push(["start", args]);
      return { ok: true, pipelineId: "demo", steps: 2 };
    },
    stop(args) {
      calls.push(["stop", args]);
      return { ok: true, pipelineId: "demo", steps: 2 };
    },
    confirm(args) {
      calls.push(["confirm", args]);
      return { ok: true, pipelineId: "demo", steps: 1, notDone: [], unsure: [], unanswered: [] };
    },
    status(args) {
      calls.push(["status", args]);
      return { open: false };
    }
  };
}

function invocation(rawInput, sessionId) {
  return { rawInput, agent: { session: { id: sessionId } } };
}

test("workspace-hooks: /mo-run denies every non-help action before touching the recorder", () => {
  const dir = tempMemoryDir();
  const workspaces = [{ id: "ws-a", title: "A", sessionIds: ["s1"] }];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const guard = guardFor(dir, ctx);
  const recorder = recordingRecorder();
  const handler = createMoRunHandler({ recorder, language: () => "zh", authorizeModelWork: guard.authorize });

  for (const raw of ["start demo", "stop", "confirm P6", "status"]) {
    const result = handler(invocation(raw, "s2"));
    assert.equal(result.kind, "error", raw + " must be rejected");
    assert.match(result.text, /Workspace|无权/);
  }
  assert.deepEqual(recorder.calls, [], "open/stop/confirm/status must not read recorder state");

  // help never touches the recorder and is allowed regardless of membership.
  const help = handler(invocation("not-a-command", "s2"));
  assert.equal(help.kind, "success");
  assert.deepEqual(recorder.calls, []);
});

test("workspace-hooks: /mo-run uses the trusted invocation Session, not parsed text", () => {
  const dir = tempMemoryDir();
  const workspaces = [{ id: "ws-a", title: "A", sessionIds: ["s1"] }];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const guard = guardFor(dir, ctx);
  const recorder = recordingRecorder();
  const handler = createMoRunHandler({ recorder, language: () => "zh", authorizeModelWork: guard.authorize });

  // The raw text names the authorized id; the actual invocation Session is s2.
  const forged = handler(invocation("start s1", "s2"));
  assert.equal(forged.kind, "error");
  assert.deepEqual(recorder.calls, []);
});

test("workspace-hooks: /mo-run denies a moved Session and a binding switch after start", () => {
  const dir = tempMemoryDir();
  const workspaces = [
    { id: "ws-a", title: "A", sessionIds: ["s1"] },
    { id: "ws-b", title: "B", sessionIds: [] }
  ];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const guard = guardFor(dir, ctx);
  const recorder = recordingRecorder();
  const handler = createMoRunHandler({ recorder, language: () => "zh", authorizeModelWork: guard.authorize });

  const started = handler(invocation("start demo", "s1"));
  assert.equal(started.kind, "success");
  assert.equal(recorder.calls.length, 1);

  moveTo(workspaces, "s1", 1);
  const moved = handler(invocation("stop", "s1"));
  assert.equal(moved.kind, "error");
  assert.equal(recorder.calls.length, 1, "a moved Session cannot stop/read the open window");

  moveTo(workspaces, "s1", 0);
  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-b", ctx }).ok, true);
  const switched = handler(invocation("status", "s1"));
  assert.equal(switched.kind, "error");
  assert.equal(recorder.calls.length, 1);
});

test("workspace-hooks: /mo-run still serves an authorized Session (regression)", () => {
  const dir = tempMemoryDir();
  const workspaces = [{ id: "ws-a", title: "A", sessionIds: ["s1"] }];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const guard = guardFor(dir, ctx);
  const recorder = recordingRecorder();
  const handler = createMoRunHandler({ recorder, language: () => "zh", authorizeModelWork: guard.authorize });

  assert.equal(handler(invocation("start demo", "s1")).kind, "success");
  assert.equal(handler(invocation("stop", "s1")).kind, "success");
  assert.equal(handler(invocation("confirm P6", "s1")).kind, "success");
  assert.equal(handler(invocation("status", "s1")).kind, "success");
  assert.deepEqual(recorder.calls.map(([name]) => name), ["start", "stop", "confirm", "status"]);
});

function guideFixture(config, guard) {
  const sections = [];
  const contexts = {};
  const injectorCtx = {
    logger: { warn() {} },
    systemPrompt: {
      section(spec) {
        sections.push(spec);
        return () => {};
      },
      context(spec) {
        contexts[spec.name] = spec.text;
        return () => {};
      }
    }
  };
  const service = {
    injectCandidates: () => [],
    embedQuery: async () => null
  };
  const dispose = createInjector(injectorCtx, service, {}, config, null, guard ? guard.authorize : null);
  return { sections, contexts, dispose };
}

const GUIDE_CONFIG = {
  autoInject: true,
  injectGuidanceEnabled: true,
  hotMemoryEnabled: false,
  maxInjectedItems: 5,
  importanceThreshold: 3,
  injectRotationTurns: 0
};

function guideText(sections) {
  const guide = sections.find((section) => section.name === "memory-guide");
  assert.ok(guide, "memory-guide section is registered");
  assert.equal(typeof guide.text, "function", "the host section text contract supports a per-assembly provider");
  return (sessionId) => guide.text({ agent: { session: { id: sessionId } }, scope: {} });
}

test("workspace-hooks: guidance section text is empty for an unauthorized or moved Session", () => {
  const dir = tempMemoryDir();
  const workspaces = [
    { id: "ws-a", title: "A", sessionIds: ["s1"] },
    { id: "ws-b", title: "B", sessionIds: [] }
  ];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const guard = guardFor(dir, ctx);
  const fixture = guideFixture(GUIDE_CONFIG, guard);
  try {
    const render = guideText(fixture.sections);
    assert.equal(render("s1"), MEMORY_GUIDE_SECTION, "authorized Session gets the original guide");
    assert.equal(render("s2"), "", "another Workspace gets no guide text");

    moveTo(workspaces, "s1", 1);
    assert.equal(render("s1"), "", "a moved Session stops receiving the guide immediately");
  } finally {
    fixture.dispose();
  }
});

test("workspace-hooks: guidance section text is empty after a binding change", () => {
  const dir = tempMemoryDir();
  const workspaces = [
    { id: "ws-a", title: "A", sessionIds: ["s1"] },
    { id: "ws-b", title: "B", sessionIds: [] }
  ];
  const ctx = registryCtx(workspaces);
  select(dir, "ws-a", ctx);
  const guard = guardFor(dir, ctx);
  const fixture = guideFixture(GUIDE_CONFIG, guard);
  try {
    const render = guideText(fixture.sections);
    assert.equal(render("s1"), MEMORY_GUIDE_SECTION);
    assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-b", ctx }).ok, true);
    assert.equal(render("s1"), "");
  } finally {
    fixture.dispose();
  }
});

test("workspace-hooks: guidance section keeps the legacy static text when no callback is supplied", () => {
  const fixture = guideFixture(GUIDE_CONFIG, null);
  try {
    const render = guideText(fixture.sections);
    assert.equal(render("s1"), MEMORY_GUIDE_SECTION);
    assert.equal(render("s2"), MEMORY_GUIDE_SECTION, "direct module tests keep upstream behavior");
  } finally {
    fixture.dispose();
  }
});

test("workspace-hooks: index supplies the runtime guard to every remaining hook", () => {
  const index = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  for (const needle of [
    "createContinuityRescue(ctx, store, authorizeModelWork)",
    "createNudgeAutoRun({ ctx, memoryDir: runtimeDir, logger: ctx.logger, authorizeModelWork })",
    "createExecutionRecorder({ ctx: recorderCtx, logger: ctx.logger })"
  ]) {
    assert.ok(index.includes(needle), "index.js must wire: " + needle);
  }
  assert.match(
    index,
    /createInjector\([\s\S]*?authorizeModelWork,\s*recentActivity,\s*\(\) => settings\.getRecentActivityConfig\(\)\s*\)/
  );
  assert.match(index, /registerMoRunCommand\(\{[\s\S]*?authorizeModelWork[\s\S]*?\}\);/);
});

test("workspace-hooks: full boot wires the guard into commands, the guide and the event hooks", async () => {
  const dir = tempMemoryDir();
  const workspaces = [
    { id: "ws-a", title: "A", sessionIds: ["s1"] },
    { id: "ws-b", title: "B", sessionIds: [] }
  ];
  const registry = { list: () => workspaces };
  select(dir, "ws-a", { workspaceRegistry: registry });

  const registered = [];
  const sections = [];
  const ctx = new Context();
  ctx.provide("tools", { register() { return () => {}; } });
  ctx.provide("commands", { register(command) { registered.push(command); return () => {}; } });
  ctx.provide("systemPrompt", {
    context() { return () => {}; },
    section(spec) { sections.push(spec); return () => {}; }
  });
  ctx.provide("agentDefaultModel", { currentSelection() { return { provider: "mock", model: "mock" }; } });
  ctx.provide("llm", { async *stream() { yield { type: "finish", reason: { kind: "stop" } }; } });
  ctx.provide("webServer", { register() { return () => {}; } });
  ctx.provide("workspaceRegistry", registry);
  ctx.provide("connection", { admit() { return { peer: { principal: { kind: "owner" } } }; } });

  const fiber = ctx.plugin(mneme, {
    memoryDir: dir,
    autoDream: false,
    autoSummarize: false,
    sleepModeEnabled: false,
    entityExtractionEnabled: false,
    autoReindexOnBoot: false,
    actionRunEnabled: true,
    actionNudgeEnabled: true,
    continuityRescueEnabled: true,
    autoInject: true,
    injectGuidanceEnabled: true
  });
  await fiber;
  try {
    const command = registered.find((entry) => entry.name === "mo-run");
    assert.ok(command, "the command is registered when actionRunEnabled is true");
    assert.equal(command.handler({ rawInput: "status", agent: { session: { id: "s2" } } }).kind, "error");
    assert.equal(command.handler({ rawInput: "status", agent: { session: { id: "s1" } } }).kind, "success");

    const guide = sections.find((section) => section.name === "memory-guide");
    assert.ok(guide);
    assert.equal(guide.text({ agent: { session: { id: "s1" } }, scope: {} }), MEMORY_GUIDE_SECTION);
    assert.equal(guide.text({ agent: { session: { id: "s2" } }, scope: {} }), "");
  } finally {
    await fiber.dispose();
  }
});
