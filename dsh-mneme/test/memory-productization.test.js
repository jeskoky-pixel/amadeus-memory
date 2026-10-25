// Productization guards for the Memory bundle: release identity, native settings
// entry, owner API wiring and user-facing documentation. Synthetic/no runtime data.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Config } from "../src/config.js";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("Amadeus Memory release identity is explicit and backward compatible", () => {
  assert.equal(pkg.name, "@modusensus/dsh-mneme");
  assert.match(pkg.version, /^0\.9\.5-amadeus\.\d+$/);
  assert.equal(pkg.amadeus.edition, "enhanced");
  assert.equal(pkg.amadeus.product, "memory");
  assert.equal(pkg.amadeus.upstream, "@modusensus/dsh-mneme@0.9.4");
  assert.match(pkg.description, /Amadeus Memory/);
  assert.equal(pkg.license, "MIT");
  assert.equal(existsSync(join(root, "LICENSE")), true);
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
});

test("client declares the native settings integrations and page", () => {
  assert.ok(pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings"));
  assert.ok(pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-plugin-manager"));
  const client = readFileSync(join(root, "lib", "client.js"), "utf8");
  assert.match(client, /const inject = \["slots", "locale", "configForms"\]/);
  assert.match(client, /name:\s*["']settings\.section["']/);
  assert.match(client, /id:\s*["']amadeus-memory["']/);
  assert.match(client, /AmadeusMemorySettings/);
  assert.match(client, /\/api\/amadeus-memory\/admin/);
  assert.match(client, /configForms\.whileServed/);
});

test("native page Config Forms fields all exist in the published Config schema", () => {
  const keys = [
    "language", "dreamThresholdCount", "dreamThresholdChars", "dreamDelayMs",
    "sleepIdleMinutes", "maxInjectedItems", "importanceThreshold",
    "injectContentMaxChars", "injectRotationTurns", "vectorSearchTopK",
    "vectorSearchThreshold", "hybridSearchVectorWeight", "autoReindexOnBoot"
  ];
  for (const key of keys) {
    assert.ok(Config.dict?.[key], `Config field ${key} must exist`);
    assert.equal(Config.dict[key].meta?.volatile, true, `${key} must be served by DSH Config Forms`);
  }
  assert.notEqual(Config.dict?.memoryDir?.meta?.volatile, true, "memoryDir stays a restart-only base field");
});

test("native page exposes ordinary-user management, safety metadata and narrow layout", () => {
  const client = readFileSync(join(root, "lib", "client.js"), "utf8");
  for (const marker of [
    "memory.am.section.memories",
    "memory.am.section.backup",
    "memory.am.memory.deleteConfirm",
    "memory.am.backup.restoreHint",
    "memory.am.memory.autoArchived",
    "memory.am.default",
    "memory.am.range",
    "memory.am.unit.items",
    "memory.am.backup.ack",
    "@media (max-width:560px)",
    "memory.am.memory.stale"
  ]) assert.ok(client.includes(marker), `missing product UI marker: ${marker}`);
  assert.ok(client.includes('"memory.am.section.memories": "记忆管理"'), "Chinese label is required");
  assert.ok(client.includes('"memory.am.section.memories": "Memory management"'), "English label is required");
});

test("release and user documents exist for install, upgrade, rollback and performance", () => {
  const docs = [
    "docs/INSTALL.md",
    "docs/USER_GUIDE.zh.md",
    "docs/BACKUP_ROLLBACK.md",
    "docs/RELEASE_NOTES.md",
    "docs/PERFORMANCE.md"
  ];
  for (const file of docs) {
    assert.equal(existsSync(join(root, file)), true, file);
    const text = readFileSync(join(root, file), "utf8");
    assert.ok(text.trim().length > 200, `${file} should be substantive`);
  }
});
