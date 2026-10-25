import { removeTestTmp, SafeCleanupError } from "./safe-test-tmp.mjs";

try {
  const removed = removeTestTmp(process.cwd());
  console.log(removed ? "cleaned .test-tmp" : "no .test-tmp");
} catch (error) {
  console.error(`refusing cleanup: ${error instanceof SafeCleanupError ? error.code : "ERROR"} ${String(error?.message ?? error)}`);
  process.exitCode = 1;
}
