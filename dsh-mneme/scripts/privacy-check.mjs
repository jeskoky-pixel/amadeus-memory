// Local privacy / release hygiene check. No network, no production reads.
// Run from dsh-mneme/ before packing: node scripts/privacy-check.mjs
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const root = process.cwd();
const forbidden = [
  /^\.env(?:\.|$)/,
  /\.(?:db|db-wal|db-shm|sqlite|log|secret|pem|key)$/i,
  /^id_rsa/i,
  /credentials/i,
  /^\.test-tmp$/,
  /^\.tmp-/,
  /^\.productization-task$/
];
const problems = [];
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".txt", ".toml", ".ps1", ".sh", ".bat"]);
const SYNTHETIC_ALLOW = new Set([
  "test/sensitive-scan.test.js",
  "package/test/sensitive-scan.test.js",
  "test/helpers/write-admission-samples.js",
  "package/test/helpers/write-admission-samples.js"
]);
const username = basename(homedir());
const privatePaths = (process.env.AMADEUS_PRIVATE_PATHS ?? "")
  .split(/[;\n]/).map((item) => item.trim()).filter(Boolean);
const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-(?!test|synthetic)[A-Za-z0-9_-]{20,}\b/
];
const sessionPattern = /(?:cordis|creator)[-_ ]?session(?:[-_ ]?id)?\s*[:=#]\s*["']?([0-9A-Za-z_-]{8,})/i;
const localUserPattern = new RegExp(`C:\\\\Users\\\\${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\\\|$)`, "i");

function scanText(label, text) {
  if (!text || text.length > 8_000_000) return;
  if (label.endsWith("scripts/privacy-check.mjs")) return;
  // Source files often spell Windows paths with doubled backslashes. Normalize
  // for path detection without altering the credential/session patterns.
  const pathText = text.replace(/\\\\/g, "\\").replaceAll("/", "\\");
  if (localUserPattern.test(pathText)) {
    problems.push(`local user path in ${label}`);
  }
  for (const root of privatePaths) {
    if (text.includes(root) || text.toLowerCase().includes(root.toLowerCase())) {
      problems.push(`private root in ${label}`);
      break;
    }
  }
  if (sessionPattern.test(text)) problems.push(`creator/cordis session id pattern in ${label}`);
  if (!SYNTHETIC_ALLOW.has(label) && credentialPatterns.some((rx) => rx.test(text))) {
    problems.push(`credential pattern in ${label}`);
  }
}

function walk(dir, root) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(root, full).replaceAll("\\", "/");
    if (["node_modules", ".npm-cache", ".benchmark", "dist"].includes(name)) continue;
    if (forbidden.some((rx) => rx.test(name))) {
      problems.push(`forbidden artifact: ${rel}`);
      continue;
    }
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) problems.push(`symlink not allowed in package tree: ${rel}`);
    else if (stat.isDirectory()) walk(full, root);
    else if (TEXT_EXT.has(extname(name).toLowerCase())) scanText(rel, readFileSync(full, "utf8"));
  }
}

function tarGzTextEntries(tgz) {
  const tar = gunzipSync(readFileSync(tgz));
  const out = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const start = offset + 512;
    const end = start + size;
    if ((type === "0" || type === "\0" || type === "7") && TEXT_EXT.has(extname(name).toLowerCase())) {
      out.push([name, tar.subarray(start, end).toString("utf8")]);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

walk(root, root);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (pkg.name !== "@modusensus/dsh-mneme") problems.push(`unexpected package name: ${pkg.name}`);
if (pkg.version !== "0.9.5-amadeus.1") problems.push(`unexpected package version: ${pkg.version}`);
if (pkg.amadeus?.edition !== "enhanced") problems.push("amadeus.edition must be enhanced");
for (const required of ["src/qa-guard.js", "src/backup.js", "lib/qa-guard.js", "lib/backup.js", "docs/BACKUP_ROLLBACK.md"]) {
  if (!existsSync(join(root, required))) problems.push(`missing required file: ${required}`);
}

const packageInfo = join(root, "..", "dist", "PACKAGE_INFO.json");
if (existsSync(packageInfo)) {
  const info = JSON.parse(readFileSync(packageInfo, "utf8"));
  if (info.version !== pkg.version) problems.push("PACKAGE_INFO version mismatches package.json");
  if (!/^[a-f0-9]{64}$/.test(String(info.sha256 ?? ""))) problems.push("PACKAGE_INFO sha256 invalid");
  const tgz = join(root, "..", "dist", `modusensus-dsh-mneme-${pkg.version}.tgz`);
  if (existsSync(tgz)) {
    for (const [name, text] of tarGzTextEntries(tgz)) scanText(name, text);
  }
  if (existsSync(tgz)) {
    const bytes = statSync(tgz).size;
    const sha = createHash("sha256").update(readFileSync(tgz)).digest("hex");
    if (bytes !== info.bytes) problems.push(`PACKAGE_INFO bytes mismatch: ${bytes} != ${info.bytes}`);
    if (sha !== info.sha256) problems.push(`PACKAGE_INFO sha256 mismatch: ${sha} != ${info.sha256}`);
  }
}

if (problems.length) {
  console.error("PRIVACY CHECK FAILED");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, package: pkg.name, version: pkg.version, files: "no credentials, DB, logs, symlinks or temp artifacts" }, null, 2));
}
