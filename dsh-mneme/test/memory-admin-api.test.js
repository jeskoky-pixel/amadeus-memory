// Owner-authenticated native-settings API for Amadeus Memory. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { mountAdminApi, __adminInternals } from "../src/admin-api.js";

function setup({ owner = true, embedder = null } = {}) {
  const store = createStore(":memory:");
  const config = {
    language: "zh",
    autoInject: true,
    autoSummarize: true,
    autoDream: true,
    sleepModeEnabled: false,
    entityExtractionEnabled: false,
    memoryPreferenceEnabled: false,
    trustedIntakeEnabled: false,
    rerankEnabled: false,
    embedProvider: "openai",
    localEmbedModel: "Xenova/bge-small-zh-v1.5",
    localEmbedDimension: 512,
    maxInjectedItems: 5,
    importanceThreshold: 3,
    injectContentMaxChars: 300,
    vectorSearchTopK: 20,
    vectorSearchThreshold: 0.65,
    memoryQualityFilter: { enabled: true },
    llmAudit: { enabled: true }
  };
  const service = createService({ store, mirror: null, config });
  const settings = createSettings(store.db);
  const routes = [];
  const ctx = {
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
    effect(fn) { const d = fn(); return d; }
  };
  mountAdminApi(ctx, {
    service, settings, store, config, embedder,
    vectorIndex: { getStats: () => ({ embeddedCount: 3, totalCount: 5 }) }
  });
  assert.equal(routes.length, 1);
  return { store, service, settings, route: routes[0], close: () => store.close() };
}

function makeRes() {
  const res = {
    status: 0,
    body: "",
    headers: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = String(body ?? ""); }
  };
  return res;
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

async function call(route, options) {
  const res = makeRes();
  await route.handler(req(options), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* non-JSON */ }
  return { status: res.status, json, headers: res.headers };
}

test("admin API is same-origin owner-only and marks writes", async () => {
  const h = setup();
  try {
    assert.equal((await call(h.route, { url: "/api/amadeus-memory/admin/overview", headers: { "x-test-unauthenticated": "1" } })).status, 401);
    assert.equal((await call(h.route, {
      url: "/api/amadeus-memory/admin/overview", headers: { origin: "https://evil.example" }
    })).status, 403);
    const noMarker = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/preferences",
      headers: { "content-type": "application/json" },
      body: { action: "set-tag", tag: "x", weight: 1.2 }
    });
    assert.equal(noMarker.status, 403);
    const guest = setup({ owner: false });
    try {
      assert.equal((await call(guest.route, { url: "/api/amadeus-memory/admin/overview" })).status, 403);
    } finally {
      guest.close();
    }
  } finally {
    h.close();
  }
});

test("overview reports truthful bounded status without secrets or memory bodies", async () => {
  const h = setup();
  try {
    h.service.saveWithDedupe({ type: "project", title: "Synthetic project", content: "Synthetic body" });
    h.settings.setVectorConfig({ enabled: true, baseUrl: "https://example.invalid", apiKey: "synthetic-secret-key", model: "qwen-embed" });
    const out = await call(h.route, { url: "/api/amadeus-memory/admin/overview" });
    assert.equal(out.status, 200);
    const data = out.json.data;
    assert.equal(data.memories.active, 1);
    assert.equal(data.memories.total, 1);
    assert.equal(data.package.name, "@modusensus/dsh-mneme");
    assert.equal(data.package.edition, "enhanced");
    assert.equal(data.runtime.auto_dream, true);
    assert.equal(data.semantic.index.embedded, 3);
    assert.equal(data.semantic.vector_config.api_key_configured, true);
    assert.equal(JSON.stringify(data).includes("synthetic-secret-key"), false);
    assert.equal(JSON.stringify(data).includes("Synthetic body"), false);
    assert.equal("overview" in __adminInternals, false);
  } finally {
    h.close();
  }
});

test("overview resolves last_dream and last_sleep independently beyond the 5-row recent slice", async () => {
  const h = setup();
  try {
    h.service.saveDreamRun({
      id: "sleep-old", run_type: "sleep", status: "ok",
      created_at: "2026-01-01T00:00:00.000Z", snapshot_hash: "sleep-hash",
      input_count: 0, receipt: "sleep-receipt", input: { private: "SLEEP_PRIVATE_INPUT" }
    });
    for (let i = 0; i < 6; i += 1) {
      h.service.saveDreamRun({
        id: `dream-${i}`, run_type: "auto", status: "ok",
        created_at: `2026-02-0${i + 1}T00:00:00.000Z`, snapshot_hash: `d${i}`,
        input_count: 0, receipt: `r${i}`, input: { private: `DREAM_PRIVATE_${i}` }
      });
    }
    const out = await call(h.route, { url: "/api/amadeus-memory/admin/overview" });
    assert.equal(out.status, 200);
    assert.equal(out.json.data.last_sleep.created_at, "2026-01-01T00:00:00.000Z");
    assert.equal(out.json.data.last_dream.created_at, "2026-02-06T00:00:00.000Z");
    assert.equal(out.json.data.recent_runs.length, 5);
    assert.equal(out.json.data.recent_runs.some((row) => row.run_type === "sleep"), false);
    assert.equal(JSON.stringify(out.json.data).includes("SLEEP_PRIVATE_INPUT"), false);
    assert.equal(JSON.stringify(out.json.data).includes("DREAM_PRIVATE"), false);
  } finally {
    h.close();
  }
});

test("features endpoint validates and returns effective values and pending restart", async () => {
  const h = setup();
  try {
    const before = await call(h.route, { url: "/api/amadeus-memory/admin/features" });
    assert.equal(before.status, 200);
    assert.equal(before.json.data.effective.autoDream, true);
    const bad = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/features",
      headers: { "content-type": "application/json", "x-amadeus-memory": "1" },
      body: { autoDream: "yes" }
    });
    assert.equal(bad.status, 400);
    const ok = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/features",
      headers: { "content-type": "application/json", "x-amadeus-memory": "1" },
      body: { autoDream: false }
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.effective.autoDream, false);
    assert.equal(h.settings.getFeatureFlags().autoDream, false);
  } finally {
    h.close();
  }
});

test("preference endpoints reuse the existing weight store and resolve names safely", async () => {
  const h = setup();
  try {
    const one = h.store.createEntity({ name: "Aster", type: "person" });
    const setTag = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/preferences",
      headers: { "content-type": "application/json", "x-amadeus-memory": "1" },
      body: { action: "set-tag", tag: "person:close", weight: 1.8 }
    });
    assert.equal(setTag.status, 200);
    assert.equal(setTag.json.data.state.tags.length, 1);
    const setEntity = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/preferences",
      headers: { "content-type": "application/json", "x-amadeus-memory": "1" },
      body: { action: "set-entity", entity: "Aster", weight: 1.4 }
    });
    assert.equal(setEntity.status, 200);
    assert.equal(setEntity.json.data.state.entities[0].entity_id, one.id);
    const ambiguous = h.store.createEntity({ name: "Aster", type: "person" });
    const conflict = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/preferences",
      headers: { "content-type": "application/json", "x-amadeus-memory": "1" },
      body: { action: "set-entity", entity: "Aster", weight: 1.2 }
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.candidates.length, 2);
    const reset = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/preferences",
      headers: { "content-type": "application/json", "x-amadeus-memory": "1" },
      body: { action: "reset" }
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.json.data.state.tags.length, 0);
    assert.equal(reset.json.data.state.entities.length, 0);
    assert.ok(ambiguous.id);
  } finally {
    h.close();
  }
});

test("vector endpoints preserve masked keys, expose no secret and only test on request", async () => {
  let calls = 0;
  const h = setup({ embedder: {
    name: "openai",
    model: "qwen-embed",
    async embedSingle() { calls++; return [0.1, 0.2, 0.3]; }
  } });
  try {
    h.settings.setVectorConfig({
      enabled: true, baseUrl: "https://example.invalid", apiKey: "synthetic-secret", model: "qwen-embed"
    });
    const read = await call(h.route, { url: "/api/amadeus-memory/admin/vector" });
    assert.equal(read.status, 200);
    assert.equal(read.json.data.api_key_configured, true);
    assert.equal(JSON.stringify(read.json).includes("synthetic-secret"), false);
    assert.equal(calls, 0, "reading status must not call the remote provider");
    const save = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/vector",
      headers: { "content-type": "application/json", "x-amadeus-memory": "1" },
      body: { enabled: true, baseUrl: "https://example.invalid", model: "qwen-embed", apiKey: read.json.data.api_key_masked }
    });
    assert.equal(save.status, 200);
    assert.equal(h.settings.getVectorConfig().apiKey, "synthetic-secret");
    assert.equal(save.json.data.restart_required, true);
    const probe = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/vector/test",
      headers: { "content-type": "application/json", "x-amadeus-memory": "1" },
      body: {}
    });
    assert.equal(probe.status, 200);
    assert.equal(probe.json.data.remote, true);
    assert.equal(probe.json.data.dimension, 3);
    assert.equal(calls, 1);
  } finally {
    h.close();
  }
});
