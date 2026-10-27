import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSummarizer } from "../src/summarize.js";

const SUMMARY_JSON = JSON.stringify([
  { type: "decision", title: "选型", content: "确定使用合成方案", importance: 4 }
]);

function userMessage(text, seq) {
  return { seq, type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text }] } };
}

function makeCtx(host) {
  const events = [];
  const calls = [];
  const ctx = {
    on(name, fn) { events.push({ name, fn }); return () => {}; },
    logger: { warn() {}, info() {} },
    reflect: { get(name) { return name === "qq" ? host.qq : null; } },
    llm: {
      stream(options) {
        calls.push(options);
        return (async function* () {
          yield { type: "block-start", block: { type: "text" } };
          yield { type: "text-delta", delta: SUMMARY_JSON };
          yield { type: "block-end", block: { type: "text" } };
          yield { type: "finish", kind: "ok" };
        })();
      }
    }
  };
  return { ctx, events, calls };
}

function setup(config, host = null) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const { ctx, events, calls } = makeCtx(host ?? {});
  const summarizer = createSummarizer(ctx, service, { autoSummarize: true, ...config });
  const handler = events.find((event) => event.name === "session/event").fn;
  return { store, service, summarizer, handler, calls };
}

function qqSession(id) {
  return {
    id,
    header: { agentPreset: "amadeus-qq" },
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    events: [userMessage("synthetic transcript", 1), { seq: 2, type: "turn/end" }]
  };
}

test("strict Scene autoSummarize stamps group A/B writes and keeps them separate", async () => {
  const host = {
    qq: {
      resolveTrustedSessionScene(sessionId) {
        const id = sessionId.endsWith("a") ? "group-a" : "group-b";
        return { platform: "qq", kind: "group", id, verified: true };
      }
    }
  };
  const { store, summarizer, handler } = setup({ sceneIsolationEnabled: true, sceneStrictQQ: true }, host);
  try {
    await handler(qqSession("session-a"), { seq: 2, type: "turn/end" });
    await handler(qqSession("session-b"), { seq: 2, type: "turn/end" });
    const rows = store.all();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.scene_scope).sort(), ["qq:group:group-a", "qq:group:group-b"]);
    assert.ok(rows.every((row) => row.content.includes("合成")));
  } finally {
    summarizer.dispose();
    store.close();
  }
});

test("strict Scene autoSummarize refuses an unverified Host contract", async () => {
  const { store, summarizer, handler, calls } = setup({ sceneIsolationEnabled: true, sceneStrictQQ: true }, {});
  try {
    await handler(qqSession("session-a"), { seq: 2, type: "turn/end" });
    assert.equal(calls.length, 0);
    assert.equal(store.count(), 0);
  } finally {
    summarizer.dispose();
    store.close();
  }
});

test("deferred strict Scene run refuses a binding that changed while waiting", async () => {
  let binding = "group-a";
  const host = {
    qq: {
      resolveTrustedSessionScene() {
        return { platform: "qq", kind: "group", id: binding, verified: true };
      }
    }
  };
  const timers = [];
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const deps = {
    now: () => clock,
    setTimeoutFn(fn, ms) { const timer = { fn, at: clock + ms }; timers.push(timer); return timer; },
    clearTimeoutFn(timer) { const index = timers.indexOf(timer); if (index !== -1) timers.splice(index, 1); }
  };
  const { store, summarizer, handler, calls } = setup({
    sceneIsolationEnabled: true,
    sceneStrictQQ: true,
    summarizePeakHours: "00:00-23:59"
  }, host);
  // setup() does not expose deps; rebuild with the injected clock.
  summarizer.dispose();
  const store2 = createStore(":memory:");
  const service2 = createService({ store: store2, mirror: null, config: {} });
  const made = makeCtx(host);
  const scoped = createSummarizer(made.ctx, service2, {
    autoSummarize: true, sceneIsolationEnabled: true, sceneStrictQQ: true, summarizePeakHours: "00:00-23:59"
  }, deps);
  const scopedHandler = made.events.find((event) => event.name === "session/event").fn;
  try {
    await scopedHandler(qqSession("session-a"), { seq: 2, type: "turn/end" });
    assert.equal(made.calls.length, 0, "peak window must defer, not summarize A");
    assert.equal(timers.length, 1);
    binding = "group-b";
    clock = Date.parse("2026-01-02T00:00:00Z");
    const timer = timers.shift();
    await timer.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(made.calls.length, 0, "changed binding must refuse the deferred A window");
    assert.equal(store2.count(), 0);
  } finally {
    scoped.dispose();
    store2.close();
    store.close();
  }
  assert.equal(calls.length, 0);
});

test("scene change during transcript collection aborts before the LLM call", async () => {
  let binding = "group-a";
  const host = { qq: { resolveTrustedSessionScene: () => ({ platform: "qq", kind: "group", id: binding, verified: true }) } };
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const made = makeCtx(host);
  const summarizer = createSummarizer(made.ctx, service, { autoSummarize: true, sceneIsolationEnabled: true, sceneStrictQQ: true });
  const handler = made.events.find((event) => event.name === "session/event").fn;
  const session = qqSession("session-move");
  let reads = 0;
  session.snapshotEvents = () => {
    reads += 1;
    if (reads === 1) binding = "group-b";
    return [userMessage("scene A transcript", 1), { seq: 2, type: "turn/end" }];
  };
  try {
    await handler(session, { seq: 2, type: "turn/end" });
    assert.equal(made.calls.length, 0, "the moved window must not reach the LLM");
    assert.equal(store.count(), 0);
  } finally {
    summarizer.dispose();
    store.close();
  }
});

test("scene change during LLM generation rejects the write", async () => {
  let binding = "group-a";
  const host = { qq: { resolveTrustedSessionScene: () => ({ platform: "qq", kind: "group", id: binding, verified: true }) } };
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const made = makeCtx(host);
  made.ctx.llm.stream = async function* () {
    binding = "group-b";
    yield { type: "text-delta", delta: SUMMARY_JSON };
    yield { type: "finish", kind: "ok" };
  };
  const summarizer = createSummarizer(made.ctx, service, { autoSummarize: true, sceneIsolationEnabled: true, sceneStrictQQ: true });
  const handler = made.events.find((event) => event.name === "session/event").fn;
  try {
    await handler(qqSession("session-write-move"), { seq: 2, type: "turn/end" });
    assert.equal(store.count(), 0, "a moved binding must reject the atomic write");
  } finally {
    summarizer.dispose();
    store.close();
  }
});

test("index keeps the strict-QQ summarizer enabled while dream/sleep stay gated", () => {
  const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(src, /const strictQQScene = cfg\.sceneIsolationEnabled === true && cfg\.sceneStrictQQ === true/);
  assert.match(src, /!strictQQScene && sceneUnsafeDerivation\(\)/);
  assert.match(src, /if \(cfg\.autoDream && !sceneUnsafeDerivation\(\)\)/);
  assert.match(src, /if \(cfg\.sleepModeEnabled && !sceneUnsafeDerivation\(\)\)/);
});

test("feature-off autoSummarize keeps the legacy unscoped write behavior", async () => {
  const { store, summarizer, handler } = setup({});
  try {
    await handler({
      id: "plain-session",
      header: { agentPreset: "default" },
      requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
      events: [userMessage("ordinary transcript", 1), { seq: 2, type: "turn/end" }]
    }, { seq: 2, type: "turn/end" });
    const rows = store.all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scene_scope, undefined);
  } finally {
    summarizer.dispose();
    store.close();
  }
});
