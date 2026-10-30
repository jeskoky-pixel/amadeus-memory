// Cross-platform Amadeus product quality runner. It imports the selected test
// files into one Node process, so it works even when the host sandbox forbids
// the per-file child process spawning used by `node --test`.
//
// Upstream-only release pipeline/workflow tests are deliberately excluded; use
// `npm run test:upstream-release` to run and report them separately.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { removeTestTmp, SafeCleanupError } from "./safe-test-tmp.mjs";

function cleanupTmp() {
  try {
    removeTestTmp(process.cwd());
  } catch (error) {
    console.error(`QUALITY CLEANUP REFUSED: ${error instanceof SafeCleanupError ? error.code : "ERROR"} ${String(error?.message ?? error)}`);
    return false;
  }
  return true;
}
if (!cleanupTmp()) process.exit(1);
process.once("beforeExit", () => { cleanupTmp(); });

const files = [
  "test/qa-guard.test.js",
  "test/safe-clean.test.js",
  "test/store-concurrent-init.test.js",
  "test/schema-version.test.js",
  "test/release-package-workflow.test.js",
  "test/scene-recent-core.test.js",
  "test/unified-session-acl.test.js",
  "test/unified-runtime.test.js",
  "test/unified-background.test.js",
  "test/amadeus-memory-service.test.js",
  "test/route-policy.test.js",
  "test/scene-acl-tools.test.js",
  "test/qq-host-inject.test.js",
  "test/qq-model-boundary.test.js",
  "test/workspace-gate.test.js",
  "test/workspace-binding.test.js",
  "test/workspace-runtime.test.js",
  "test/workspace-hooks.test.js",
  "test/admin-workspace.test.js",
  "test/client-workspace.test.js",
  "test/recent-activity.test.js",
  "test/recent-runtime.test.js",
  "test/admin-recent.test.js",
  "test/client-recent.test.js",
  "test/lite-runtime-convergence.test.js",
  "test/summarize-scene-gate.test.js",
  "test/summarize-scene-contract.test.js",
  "test/backup.test.js",
  "test/memory-management-api.test.js",
  "test/lifecycle-productization.test.js",
  "test/client.test.js",
  "test/memory-productization.test.js",
  "test/memory-admin-api.test.js",
  "test/api.test.js",
  "test/service.test.js",
  "test/settings.test.js",
  "test/store.test.js",
  "test/vector-index.test.js",
  "test/semantic.test.js",
  "test/inject.test.js",
  "test/webServer-optional.test.js",
  "test/identity.test.js",
  "test/preferences.test.js",
  "test/trusted-intake.test.js",
  "test/memory-enhancer-api.test.js",
  "test/memory-enhancer-identity-continuity.test.js",
  "test/memory-enhancer-quality-extra.test.js",
  "test/memory-enhancer-quality-regressions.test.js",
  "test/memory-enhancer-retrieval.test.js",
  "test/memory-enhancer-tools.test.js",
  "test/tools.test.js",
  "test/baseline-persist.test.js",
  "test/scope-storage.test.js",
  "test/reindex-backfill.test.js",
  "test/security-doc.test.js",
  "test/release-docs.test.js",
  "test/readme-claims.test.js",
  "test/test-count-sync.test.js",
  "test/lib-smoke.test.js",
  "test/docs-config-keys.test.js"
];

for (const file of files) {
  try {
    await import(pathToFileURL(join(process.cwd(), file)).href);
  } catch (error) {
    console.error(`QUALITY IMPORT FAILED ${file}: ${String(error?.stack ?? error)}`);
    process.exitCode = 1;
  }
}
