// Safe removal of the local .test-tmp directory. Never follows a symlink or
// Windows junction, and only removes the exact canonical child of repoRoot.
import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, join, relative } from "node:path";

export class SafeCleanupError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SafeCleanupError";
    this.code = code;
    Object.assign(this, details);
  }
}

function comparable(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function removeNoFollow(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    // unlink works for file symlinks; rmdir removes a Windows junction without
    // touching its target.
    try { unlinkSync(path); } catch { rmdirSync(path); }
    return;
  }
  // Windows junctions may report isDirectory()===true rather than
  // isSymbolicLink(). Compare the real target with the lexical child; a
  // mismatch is an alias and must be unlinked, never recursed into.
  try {
    const resolved = realpathSync.native(path);
    if (comparable(resolved) !== comparable(path)) {
      try { unlinkSync(path); } catch { rmdirSync(path); }
      return;
    }
  } catch {
    try { unlinkSync(path); } catch { rmdirSync(path); }
    return;
  }
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) removeNoFollow(join(path, name));
    rmdirSync(path);
    return;
  }
  unlinkSync(path);
}

export function removeTestTmp(repoRoot = process.cwd(), name = ".test-tmp") {
  const root = realpathSync.native(repoRoot);
  const expected = join(root, name);
  let stat;
  try { stat = lstatSync(expected); } catch { return false; }
  if (stat.isSymbolicLink()) {
    throw new SafeCleanupError("QA_CLEAN_ALIAS", "refusing to delete a .test-tmp symlink/junction", { target: expected });
  }
  if (!stat.isDirectory()) {
    throw new SafeCleanupError("QA_CLEAN_NOT_DIRECTORY", ".test-tmp is not a directory", { target: expected });
  }
  const resolved = realpathSync.native(expected);
  const rel = relative(root, resolved);
  if (rel !== name || rel.startsWith("..") || comparable(resolved) !== comparable(expected)) {
    throw new SafeCleanupError("QA_CLEAN_OUTSIDE", "resolved .test-tmp is outside the repo root", {
      target: expected, resolved
    });
  }
  removeNoFollow(expected);
  return true;
}
