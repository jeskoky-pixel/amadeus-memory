// Local privacy / release hygiene check. No network, no production reads.
//
// Source/prepack mode (`--source-only`) scans the package tree but deliberately
// ignores dist/PACKAGE_INFO.json and the existing tarball. The postpack run scans
// both the source and the packed contents and verifies final metadata.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".txt", ".toml", ".ps1", ".sh", ".bat"]);
const SYNTHETIC_ALLOW = new Set([
  "test/sensitive-scan.test.js",
  "package/test/sensitive-scan.test.js",
  "test/helpers/write-admission-samples.js",
  "package/test/helpers/write-admission-samples.js"
]);
const FORBIDDEN_FILES = [
  /^\.env(?:\.|$)/,
  /\.(?:db|db-wal|db-shm|sqlite|log|secret|pem|key)$/i,
  /^id_rsa/i,
  /credentials/i,
  /^\.test-tmp$/,
  /^\.tmp-/,
  /^\.productization-task$/
];
const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-(?!test|synthetic)[A-Za-z0-9_-]{20,}\b/
];
const sessionPattern = /(?:cordis|creator)[-_ ]?session(?:[-_ ]?id)?\s*[:=#]\s*["']?([0-9A-Za-z_-]{8,})/i;

export function tarGzTextEntries(tgz) {
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

export function runPrivacyCheck({ root = process.cwd(), sourceOnly = false, distDir = join(root, "..", "dist") } = {}) {
  const problems = [];
  const username = basename(homedir());
  const privatePaths = (process.env.AMADEUS_PRIVATE_PATHS ?? "")
    .split(/[;\n]/).map((item) => item.trim()).filter(Boolean);
  const localUserPattern = new RegExp(`C:\\\\Users\\\\${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\\\|$)`, "i");

  function scanText(label, text) {
    if (!text || text.length > 8_000_000) return;
    if (label.endsWith("scripts/privacy-check.mjs")) return;
    const pathText = text.replace(/\\\\/g, "\\").replaceAll("/", "\\");
    if (localUserPattern.test(pathText)) problems.push(`local user path in ${label}`);
    for (const privateRoot of privatePaths) {
      if (text.includes(privateRoot) || text.toLowerCase().includes(privateRoot.toLowerCase())) {
        problems.push(`private root in ${label}`);
        break;
      }
    }
    if (sessionPattern.test(text)) problems.push(`creator/cordis session id pattern in ${label}`);
    if (!SYNTHETIC_ALLOW.has(label) && credentialPatterns.some((rx) => rx.test(text))) {
      problems.push(`credential pattern in ${label}`);
    }
  }

  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(root, full).replaceAll("\\", "/");
      if (["node_modules", ".npm-cache", ".benchmark", "dist"].includes(name)) continue;
      if (FORBIDDEN_FILES.some((rx) => rx.test(name))) {
        problems.push(`forbidden artifact: ${rel}`);
        continue;
      }
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) problems.push(`symlink not allowed in package tree: ${rel}`);
      else if (stat.isDirectory()) walk(full);
      else if (TEXT_EXT.has(extname(name).toLowerCase())) scanText(rel, readFileSync(full, "utf8"));
    }
  }

  walk(root);
  const pkgJson = join(root, "package.json");
  let pkg = null;
  if (existsSync(pkgJson)) {
    pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
    if (pkg.name !== "@amadeus/memory") problems.push(`unexpected package name: ${pkg.name}`);
    if (pkg.version !== "1.0.1") problems.push(`unexpected package version: ${pkg.version}`);
    if (pkg.amadeus?.edition !== "enhanced") problems.push("amadeus.edition must be enhanced");
    for (const required of ["src/qa-guard.js", "src/backup.js", "lib/qa-guard.js", "lib/backup.js", "docs/BACKUP_ROLLBACK.md"]) {
      if (!existsSync(join(root, required))) problems.push(`missing required file: ${required}`);
    }
  } else {
    problems.push("missing package.json");
  }

  if (!sourceOnly && pkg) {
    const packageInfo = join(distDir, "PACKAGE_INFO.json");
    if (existsSync(packageInfo)) {
      const info = JSON.parse(readFileSync(packageInfo, "utf8"));
      if (info.version !== pkg.version) problems.push("PACKAGE_INFO version mismatches package.json");
      if (!/^[a-f0-9]{64}$/.test(String(info.sha256 ?? ""))) problems.push("PACKAGE_INFO sha256 invalid");
      const tgz = join(distDir, `amadeus-memory-${pkg.version}.tgz`);
      if (existsSync(tgz)) {
        for (const [name, text] of tarGzTextEntries(tgz)) scanText(name, text);
        const bytes = statSync(tgz).size;
        const sha = createHash("sha256").update(readFileSync(tgz)).digest("hex");
        if (bytes !== info.bytes) problems.push(`PACKAGE_INFO bytes mismatch: ${bytes} != ${info.bytes}`);
        if (sha !== info.sha256) problems.push(`PACKAGE_INFO sha256 mismatch: ${sha} != ${info.sha256}`);
      } else {
        problems.push("PACKAGE_INFO exists but tarball is missing");
      }
    } else {
      problems.push("PACKAGE_INFO.json is missing");
    }
  }

  return { ok: problems.length === 0, problems, package: pkg };
}

async function main() {
  const sourceOnly = process.argv.includes("--source-only");
  const result = runPrivacyCheck({ sourceOnly });
  if (!result.ok) {
    console.error("PRIVACY CHECK FAILED");
    for (const problem of result.problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    mode: sourceOnly ? "source" : "package",
    package: result.package?.name,
    version: result.package?.version,
    files: "no credentials, DB, logs, symlinks or temp artifacts"
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
