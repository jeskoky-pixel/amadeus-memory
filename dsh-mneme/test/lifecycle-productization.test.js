// Disable/enable/reinstall lifecycle with an explicit isolated memoryDir.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import * as mneme from "../src/index.js";
import { createStore } from "../src/store.js";
import { assertIsolatedMemoryDir } from "../src/qa-guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", ".test-tmp");
mkdirSync(ROOT, { recursive: true });

function host() {
  const ctx = new Context();
  const routes = [];
  ctx.provide("tools", { register() { return () => {}; } });
  ctx.provide("commands", { register() { return () => {}; } });
  ctx.provide("systemPrompt", { context() { return () => {}; }, section() { return () => {}; } });
  ctx.provide("agentDefaultModel", { currentSelection() { return { provider: "mock", model: "mock" }; } });
  ctx.provide("llm", { async *stream() { yield { type: "finish", reason: { kind: "stop" } }; } });
  ctx.provide("webServer", { register(route) { routes.push(route); return () => {}; } });
  ctx.provide("connection", { admit() { return { peer: { principal: { kind: "owner" } } }; } });
  return { ctx, routes };
}

test("disable and re-enable keeps the explicit memory database and route count stable", async () => {
  const dir = assertIsolatedMemoryDir(
    join(ROOT, `lifecycle-${process.pid}-${Date.now()}`),
    { qaRoot: ROOT }
  );
  try {
    const seeded = createStore(join(dir, "memory.db"));
    seeded.save({ type: "project", title: "lifecycle seed", content: "synthetic" });
    seeded.db.close();

    const first = host();
    const firstFiber = first.ctx.plugin(mneme, {
      memoryDir: dir, autoDream: false, sleepModeEnabled: false, autoReindexOnBoot: false
    });
    await firstFiber;
    assert.ok(first.routes.length >= 2, "plugin registers API and admin routes");
    const firstCount = first.routes.length;
    await firstFiber.dispose();

    const second = host();
    const secondFiber = second.ctx.plugin(mneme, {
      memoryDir: dir, autoDream: false, sleepModeEnabled: false, autoReindexOnBoot: false
    });
    await secondFiber;
    assert.equal(second.routes.length, firstCount, "reinstall must not duplicate routes");
    await secondFiber.dispose();

    const reopened = createStore(join(dir, "memory.db"));
    try {
      assert.equal(reopened.count(), 1, "disable/re-enable must preserve memories");
    } finally {
      reopened.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
