// P0 QA guard: a test/install-verification memoryDir must be an explicit child
// of a caller-selected QA root and must not resolve (via symlink/junction, case,
// or a traversal/alias) into a known user Memory directory.
//
// This is deliberately not imported by the production apply() path: an end
// user's config may legitimately point at the historical ~/.dsh/memory. QA and
// package-verification scripts must call this before creating a store/plugin.

import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

const WINDOWS = process.platform === "win32";

export class QaGuardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "QaGuardError";
    this.code = code;
    Object.assign(this, details);
  }
}

function stripLongPath(path) {
  return WINDOWS ? path.replace(/^\\\\\?\\/, "") : path;
}

function canonical(path) {
  try {
    return stripLongPath(normalize(realpathSync.native(path)));
  } catch (error) {
    throw new QaGuardError("QA_PATH_IDENTITY_UNRESOLVED", `cannot resolve path identity: ${path}`, {
      path, cause: String(error?.message ?? error)
    });
  }
}

function comparable(path) {
  const normalized = normalize(stripLongPath(path));
  return WINDOWS ? normalized.toLowerCase() : normalized;
}

function withinOrEqual(parent, candidate) {
  const rel = relative(comparable(parent), comparable(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}

function strictChild(parent, candidate) {
  const rel = relative(comparable(parent), comparable(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

export function knownForbiddenMemoryDirs(extra = []) {
  const defaults = [join(homedir(), ".dsh", "memory")];
  const seen = new Set();
  return [...defaults, ...extra]
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => resolve(item))
    .filter((item) => {
      const key = comparable(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Canonicalize and validate a QA memoryDir.
 *
 * @param {string} memoryDir explicit target; created only after a safe lexical
 *   and canonical-parent check.
 * @param {object} options
 * @param {string} options.qaRoot explicit existing QA root.
 * @param {string[]} options.forbiddenDirs additional known user/private roots.
 * @returns {string} canonical memoryDir.
 */
export function assertIsolatedMemoryDir(memoryDir, { qaRoot, forbiddenDirs = [] } = {}) {
  if (typeof qaRoot !== "string" || !qaRoot.trim() || !isAbsolute(qaRoot)) {
    throw new QaGuardError("QA_ROOT_REQUIRED", "an explicit absolute QA root is required");
  }
  if (typeof memoryDir !== "string" || !memoryDir.trim() || !isAbsolute(memoryDir)) {
    throw new QaGuardError("QA_MEMORY_DIR_REQUIRED", "an explicit absolute memoryDir is required");
  }
  if (!existsSync(qaRoot) || !statSync(qaRoot).isDirectory()) {
    throw new QaGuardError("QA_ROOT_UNRESOLVED", "QA root must exist as a directory", { qaRoot });
  }
  const root = canonical(qaRoot);
  if (!statSync(root).isDirectory()) {
    throw new QaGuardError("QA_ROOT_UNRESOLVED", "QA root does not resolve to a directory", { qaRoot });
  }
  const forbidden = knownForbiddenMemoryDirs(forbiddenDirs).map((item) => resolve(item));

  // Lexical identity is checked before mkdir, so a path that names a user
  // directory is rejected without creating anything there.
  if (forbidden.some((bad) => withinOrEqual(bad, memoryDir))) {
    throw new QaGuardError("QA_PATH_IS_USER_MEMORY", "memoryDir is a known user Memory directory", { memoryDir });
  }
  if (!strictChild(root, memoryDir)) {
    throw new QaGuardError("QA_PATH_OUTSIDE_ROOT", "memoryDir must be a strict child of the QA root", {
      memoryDir: resolve(memoryDir), qaRoot: root
    });
  }

  // Resolve the nearest existing ancestor before creating the target. This
  // catches a symlink/junction in the parent chain that escapes the QA root or
  // aliases a known user directory, without writing through it.
  let ancestor = resolve(memoryDir);
  while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
  if (ancestor === dirname(ancestor) && !existsSync(ancestor)) {
    throw new QaGuardError("QA_PATH_IDENTITY_UNRESOLVED", "no existing ancestor for memoryDir", { memoryDir });
  }
  const canonicalAncestor = canonical(ancestor);
  const candidate = join(canonicalAncestor, relative(ancestor, memoryDir));
  if (forbidden.some((bad) => withinOrEqual(bad, candidate))) {
    throw new QaGuardError("QA_PATH_IS_USER_MEMORY", "resolved memoryDir aliases a known user Memory directory", {
      memoryDir, resolved: candidate
    });
  }
  if (!strictChild(root, candidate)) {
    throw new QaGuardError("QA_PATH_OUTSIDE_ROOT", "resolved memoryDir escapes the QA root", {
      memoryDir, resolved: candidate, qaRoot: root
    });
  }

  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
  if (!statSync(memoryDir).isDirectory()) {
    throw new QaGuardError("QA_PATH_NOT_DIRECTORY", "memoryDir exists but is not a directory", { memoryDir });
  }
  const resolved = canonical(memoryDir);
  if (!statSync(resolved).isDirectory()) {
    throw new QaGuardError("QA_PATH_NOT_DIRECTORY", "memoryDir does not resolve to a directory", { memoryDir });
  }
  if (!strictChild(root, resolved)) {
    throw new QaGuardError("QA_PATH_OUTSIDE_ROOT", "final memoryDir escapes the QA root", {
      memoryDir, resolved, qaRoot: root
    });
  }
  if (forbidden.some((bad) => withinOrEqual(bad, resolved))) {
    throw new QaGuardError("QA_PATH_IS_USER_MEMORY", "final memoryDir aliases a known user Memory directory", {
      memoryDir, resolved
    });
  }
  return resolved;
}

export const __qaGuardInternals = { canonical, comparable, withinOrEqual, strictChild, stripLongPath };
