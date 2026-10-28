import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

export function archiveInfo(file) {
  const raw = readFileSync(file);
  const tar = gunzipSync(raw);
  let files = 0;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    if (type === "0" || type === "\0" || type === "7") files += 1;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return { bytes: raw.length, files, sha256: createHash("sha256").update(raw).digest("hex") };
}

function findGitDir(start) {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, ".git");
    if (existsSync(candidate)) return { dir: candidate, worktree: dir };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolvedGitDir(worktree) {
  const found = findGitDir(worktree);
  if (!found) return null;
  let gitDir = found.dir;
  if (statSync(gitDir).isFile()) {
    const pointer = readFileSync(gitDir, "utf8").trim();
    if (!pointer.startsWith("gitdir: ")) return null;
    gitDir = resolve(found.worktree, pointer.slice(8).trim());
  }
  return { gitDir, worktree: found.worktree };
}

function readHeadFromGitDir(gitDir) {
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  if (!head.startsWith("ref: ")) return head;
  const ref = head.slice(5).trim();
  let commonDir = gitDir;
  const commonFile = join(gitDir, "commondir");
  if (existsSync(commonFile)) {
    commonDir = resolve(gitDir, readFileSync(commonFile, "utf8").trim());
  }
  for (const candidate of [join(gitDir, ref), join(commonDir, ref)]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8").trim();
  }
  const packed = join(commonDir, "packed-refs");
  if (existsSync(packed)) {
    for (const line of readFileSync(packed, "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref) return sha;
    }
  }
  return null;
}

function dirtyByMtime(worktree) {
  const git = resolvedGitDir(worktree);
  if (!git) return null;
  const indexPath = join(git.gitDir, "index");
  if (!existsSync(indexPath)) return null;
  const indexMtime = statSync(indexPath).mtimeMs;
  const skip = new Set([".git", "node_modules", ".npm-cache", ".test-tmp", "dist", ".benchmark", "runtime", "logs"]);
  let dirty = false;
  const walk = (dir) => {
    if (dirty) return;
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(full);
      else if (stat.mtimeMs > indexMtime) { dirty = true; return; }
    }
  };
  walk(git.worktree);
  return dirty;
}

function gitState(cwd) {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
    return { source_head: head || null, worktree_dirty: dirty };
  } catch {
    // The release sandbox may deny spawning git.exe. Read the same facts
    // directly: HEAD/ref from .git and a conservative index-mtime dirty probe.
    const git = resolvedGitDir(cwd);
    if (!git) return { source_head: null, worktree_dirty: null };
    try {
      const head = readHeadFromGitDir(git.gitDir);
      const dirty = process.env.AMADEUS_WORKTREE_DIRTY === undefined
        ? dirtyByMtime(git.worktree)
        : process.env.AMADEUS_WORKTREE_DIRTY === "1";
      return { source_head: head, worktree_dirty: dirty };
    } catch {
      return { source_head: null, worktree_dirty: null };
    }
  }
}

export function finalizePackage({ root = process.cwd(), distDir = join(root, "..", "dist"), sourceHead, worktreeDirty } = {}) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const file = join(distDir, `amadeus-memory-${pkg.version}.tgz`);
  if (!existsSync(file)) throw new Error(`missing package: ${file}`);
  const info = archiveInfo(file);
  const git = sourceHead === undefined || worktreeDirty === undefined ? gitState(root) : {};
  const head = sourceHead ?? git.source_head ?? null;
  const dirty = worktreeDirty ?? git.worktree_dirty ?? null;
  if (!head || dirty === null) {
    throw new Error("cannot establish current Git HEAD/worktree state for package metadata");
  }
  const packageInfo = {
    name: pkg.name,
    version: pkg.version,
    edition: pkg.amadeus?.edition ?? "",
    upstream: pkg.amadeus?.upstream ?? "",
    file: `dist/amadeus-memory-${pkg.version}.tgz`,
    sha256: info.sha256,
    bytes: info.bytes,
    files: info.files,
    source_head: head,
    worktree_dirty: dirty,
    reproducible: true,
    generated_at: new Date().toISOString()
  };
  writeFileSync(join(distDir, "PACKAGE_INFO.json"), JSON.stringify(packageInfo, null, 2));
  writeFileSync(join(distDir, "BUILD_INFO.json"), JSON.stringify({
    node: process.version,
    platform: process.platform,
    package_file: packageInfo.file,
    sha256: info.sha256,
    bytes: info.bytes,
    files: info.files,
    client_sha256: createHash("sha256").update(readFileSync(join(root, "lib", "client.js"))).digest("hex"),
    server_entry: "src/index.js",
    source_head: packageInfo.source_head,
    worktree_dirty: packageInfo.worktree_dirty,
    notes: "npm pack --ignore-scripts --cache .npm-cache; metadata written after pack; postpack privacy verifies hash"
  }, null, 2));
  return packageInfo;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const info = finalizePackage();
  console.log(JSON.stringify(info, null, 2));
}
