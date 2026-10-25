// Explicit, non-green capability probe for Windows-only environment limits.
// It does not touch Memory storage or any user/QA database.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "amadeus-memory-compat-"));
const checks = { platform: process.platform, node: process.version };
try {
  writeFileSync(join(dir, "target.txt"), "synthetic");
  try {
    symlinkSync(join(dir, "target.txt"), join(dir, "file-link"), "file");
    checks.existingFileSymlink = true;
    checks.existingFileSymlinkCode = null;
  } catch (error) {
    checks.existingFileSymlink = false;
    checks.existingFileSymlinkCode = String(error?.code ?? "ERROR");
  }
  try {
    symlinkSync(join(dir, "missing-target"), join(dir, "dangling-link"), "file");
    checks.danglingSymlink = true;
    checks.danglingSymlinkCode = null;
  } catch (error) {
    checks.danglingSymlink = false;
    checks.danglingSymlinkCode = String(error?.code ?? "ERROR");
  }
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    stdio: ["ignore", "pipe", "pipe"], timeout: 10_000
  });
  checks.childSpawnWithPipes = child.status === 0 && !child.error;
  checks.childSpawnCode = child.error ? String(child.error.code ?? child.error.message) : null;
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
const ok = checks.existingFileSymlink && checks.danglingSymlink && checks.childSpawnWithPipes;
console.log(JSON.stringify({ ok, checks, note: "non-green capability probe; not a product test" }, null, 2));
if (!ok) process.exitCode = 1;
