// Codex acceptance regressions for trusted events and Life retry semantics.
// All identifiers and content in this file are synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

function makeService(path = ":memory:") {
  const store = createStore(path);
  const service = createService({ store, mirror: null, config: { trustedIntakeEnabled: true } });
  return { store, service, close: () => store.close() };
}

function experience(overrides = {}) {
  return {
    kind: "self_action",
    status: "completed",
    participation: "agent",
    trust_source: "system",
    actor: "life-synthetic",
    title: "Completed synthetic task",
    content: "Life completed a synthetic task with a receipt.",
    scope: { agent_scope: "amadeus", workspace_scope: "life-test" },
    evidence: [{ kind: "receipt", value: "synthetic-1" }],
    ...overrides
  };
}

function eventTags(tags) {
  return tags.filter((tag) => String(tag).normalize("NFKC").trim().toLowerCase().startsWith("event:"));
}

test("ordinary save cannot mint trusted events by spoofing source or Unicode tag spelling", () => {
  const h = makeService();
  try {
    const saved = h.service.saveWithDedupe({
      type: "history", title: "Untrusted synthetic save", content: "Ordinary note.",
      source: "trusted_intake",
      tags: ["event:self_action", "Event:Self_Action", "ｅｖｅｎｔ：ｓｅｌｆ＿ａｃｔｉｏｎ", "custom"]
    });
    assert.deepEqual(eventTags(saved.memory.tags), []);
    assert.ok(saved.memory.tags.includes("custom"));
    assert.equal(h.service.trustedProvenanceFor(saved.memory.id).length, 0);
  } finally {
    h.close();
  }
});

test("ordinary update cannot replace a valid event claim or its evidence", () => {
  const h = makeService();
  try {
    const trusted = h.service.submitTrustedMemory(experience());
    const updated = h.service.update(trusted.memory.id, {
      tags: ["custom", "event:observation", "ＥＶＥＮＴ：ＲＥＰＯＲＴＥＤ＿ＢＹ＿ＯＴＨＥＲ"]
    });
    assert.deepEqual(eventTags(updated.tags), ["event:self_action"]);
    assert.ok(updated.tags.includes("custom"));
    const evidence = h.service.trustedProvenanceFor(trusted.memory.id);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].kind, "self_action");
  } finally {
    h.close();
  }
});

test("an ordinary title-dedupe merge cannot erase an existing trusted event claim", () => {
  const h = makeService();
  try {
    const trusted = h.service.submitTrustedMemory(experience());
    const merged = h.service.saveWithDedupe({
      type: "history",
      title: trusted.memory.title,
      content: "A later ordinary note about the same synthetic task.",
      agent_scope: "amadeus",
      workspace_scope: "life-test",
      tags: ["custom"],
      source: "tool"
    });
    assert.equal(merged.memory.id, trusted.memory.id);
    assert.deepEqual(eventTags(merged.memory.tags), ["event:self_action"]);
    assert.equal(h.service.trustedProvenanceFor(trusted.memory.id).length, 1);
  } finally {
    h.close();
  }
});

test("trusted intake rejects an extra event tag before writing any memory or provenance", () => {
  const h = makeService();
  try {
    assert.throws(
      () => h.service.submitTrustedMemory(experience({
        request_id: "bad-extra-tag",
        tags: ["custom", "event:observation"]
      })),
      (error) => error?.name === "IntakeError"
    );
    assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n, 0);
    assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM memory_trusted_provenance").get().n, 0);
  } finally {
    h.close();
  }
});

test("repeating the same request_id returns the original experience and provenance", () => {
  const h = makeService();
  try {
    const request = experience({ request_id: "retry-1" });
    const first = h.service.submitTrustedMemory(request);
    const again = h.service.submitTrustedMemory(request);
    assert.equal(again.memory.id, first.memory.id);
    assert.equal(again.provenance.id, first.provenance.id);
    assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n, 1);
    assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM memory_trusted_provenance").get().n, 1);
  } finally {
    h.close();
  }
});

test("a request_id reused with different content is rejected without changing stored data", () => {
  const h = makeService();
  try {
    const first = h.service.submitTrustedMemory(experience({ request_id: "conflict-1" }));
    const original = h.store.getById(first.memory.id);
    assert.throws(
      () => h.service.submitTrustedMemory(experience({
        request_id: "conflict-1", content: "A different synthetic activity."
      })),
      (error) => error?.name === "IntakeError" && error.code === "request-id-conflict"
    );
    assert.deepEqual(h.store.getById(first.memory.id), original);
    assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n, 1);
    assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM memory_trusted_provenance").get().n, 1);
  } finally {
    h.close();
  }
});

test("different request IDs with the same title remain distinct real experiences", () => {
  const h = makeService();
  try {
    const first = h.service.submitTrustedMemory(experience({ request_id: "activity-1" }));
    const second = h.service.submitTrustedMemory(experience({
      request_id: "activity-2", content: "Life completed another synthetic task with a second receipt.",
      evidence: [{ kind: "receipt", value: "synthetic-2" }]
    }));
    assert.notEqual(second.memory.id, first.memory.id);
    assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n, 2);
    assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM memory_trusted_provenance").get().n, 2);
  } finally {
    h.close();
  }
});

test("a retry after reopening SQLite remains idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-intake-restart-"));
  const path = join(dir, "memory.db");
  const request = experience({ request_id: "restart-1" });
  try {
    const firstHandle = makeService(path);
    const first = firstHandle.service.submitTrustedMemory(request);
    firstHandle.close();
    const secondHandle = makeService(path);
    try {
      const again = secondHandle.service.submitTrustedMemory(request);
      assert.equal(again.memory.id, first.memory.id);
      assert.equal(again.provenance.id, first.provenance.id);
      assert.equal(secondHandle.store.db.prepare("SELECT COUNT(*) AS n FROM memory_trusted_provenance").get().n, 1);
    } finally {
      secondHandle.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a provenance insert failure rolls back the accompanying memory", () => {
  const h = makeService();
  try {
    h.store.db.exec(`
      CREATE TRIGGER reject_synthetic_provenance
      BEFORE INSERT ON memory_trusted_provenance
      BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;
    `);
    assert.throws(() => h.service.submitTrustedMemory(experience({ request_id: "rollback-1" })));
    assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n, 0);
    assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM memory_trusted_provenance").get().n, 0);
  } finally {
    h.close();
  }
});

test("legacy no-request-id intake keeps its existing title dedupe behavior", () => {
  const h = makeService();
  try {
    const first = h.service.submitTrustedMemory(experience());
    const second = h.service.submitTrustedMemory(experience({ content: "A follow-up about the same synthetic task." }));
    assert.equal(second.memory.id, first.memory.id);
    assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM memory_trusted_provenance").get().n, 2);
  } finally {
    h.close();
  }
});
