#!/usr/bin/env node
// QA/install preflight. Run this BEFORE creating a store or booting a Memory
// Profile. It creates only the selected safe child directory, never a DB.
import { assertIsolatedMemoryDir, knownForbiddenMemoryDirs, QaGuardError } from "../src/qa-guard.js";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const qaRoot = arg("--qa-root");
const memoryDir = arg("--memory-dir");
const extra = [];
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] === "--forbid" && process.argv[i + 1]) extra.push(process.argv[i + 1]);
}

try {
  const resolved = assertIsolatedMemoryDir(memoryDir, { qaRoot, forbiddenDirs: extra });
  console.log(JSON.stringify({ ok: true, qaRoot, memoryDir: resolved, forbidden: knownForbiddenMemoryDirs(extra) }, null, 2));
} catch (error) {
  const code = error instanceof QaGuardError ? error.code : "QA_GUARD_FAILED";
  console.error(JSON.stringify({ ok: false, code, error: String(error?.message ?? error) }, null, 2));
  process.exitCode = 1;
}
