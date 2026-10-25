// Trusted own-experience intake (Amadeus memory enhancer). Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi } from "../src/api.js";

function setup(config = { trustedIntakeEnabled: true }) {
  const dir = mkdtempSync(join(tmpdir(), "mneme-intake-"));
  const store = createStore(join(dir, "memory.db"));
  const service = createService({ store, mirror: null, config });
  return {
    dir, store, service,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const base = () => ({
  kind: "self_action",
  status: "completed",
  participation: "agent",
  trust_source: "system",
  actor: "life-test",
  title: "Ordered synthetic supplies",
  content: "Life ordered synthetic supplies for the workshop.",
  scope: { agent_scope: "global", workspace_scope: "global" },
  evidence: [{ kind: "receipt", value: "synthetic-receipt-1" }]
});

test("event tags cannot be minted through the normal save path", () => {
  const h = setup();
  try {
    const normal = h.service.saveWithDedupe({
      type: "history", title: "Synthetic casual note", content: "Synthetic casual note.",
      tags: ["event:self_action", "custom"], importance: 2
    });
    assert.equal(normal.memory.tags.includes("event:self_action"), false);
    assert.equal(normal.memory.tags.includes("custom"), true);
    const trusted = h.service.submitTrustedMemory(base());
    assert.equal(trusted.memory.tags.includes("event:self_action"), true);
  } finally {
    h.close();
  }
});

test("valid self action saves provenance, explicit scope and a deterministic event tag", () => {
  const h = setup();
  try {
    const out = h.service.submitTrustedMemory(base());
    assert.equal(out.action, "created");
    assert.deepEqual(out.derived_tags, ["event:self_action"]);
    assert.equal(out.memory.tags.includes("event:self_action"), true);
    assert.equal(out.memory.agent_scope_source, "explicit");
    assert.equal(out.memory.workspace_scope_source, "explicit");
    const provenance = h.service.trustedProvenanceFor(out.memory.id);
    assert.equal(provenance.length, 1);
    assert.equal(provenance[0].kind, "self_action");
    assert.equal(provenance[0].status, "completed");
    assert.equal(provenance[0].actor, "life-test");
    assert.deepEqual(provenance[0].evidence, [{ kind: "receipt", value: "synthetic-receipt-1" }]);
    // Normal store behavior applies: archive keeps provenance readable.
    h.service.setArchived(out.memory.id, true);
    assert.equal(h.store.getById(out.memory.id).archived, true);
    assert.equal(h.service.trustedProvenanceFor(out.memory.id).length, 1);
  } finally {
    h.close();
  }
});

test("planned/unconfirmed actions, absent scope and kind/status mismatches are rejected", () => {
  const h = setup();
  try {
    for (const status of ["planned", "unconfirmed", "pending", ""]) {
      assert.throws(
        () => h.service.submitTrustedMemory({ ...base(), status }),
        (error) => error.name === "IntakeError" && error.code === "invalid-status",
        `status ${JSON.stringify(status)} must not be recorded as completed`
      );
    }
    assert.throws(
      () => h.service.submitTrustedMemory({ ...base(), scope: undefined }),
      (error) => error.code === "missing-scope"
    );
    assert.throws(
      () => h.service.submitTrustedMemory({ ...base(), scope: { agent_scope: "global" } }),
      (error) => error.code === "missing-scope"
    );
    assert.throws(
      () => h.service.submitTrustedMemory({ ...base(), participation: "observed" }),
      (error) => error.code === "invalid-participation"
    );
    assert.throws(
      () => h.service.submitTrustedMemory({ ...base(), trust_source: "trusted_contact" }),
      (error) => error.code === "invalid-trust-source"
    );
    assert.throws(
      () => h.service.submitTrustedMemory({
        ...base(), kind: "reported_by_other", participation: "none", trust_source: "trusted_contact"
      }),
      (error) => error.code === "invalid-status",
      "a report of someone else's action cannot be marked first-person completed"
    );
    assert.throws(
      () => h.service.submitTrustedMemory({ ...base(), importance: 9 }),
      (error) => error.code === "invalid-importance"
    );
    assert.equal(h.store.db.prepare("SELECT COUNT(*) AS c FROM memories").get().c, 0);
    assert.equal(h.store.db.prepare("SELECT COUNT(*) AS c FROM memory_trusted_provenance").get().c, 0);
  } finally {
    h.close();
  }
});

test("reported-by-other uses status=reported and keeps its own event tag", () => {
  const h = setup();
  try {
    const out = h.service.submitTrustedMemory({
      ...base(),
      kind: "reported_by_other",
      status: "reported",
      participation: "none",
      trust_source: "trusted_contact",
      actor: "test-contact",
      title: "Contact reported a synthetic delay",
      content: "The trusted contact reported that the synthetic delivery was delayed."
    });
    assert.equal(out.memory.tags.includes("event:reported_by_other"), true);
    assert.equal(out.provenance.status, "reported");
    assert.equal(out.provenance.trust_source, "trusted_contact");
  } finally {
    h.close();
  }
});

test("dedupe reuses the normal path and unions the derived tag instead of dropping tags", () => {
  const h = setup();
  try {
    const first = h.service.submitTrustedMemory({ ...base(), tags: ["custom"] });
    const second = h.service.submitTrustedMemory(base());
    assert.equal(second.action, "merged");
    assert.equal(second.memory.id, first.memory.id);
    assert.equal(second.memory.tags.includes("custom"), true);
    assert.equal(second.memory.tags.includes("event:self_action"), true);
    assert.equal(h.service.trustedProvenanceFor(first.memory.id).length, 2);
    // Dedupe does not mutate the first provenance row.
    const rows = h.service.trustedProvenanceFor(first.memory.id);
    assert.equal(new Set(rows.map((row) => row.id)).size, 2);
  } finally {
    h.close();
  }
});

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}
function fakeReq(method, body = null, headers = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req.url = "/api/dsh-mneme/intake";
  if (body !== null) {
    const text = JSON.stringify(body);
    process.nextTick(() => { req.emit("data", Buffer.from(text)); req.emit("end"); });
  } else {
    process.nextTick(() => req.emit("end"));
  }
  return req;
}
function apiSetup(config = { trustedIntakeEnabled: true }, token = "secret-token") {
  const h = setup(config);
  const routes = [];
  const api = createApi(
    { webServer: { register(route) { routes.push(route); return () => {}; } } },
    h.service, createSettings(h.store.db),
    { add() {}, remove() {}, list: () => [] },
    null, undefined, token, config
  );
  const route = routes.find((r) => r.path === "/api/dsh-mneme/intake");
  return { ...h, routes, api, route };
}

test("intake route requires an authenticated write and refuses to run fail-open", async () => {
  const h = apiSetup({ trustedIntakeEnabled: true }, "secret-token");
  try {
    const denied = new FakeRes();
    await h.route.handler(fakeReq("POST", base()), denied);
    assert.equal(denied.statusCode, 401);

    const noTokenConfigured = apiSetup({ trustedIntakeEnabled: true }, "");
    try {
      const failOpen = new FakeRes();
      await noTokenConfigured.route.handler(fakeReq("POST", base()), failOpen);
      assert.equal(failOpen.statusCode, 503);
      assert.equal(JSON.parse(failOpen.body).error, "api-token-required");
    } finally {
      noTokenConfigured.close();
    }

    const ok = new FakeRes();
    await h.route.handler(fakeReq("POST", base(), { authorization: "Bearer secret-token" }), ok);
    assert.equal(ok.statusCode, 200);
    const body = JSON.parse(ok.body);
    assert.equal(body.provenance.kind, "self_action");

    const disabled = apiSetup({ trustedIntakeEnabled: false });
    try {
      const off = new FakeRes();
      await disabled.route.handler(fakeReq("POST", base(), { authorization: "Bearer secret-token" }), off);
      assert.equal(off.statusCode, 409);
    } finally {
      disabled.close();
    }

    const bad = new FakeRes();
    await h.route.handler(fakeReq("POST", { ...base(), status: "planned" }, { authorization: "Bearer secret-token" }), bad);
    assert.equal(bad.statusCode, 400);
    assert.equal(JSON.parse(bad.body).error, "invalid-status");

    const get = new FakeRes();
    await h.route.handler(fakeReq("GET", null, { authorization: "Bearer secret-token" }), get);
    assert.equal(get.statusCode, 405);
  } finally {
    h.close();
  }
});
