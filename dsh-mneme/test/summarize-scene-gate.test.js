import test from "node:test";
import assert from "node:assert/strict";
import { createSummarizer } from "../src/summarize.js";

test("active summarizer suppresses derivation when tagged rows appear later", async () => {
  let tagged = false;
  let writes = 0;
  const service = {
    hasSceneScopedRows: () => tagged,
    saveWithDedupe: () => { writes += 1; return { memory: { id: "x" } }; },
    saveLlmAudit: () => {},
    getDistillCursor: () => null,
    setDistillCursor: () => {}
  };
  const handlers = new Map();
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    on(event, handler) { handlers.set(event, handler); return () => {}; }
  };
  const summarizer = createSummarizer(ctx, service, {
    autoSummarize: true,
    sceneIsolationEnabled: false,
    sceneStrictQQ: false,
    summarizeProvider: "",
    summarizeModel: ""
  });
  try {
    assert.equal(tagged, false);
    tagged = true; // first private row arrives after the summarizer registered
    await handlers.get("session/event")(
      { id: "late-scene", requestHeader: () => ({ config: {} }), snapshotEvents: () => [] },
      { type: "turn/end", seq: 1 }
    );
    assert.equal(writes, 0, "no cross-scene derivation may start after a tagged row arrives");
  } finally {
    summarizer.dispose();
  }
});
